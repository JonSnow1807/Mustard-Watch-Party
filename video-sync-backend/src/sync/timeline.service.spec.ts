import { InMemoryRoomStateStore } from './room-state.store';
import { TimelineService } from './timeline.service';

const roomRow = {
  creatorId: 'creator',
  allowGuestControl: false,
  videoUrl: 'vid',
  currentTime: 42,
};

function makeService(): {
  svc: TimelineService;
  db: { room: { update: jest.Mock } };
} {
  const db = { room: { update: jest.fn().mockResolvedValue({}) } };
  const svc = new TimelineService(new InMemoryRoomStateStore(), db as never);
  return { svc, db };
}

describe('TimelineService', () => {
  it('hydrates paused from persistence (P5), first writer wins', async () => {
    const { svc } = makeService();
    const tl = await svc.ensureRoom('r1', roomRow, 1_000);
    expect(tl.isPlaying).toBe(false);
    expect(tl.mediaTime).toBe(42);
    expect(tl.seq).toBe(0);
    const again = await svc.ensureRoom(
      'r1',
      { ...roomRow, currentTime: 99 },
      2_000,
    );
    expect(again.mediaTime).toBe(42); // not re-hydrated
  });

  it('restamps controls with monotonically increasing seq', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    const a = await svc.handleControl('r1', 's1', 'creator', 'play', 42, 5_000);
    const b = await svc.handleControl(
      'r1',
      's1',
      'creator',
      'seek',
      100,
      6_000,
    );
    if (!a.ok || !b.ok || !a.timeline || !b.timeline) {
      throw new Error('controls rejected or forwarded');
    }
    expect(a.timeline.seq).toBe(1);
    expect(b.timeline.seq).toBe(2);
    expect(b.timeline.mediaTime).toBe(100);
    expect(b.timeline.isPlaying).toBe(true); // seek preserves playing
  });

  it('rejects non-controllers; forged identity cannot control', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    // "mallory" claims to be controlling — identity comes from socket.data
    // server-side, so the check sees the real user id
    const result = await svc.handleControl(
      'r1',
      's2',
      'mallory',
      'play',
      0,
      5_000,
    );
    expect(result).toEqual({ ok: false, reason: 'not-controller' });
  });

  it('allowGuestControl opens control to everyone', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r2', { ...roomRow, allowGuestControl: true }, 1_000);
    const result = await svc.handleControl(
      'r2',
      's3',
      'guest',
      'pause',
      10,
      5_000,
    );
    expect(result.ok).toBe(true);
  });

  it('rate-limits control floods per socket (5/s, burst 10)', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 15; i++) {
      const r = await svc.handleControl(
        'r1',
        's1',
        'creator',
        'play',
        0,
        5_000,
      );
      if (r.ok) accepted += 1;
      else if (r.reason === 'rate-limited') limited += 1;
    }
    expect(accepted).toBe(10); // burst capacity
    expect(limited).toBe(5);
    // a second later one token has refilled... five tokens after 1s
    const later = await svc.handleControl(
      'r1',
      's1',
      'creator',
      'play',
      0,
      6_000,
    );
    expect(later.ok).toBe(true);
  });

  it('sweeps only playing rooms and re-anchors the projection', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    expect(await svc.sweepSnapshot('r1', 10_000)).toBeNull(); // paused
    await svc.handleControl('r1', 's1', 'creator', 'play', 100, 10_000);
    const snap = await svc.sweepSnapshot('r1', 20_000);
    expect(snap).not.toBeNull();
    expect(snap!.mediaTime).toBeCloseTo(110, 9);
    expect(snap!.stampedAt).toBe(20_000);
    expect(snap!.reason).toBe('snapshot');
  });

  it('P3: promotes the longest-connected participant when the controller leaves', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    const change = svc.succession('r1', 'creator', 'oldtimer');
    expect(change).toEqual({ controllerId: 'oldtimer', reason: 'succession' });
    // promoted controller can now control
    const r = await svc.handleControl('r1', 's4', 'oldtimer', 'play', 0, 5_000);
    expect(r.ok).toBe(true);
  });

  it('P3: creator reclaims on return', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    svc.succession('r1', 'creator', 'oldtimer');
    const reclaim = svc.reclaim('r1', 'creator');
    expect(reclaim).toEqual({ controllerId: 'creator', reason: 'reclaim' });
    const r = await svc.handleControl('r1', 's5', 'oldtimer', 'play', 0, 6_000);
    expect(r).toEqual({ ok: false, reason: 'not-controller' });
  });

  it('no succession needed when guests can control', async () => {
    const { svc } = makeService();
    await svc.ensureRoom('r3', { ...roomRow, allowGuestControl: true }, 1_000);
    expect(svc.succession('r3', 'creator', 'someone')).toBeNull();
  });

  it('persists the projected position on release', async () => {
    const { svc, db } = makeService();
    await svc.ensureRoom('r1', roomRow, 1_000);
    await svc.handleControl('r1', 's1', 'creator', 'play', 100, 10_000);
    await svc.releaseRoom('r1');
    expect(db.room.update).toHaveBeenCalledTimes(1);
    const calls = db.room.update.mock.calls as unknown as Array<
      [
        {
          where: { code: string };
          data: { isPlaying: boolean; currentTime: number };
        },
      ]
    >;
    const arg = calls[0][0];
    expect(arg.where).toEqual({ code: 'r1' });
    expect(arg.data.isPlaying).toBe(true);
    expect(arg.data.currentTime).toBeGreaterThan(100);
  });
});
