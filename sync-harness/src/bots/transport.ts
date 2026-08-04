// Transport abstraction: the SAME bot (estimator + controller + SimPlayer)
// speaks either plane. SocketIO/JSON against the Node backend, raw-WS
// binary frames against relay-go - cross-language protocol conformance is
// exactly "the identical suite passes on both".
import { io, type Socket } from 'socket.io-client';
import WebSocket from 'ws';
import type { ClockPong, ControlIntent, Timeline } from '../../../shared/sync-protocol';
import { SYNC_EVENTS } from '../../../shared/sync-protocol';

export interface SyncTransport {
  connect(token: string): Promise<void>;
  join(roomCode: string, userId: string): Promise<Timeline | null>;
  sendClock(t0: number, onPong: (pong: ClockPong) => void): void;
  sendControl(roomCode: string, intent: ControlIntent, mediaTime: number): void;
  onTimeline(cb: (tl: Timeline) => void): void;
  onRejected(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  connected(): boolean;
  disconnect(): void;
}

export class SocketIOTransport implements SyncTransport {
  private socket: Socket | null = null;
  // Handlers may be registered before connect() (the bots do exactly that);
  // buffer them rather than touching a socket that does not exist yet - the
  // raw-WS transport tolerated the order, this one did not, and that
  // inconsistency is precisely what a transport abstraction must not have.
  private pending: Array<(s: Socket) => void> = [];
  constructor(private url: string) {}

  private withSocket(fn: (s: Socket) => void): void {
    if (this.socket) fn(this.socket);
    else this.pending.push(fn);
  }

  connect(token: string): Promise<void> {
    this.socket = io(this.url, {
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
    });
    const socket = this.socket;
    this.pending.forEach((fn) => fn(socket));
    this.pending = [];
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 10_000);
      socket.on('connect', () => {
        clearTimeout(t);
        resolve();
      });
      socket.on('connect_error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  join(roomCode: string, userId: string): Promise<Timeline | null> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('join before connect'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('join timeout')), 10_000);
      socket.once('room-joined', (p: { timeline?: Timeline }) => {
        clearTimeout(t);
        resolve(p.timeline ?? null);
      });
      socket.emit('join-room', { roomCode, userId });
    });
  }

  sendClock(t0: number, onPong: (pong: ClockPong) => void): void {
    this.socket?.emit(SYNC_EVENTS.clock, { t0 }, onPong);
  }

  sendControl(roomCode: string, intent: ControlIntent, mediaTime: number): void {
    this.socket?.emit(SYNC_EVENTS.control, { v: 1, roomCode, intent, mediaTime });
  }

  onTimeline(cb: (tl: Timeline) => void): void {
    this.withSocket((s) => s.on(SYNC_EVENTS.timeline, cb));
  }

  onRejected(cb: () => void): void {
    this.withSocket((s) => s.on(SYNC_EVENTS.controlRejected, cb));
  }

  onError(cb: (err: string) => void): void {
    this.withSocket((s) => s.on('error', (e: unknown) => cb(JSON.stringify(e))));
  }

  connected(): boolean {
    return this.socket?.connected ?? false;
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}

// ---- binary codec matching relay-go/main.go exactly ----
const INTENTS: ControlIntent[] = ['play', 'pause', 'seek'];
const REASONS = ['play', 'pause', 'seek', 'join', 'snapshot', 'succession'] as const;

function decodeTimeline(buf: Buffer): Timeline {
  return {
    v: 1,
    seq: buf.readUInt32LE(1),
    storeEpoch: String(buf.readDoubleLE(5)),
    videoId: null,
    isPlaying: buf.readUInt8(13) === 1,
    mediaTime: buf.readDoubleLE(14),
    stampedAt: buf.readDoubleLE(22),
    rate: 1,
    reason: REASONS[buf.readUInt8(30)] ?? 'snapshot',
  };
}

