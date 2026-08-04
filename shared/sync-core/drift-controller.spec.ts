import { Timeline } from '../sync-protocol';
import {
  ControllerAction,
  ControllerInput,
  DriftController,
} from './drift-controller';

const timeline = (over: Partial<Timeline> = {}): Timeline => ({
  v: 1,
  seq: 1,
  storeEpoch: 'e',
  videoId: 'vid',
  isPlaying: true,
  mediaTime: 100,
  stampedAt: 0,
  rate: 1,
  reason: 'play',
  ...over,
});

/**
 * Drive the controller along simulated time. `driftS` positive = player
 * ahead of the room timeline. Returns every action taken.
 */
function drive(
  ctrl: DriftController,
  steps: Array<Partial<ControllerInput> & { driftS?: number }>,
  startLocal = 100_000,
): ControllerAction[] {
  const actions: ControllerAction[] = [];
  let tLocal = startLocal;
  for (const step of steps) {
    tLocal += 250;
    const tl = step.timeline === undefined ? timeline() : step.timeline;
    const serverNow = tLocal; // offset 0 keeps expectations legible
    const expected = tl
      ? tl.mediaTime + (tl.isPlaying ? (serverNow - tl.stampedAt) / 1000 : 0)
      : 0;
    const input: ControllerInput = {
      tLocal,
      serverNow,
      playerTime: expected + (step.driftS ?? 0),
      playerState: step.playerState ?? 'playing',
      timeline: tl,
      fractionalRateOK: step.fractionalRateOK ?? false,
    };
    actions.push(ctrl.evaluate(input));
  }
  return actions;
}

const types = (a: ControllerAction[]): string[] => a.map((x) => x.type);

