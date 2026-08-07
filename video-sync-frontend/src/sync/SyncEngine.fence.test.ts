import { SyncEngine, sendSetVideo } from './SyncEngine';
import { SYNC_EVENTS, Timeline } from '../shared/sync-protocol';

/**
 * The client half of the video fence (formal/SyncSetVideo.tla): every
 * position command carries the videoId this client had APPLIED when the
 * gesture happened, so a command aimed at the old video dies at the store
 * instead of moving the new one.
 */

let uuidCounter = 0;
beforeAll(() => {
  // jsdom ships no crypto global at all
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (!g.crypto) g.crypto = {};
  if (!g.crypto.randomUUID) {
    g.crypto.randomUUID = () => `test-uuid-${uuidCounter++}`;
  }
});

interface FakeSocket {
  connected: boolean;
  emit: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
}

const makeSocket = (): { socket: FakeSocket; handlers: Map<string, Function> } => {
  const handlers = new Map<string, Function>();
  const socket: FakeSocket = {
    connected: true,
    emit: jest.fn(),
    on: jest.fn((event: string, cb: Function) => handlers.set(event, cb)),
    off: jest.fn(),
  };
  return { socket, handlers };
};

const timeline = (videoId: string | null, seq: number): Timeline => ({
  v: 1,
  seq,
  storeEpoch: '1000',
  videoId,
  isPlaying: false,
  mediaTime: 0,
  stampedAt: 1000,
  rate: 1,
  reason: 'join',
});

const controlsSent = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.emit.mock.calls
    .filter(([event]) => event === SYNC_EVENTS.control)
    .map(([, payload]) => payload as Record<string, unknown>);

describe('SyncEngine video fence', () => {
  let engine: SyncEngine | null = null;
  afterEach(() => {
    engine?.dispose();
    engine = null;
  });

  it('a command before the first timeline is unfenced (wire compat)', () => {
    const { socket } = makeSocket();
    engine = new SyncEngine(socket as never, 'ROOM01');
    engine.start();
    engine.sendIntent('play', 5);
    const [cmd] = controlsSent(socket);
    expect(cmd.intent).toBe('play');
    expect('forVideoId' in cmd).toBe(false);
  });

  it('a command after a timeline carries the applied videoId as its fence', () => {
    const { socket, handlers } = makeSocket();
    engine = new SyncEngine(socket as never, 'ROOM01');
    engine.start();
    handlers.get(SYNC_EVENTS.timeline)!(timeline('vid-A', 1));
    engine.sendIntent('seek', 37);
    const [cmd] = controlsSent(socket);
    expect(cmd.forVideoId).toBe('vid-A');

    // a set-video broadcast moves the fence with it
    handlers.get(SYNC_EVENTS.timeline)!({
      ...timeline('vid-B', 2),
      reason: 'set-video',
    });
    engine.sendIntent('pause', 0);
    expect(controlsSent(socket)[1].forVideoId).toBe('vid-B');
  });

  it('sendSetVideo emits the switch and never buffers while disconnected', () => {
    const { socket } = makeSocket();
    expect(
      sendSetVideo(socket as never, 'ROOM01', 'https://vimeo.com/76979871'),
    ).toBe(true);
    const [cmd] = controlsSent(socket);
    expect(cmd.intent).toBe('set-video');
    expect(cmd.videoUrl).toBe('https://vimeo.com/76979871');
    expect(cmd.mediaTime).toBe(0);
    expect(typeof cmd.cmdId).toBe('string');
    // set-video is deliberately unfenced: switching is last-writer-wins
    expect('forVideoId' in cmd).toBe(false);

    socket.connected = false;
    expect(sendSetVideo(socket as never, 'ROOM01', 'x')).toBe(false);
    expect(controlsSent(socket)).toHaveLength(1);
  });
});