export class RawWSBinaryTransport implements SyncTransport {
  private ws!: WebSocket;
  private timelineCb: ((tl: Timeline) => void) | null = null;
  private rejectedCb: (() => void) | null = null;
  private errorCb: ((err: string) => void) | null = null;
  /** keyed by the echoed t0: FIFO matching mis-attributes a late reply to
   * the NEXT ping, shifting every subsequent RTT in a benchmark */
  private pendingPongs = new Map<number, (p: ClockPong) => void>();
  private pendingJoin: ((tl: Timeline | null) => void) | null = null;
  private isConnected = false;
  private token = '';
  private reconnecting = false;
  private disposed = false;

  constructor(private url: string) {}

  connect(token: string): Promise<void> {
    this.token = token;
    return this.open();
  }

  /** Reconnect like the Socket.IO arm does; without it a single drop
   * silently removed a bot from the relay measurement and flattered it. */
  private reconnect(): void {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      void this.open().catch(() => this.reconnect());
    }, 1000);
  }

  private open(): Promise<void> {
    const token = this.token;
    this.ws = new WebSocket(`${this.url}/sync?token=${encodeURIComponent(token)}`);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (data: Buffer) => this.onFrame(data));
    this.ws.on('error', (e) => this.errorCb?.(String(e)));
    this.ws.on('close', () => {
      this.isConnected = false;
      this.pendingPongs.clear();
      this.reconnect();
    });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws connect timeout')), 10_000);
      this.ws.once('open', () => {
        clearTimeout(t);
        this.isConnected = true;
        resolve();
      });
      this.ws.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  private onFrame(buf: Buffer): void {
    if (buf.length < 1) return;
    switch (buf.readUInt8(0)) {
      case 0x02: {
        // ClockPong [t0][t1][t2] - matched by the echoed t0
        const t0 = buf.readDoubleLE(1);
        const cb = this.pendingPongs.get(t0);
        if (cb) {
          this.pendingPongs.delete(t0);
          cb({ t0, t1: buf.readDoubleLE(9), t2: buf.readDoubleLE(17) });
        }
        break;
      }
      case 0x04:
        this.timelineCb?.(decodeTimeline(buf));
        break;
      case 0x06:
        this.pendingJoin?.(decodeTimeline(buf));
        this.pendingJoin = null;
        break;
      case 0x07:
        this.rejectedCb?.();
        break;
    }
  }

  join(roomCode: string): Promise<Timeline | null> {
    const room = Buffer.from(roomCode, 'utf8');
    const frame = Buffer.alloc(2 + room.length);
    frame.writeUInt8(0x05, 0);
    frame.writeUInt8(room.length, 1);
    room.copy(frame, 2);
    this.ws.send(frame);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('join timeout')), 10_000);
      this.pendingJoin = (tl) => {
        clearTimeout(t);
        resolve(tl);
      };
    });
  }

  sendClock(t0: number, onPong: (pong: ClockPong) => void): void {
    const frame = Buffer.alloc(9);
    frame.writeUInt8(0x01, 0);
    frame.writeDoubleLE(t0, 1);
    this.pendingPongs.set(t0, onPong);
    this.ws.send(frame);
  }

  sendControl(roomCode: string, intent: ControlIntent, mediaTime: number): void {
    const room = Buffer.from(roomCode, 'utf8');
    const frame = Buffer.alloc(11 + room.length);
    frame.writeUInt8(0x03, 0);
    frame.writeUInt8(INTENTS.indexOf(intent), 1);
    frame.writeDoubleLE(mediaTime, 2);
    frame.writeUInt8(room.length, 10);
    room.copy(frame, 11);
    this.ws.send(frame);
  }

  onTimeline(cb: (tl: Timeline) => void): void {
    this.timelineCb = cb;
  }

  onRejected(cb: () => void): void {
    this.rejectedCb = cb;
  }

  onError(cb: (err: string) => void): void {
    this.errorCb = cb; // connect() attaches the ws listener that calls it
  }

  connected(): boolean {
    return this.isConnected;
  }

  disconnect(): void {
    this.disposed = true;
    this.ws?.close();
  }
}