describe('DriftController — SEEK mode (default)', () => {
  it('stays quiet inside the deadband', () => {
    const ctrl = new DriftController();
    const actions = drive(ctrl, [
      { driftS: 0.05 },
      { driftS: -0.08 },
      { driftS: 0.1 },
      { driftS: 0.02 },
    ]);
    expect(types(actions)).toEqual(['none', 'none', 'none', 'none']);
  });

  it('seeks after sustained drift beyond the seek threshold, with lead', () => {
    const ctrl = new DriftController();
    const actions = drive(ctrl, [
      { driftS: 0.02 },
      { driftS: -0.5 },
      { driftS: -0.5 },
      { driftS: -0.5 },
    ]);
    const seekIdx = types(actions).indexOf('seek');
    expect(seekIdx).toBeGreaterThan(0);
    const seek = actions[seekIdx] as { type: 'seek'; toMediaTime: number };
    // target = projected + default 0.3s lead
    const expectedAt = 100 + (100_000 + 250 * (seekIdx + 1)) / 1000;
    expect(seek.toMediaTime).toBeCloseTo(expectedAt + 0.3, 1);
  });

  it('a single gross reading seeks immediately (post-sleep path)', () => {
    const ctrl = new DriftController();
    const actions = drive(ctrl, [{ driftS: 0.0 }, { driftS: -30 }]);
    expect(types(actions)[1]).toBe('seek');
  });

  it('respects the seek spacing (no seek storms)', () => {
    const ctrl = new DriftController();
    const steps = Array.from({ length: 20 }, () => ({ driftS: -3 as number }));
    const actions = drive(ctrl, steps);
    const seeks = types(actions).filter((t) => t === 'seek').length;
    // 20 evals * 250ms = 5s window; 3s spacing → at most 2 seeks
    expect(seeks).toBeLessThanOrEqual(2);
    expect(seeks).toBeGreaterThan(0);
  });

  it('tolerates drift between deadband and seek threshold without rate support', () => {
    const ctrl = new DriftController();
    const actions = drive(ctrl, [
      { driftS: 0.13 },
      { driftS: 0.13 },
      { driftS: 0.13 },
      { driftS: 0.13 },
    ]);
    expect(types(actions)).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('DriftController — RATE mode (probe-gated)', () => {
  it('nudges within the rate zone and clears on convergence', () => {
    const ctrl = new DriftController();
    const actions = drive(ctrl, [
      { driftS: 0.3, fractionalRateOK: true },
      { driftS: 0.3, fractionalRateOK: true },
      { driftS: 0.25, fractionalRateOK: true },
      { driftS: 0.15, fractionalRateOK: true },
      { driftS: 0.05, fractionalRateOK: true },
      { driftS: 0.03, fractionalRateOK: true },
    ]);
    const t = types(actions);
    const first = t.indexOf('set-rate');
    expect(first).toBeGreaterThanOrEqual(1);
    const rate = actions[first] as { type: 'set-rate'; rate: number };
    expect(rate.rate).toBeCloseTo(0.95, 9); // ahead → slow down
    expect(t).toContain('clear-rate');
  });

  it('escalates to seek when nudging is stuck', () => {
    const ctrl = new DriftController();
    // 70 evals * 250ms = 17.5s stuck at 0.4s drift > 15s stuck limit
    const steps = Array.from({ length: 70 }, () => ({
      driftS: 0.4 as number,
      fractionalRateOK: true,
    }));
    const actions = drive(ctrl, steps);
    expect(types(actions)).toContain('seek');
  });

  it('never nudges when the probe failed', () => {
    const ctrl = new DriftController();
    const steps = Array.from({ length: 10 }, () => ({
      driftS: 0.4 as number,
      fractionalRateOK: false,
    }));
    const actions = drive(ctrl, steps);
    expect(types(actions)).not.toContain('set-rate');
    expect(types(actions)).toContain('seek');
  });
});

describe('DriftController — seek-lead learning', () => {
  it('re-seeks with an adapted lead when a seek lands in the tolerated gap', () => {
    // regression: a seek that settles at ~200ms behind (deadband < |drift| <
    // seekThreshold) used to strand the controller in SEEKING forever
    const ctrl = new DriftController();
    const first = drive(ctrl, [
      { driftS: -3 },
      { driftS: -3 }, // sustained -> seek #1
    ]);
    expect(types(first)).toContain('seek');
    // seek "lands" 200ms behind and stays there through cooldown + spacing:
    // 14 evals * 250ms = 3.5s > seekSpacing
    const after = drive(
      ctrl,
      Array.from({ length: 14 }, () => ({ driftS: -0.2 as number })),
      101_000,
    );
    const seeks = after.filter((a) => a.type === 'seek');
    expect(seeks.length).toBeGreaterThan(0); // corrects instead of tolerating
    expect(ctrl.getStatus().seekLeadS).toBeGreaterThan(0.3); // lead learned
  });
});

describe('DriftController — nudge direction', () => {
  it('re-aims immediately when drift flips sign without passing the deadband', () => {
    const ctrl = new DriftController();
    // enter NUDGING while ahead -> commands a slow-down (rate < 1)
    const entering = drive(ctrl, [
      { driftS: 0.3, fractionalRateOK: true },
      { driftS: 0.3, fractionalRateOK: true },
    ]);
    const first = entering.find((a) => a.type === 'set-rate') as {
      type: 'set-rate';
      rate: number;
    };
    expect(first.rate).toBeLessThan(1);
    // a seek flips the error to 'behind' without ever entering the deadband.
    // The median-of-3 guard accepts the flip on the second sample - that is
    // noise-rejection latency, not the 15s stuck timer this regression is
    // about (before the fix, no re-aim happened until that timer fired).
    const flipped = drive(
      ctrl,
      [
        { driftS: -0.5, fractionalRateOK: true },
        { driftS: -0.5, fractionalRateOK: true },
        { driftS: -0.5, fractionalRateOK: true },
      ],
      101_000,
    );
    const reaimed = flipped.find((a) => a.type === 'set-rate') as {
      type: 'set-rate';
      rate: number;
    };
    expect(reaimed).toBeDefined();
    expect(reaimed.rate).toBeGreaterThan(1); // now speeding up, not slowing
  });
});

describe('DriftController — suspend hygiene', () => {
  it('suspend clears applied-rate state so a resumed controller cannot leak it', () => {
    const ctrl = new DriftController();
    const entering = drive(ctrl, [
      { driftS: 0.3, fractionalRateOK: true },
      { driftS: 0.3, fractionalRateOK: true },
    ]);
    expect(types(entering)).toContain('set-rate');
    ctrl.suspend();
    ctrl.resume();
    // the executor restored rate 1 on suspend; a later buffering event must
    // NOT emit a stale clear-rate, which would prove leftover state
    const buffering = drive(
      ctrl,
      [{ driftS: 0, playerState: 'buffering' }],
      102_000,
    );
    expect(types(buffering)).toEqual(['none']);
  });
});

describe('DriftController — lifecycle', () => {
  it('suspends corrections while buffering and clears any applied rate', () => {
    const ctrl = new DriftController();
    const warmup = drive(ctrl, [
      { driftS: 0.3, fractionalRateOK: true },
      { driftS: 0.3, fractionalRateOK: true },
    ]);
    expect(types(warmup)).toContain('set-rate');
    const actions = drive(
      ctrl,
      [
        { driftS: 0.3, playerState: 'buffering', fractionalRateOK: true },
        { driftS: 0.3, playerState: 'buffering', fractionalRateOK: true },
      ],
      101_000,
    );
    expect(types(actions)[0]).toBe('clear-rate');
    expect(types(actions)[1]).toBe('none');
  });

  it('catches up after buffering ends (P2 free-run policy)', () => {
    const ctrl = new DriftController();
    drive(ctrl, [{ driftS: 0, playerState: 'buffering' }]);
    const actions = drive(
      ctrl,
      // 1s behind: ABOVE seekThresholdS but BELOW instantSeekS, so only the
      // wasBuffering waiver can produce a seek on the first eval (with -4s
      // the instant path fired and the test passed even without the waiver)
      [{ driftS: -1 }],
      110_000,
    );
    expect(types(actions)[0]).toBe('seek');
  });

  it('pauses the player when the room pauses, then reconciles position', () => {
    const ctrl = new DriftController();
    const paused = timeline({ isPlaying: false, mediaTime: 100 });
    const a1 = drive(ctrl, [{ timeline: paused, playerState: 'playing' }]);
    expect(types(a1)).toEqual(['pause']);
    const a2 = drive(
      ctrl,
      [{ timeline: paused, playerState: 'paused', driftS: 0 }],
      200_000,
    );
    // playerTime = projected(=100) + 0 → within reconcile band → no seek
    expect(types(a2)).toEqual(['none']);
  });

  it('silently reconciles a paused player that is off-position', () => {
    const ctrl = new DriftController();
    const paused = timeline({ isPlaying: false, mediaTime: 100 });
    const tLocal = 300_000;
    const input: ControllerInput = {
      tLocal,
      serverNow: tLocal,
      playerTime: 103, // 3s off while paused
      playerState: 'paused',
      timeline: paused,
      fractionalRateOK: false,
    };
    const action = ctrl.evaluate(input);
    expect(action).toEqual({ type: 'seek', toMediaTime: 100 });
  });

  it('starts a paused player when the room is playing, as a correction', () => {
    const ctrl = new DriftController();
    const a = drive(ctrl, [{ playerState: 'paused', driftS: 0 }]);
    expect(types(a)).toEqual(['play']);
    // the start enters SEEKING so its landing error is corrected
    expect(ctrl.getStatus().state).toBe('SEEKING');
  });

  it('a play-start does not poison the seek-lead learner', () => {
    // a joiner starts minutes away from the room position; that gross error
    // is NOT a seek settle residual and must not move the lead EMA
    const ctrl = new DriftController();
    const leadBefore = ctrl.getStatus().seekLeadS;
    drive(ctrl, [{ playerState: 'paused', driftS: -300 }]);
    drive(
      ctrl,
      [{ driftS: 0.0 }, { driftS: 0.0 }, { driftS: 0.0 }, { driftS: 0.0 }],
      120_000,
    );
    expect(ctrl.getStatus().seekLeadS).toBeCloseTo(leadBefore, 9);
  });

  it('does nothing while suspended and acts fast after resume', () => {
    const ctrl = new DriftController();
    ctrl.suspend();
    const quiet = drive(ctrl, [{ driftS: -5 }]);
    expect(types(quiet)).toEqual(['none']);
    ctrl.resume();
    const active = drive(ctrl, [{ driftS: -0.5 }], 400_000);
    expect(types(active)).toEqual(['seek']); // hysteresis dropped on resume
  });
});
