import { Timeline } from '../sync-protocol';
import { DisciplineController } from './discipline-controller';
import type { ControllerAction } from './drift-controller';

const timeline = (): Timeline => ({
  v: 1,
  seq: 1,
  storeEpoch: '1000',
  videoId: 'vid',
  isPlaying: true,
  mediaTime: 100,
  stampedAt: 0,
  rate: 1,
  reason: 'play',
});

/**
 * Closed-loop plant simulation: the player advances at
 * rate_applied * (1 + skew); drift integrates the mismatch against the
 * timeline. The controller's commands feed back into the plant - this is
 * the loop the SimPlayer bots run, distilled.
 */
function simulate(
  ctrl: DisciplineController,
  skew: number,
  seconds: number,
  initialDriftS = 0,
): {
  drifts: number[];
  actions: ControllerAction[];
  seeks: number;
  rateCommands: number;
} {
  const tl = timeline();
  let drift = initialDriftS;
  let applied = 1;
  let tLocal = 100_000;
  const drifts: number[] = [];
  const actions: ControllerAction[] = [];
  let seeks = 0;
  let rateCommands = 0;
  const steps = Math.round((seconds * 1000) / 250);
  for (let i = 0; i < steps; i++) {
    tLocal += 250;
    drift += 0.25 * (applied * (1 + skew) - 1);
    const serverNow = tLocal;
    const expected = tl.mediaTime + (serverNow - tl.stampedAt) / 1000;
    const action = ctrl.evaluate({
      tLocal,
      serverNow,
      playerTime: expected + drift,
      playerState: 'playing',
      timeline: tl,
      fractionalRateOK: true,
    });
    actions.push(action);
    if (action.type === 'set-rate') {
      applied = action.rate;
      ctrl.onRateApplied(applied);
      rateCommands += 1;
    } else if (action.type === 'clear-rate') {
      applied = 1;
      ctrl.onRateApplied(1);
    } else if (action.type === 'seek') {
      drift = 0.02; // seek lands near target
      applied = 1;
      seeks += 1;
    }
    drifts.push(drift);
  }
  return { drifts, actions, seeks, rateCommands };
}

describe('DisciplineController (predictive servo)', () => {
  it('cancels a +500ppm player skew without any seeks', () => {
    const ctrl = new DisciplineController();
    const { drifts, seeks } = simulate(ctrl, 500e-6, 120);
    const tail = drifts.slice(-40); // final 10s
    expect(seeks).toBe(0);
    expect(Math.max(...tail.map(Math.abs))).toBeLessThan(0.03);
    // the feed-forward learned the skew
    expect(Math.abs(ctrl.getStatus().bHatPpm - 500)).toBeLessThan(200);
  });

  it('closes a 400ms initial error smoothly inside the servo zone', () => {
    const ctrl = new DisciplineController();
    const { drifts, seeks } = simulate(ctrl, 0, 60, 0.4);
    expect(seeks).toBe(0); // rate-corrected, never a visible jump
    expect(Math.abs(drifts[drifts.length - 1])).toBeLessThan(0.03);
    // monotone-ish approach: no overshoot beyond 100ms the other way
    expect(Math.min(...drifts)).toBeGreaterThan(-0.1);
  });

  it('does not limit-cycle at steady state (command hysteresis)', () => {
    const ctrl = new DisciplineController();
    const { actions } = simulate(ctrl, 100e-6, 120);
    const lastQuarter = actions.slice(-120); // final 30s
    const rateChanges = lastQuarter.filter((a) => a.type === 'set-rate').length;
    expect(rateChanges).toBeLessThan(8); // sub-0.5% wiggles are not commanded
  });

  it('hands gross errors to the reactive seek path and recovers', () => {
    const ctrl = new DisciplineController();
    const { seeks, drifts } = simulate(ctrl, 0, 60, 5); // 5s off: way past servo zone
    expect(seeks).toBeGreaterThan(0);
    expect(Math.abs(drifts[drifts.length - 1])).toBeLessThan(0.05);
  });

  it('a commanded pause clears the rate and stands the servo down', () => {
    const ctrl = new DisciplineController();
    simulate(ctrl, 200e-6, 30);
    const tl = { ...timeline(), isPlaying: false, mediaTime: 130 };
    const action = ctrl.evaluate({
      tLocal: 200_000,
      serverNow: 200_000,
      playerTime: 130,
      playerState: 'playing',
      timeline: tl,
      fractionalRateOK: true,
    });
    expect(action.type).toBe('pause');
  });
});
