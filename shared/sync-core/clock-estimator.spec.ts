import { ClockEstimator, ClockSample } from './clock-estimator';

/**
 * Build one exchange against a server whose clock leads the client by
 * `offset` ms, with one-way delays upMs (client→server) and downMs.
 */
function exchange(
  t0: number,
  offset: number,
  upMs: number,
  downMs: number,
  serverProcMs = 0,
): ClockSample {
  const t1 = t0 + upMs + offset;
  const t2 = t1 + serverProcMs;
  const t3 = t2 - offset + downMs;
  return { t0, t1, t2, t3 };
}

describe('ClockEstimator', () => {
  it('recovers the exact offset on a symmetric path', () => {
    const est = new ClockEstimator();
    let t = 1_000;
    for (let i = 0; i < 8; i++) {
      est.addSample(exchange(t, 250, 40, 40));
      t += 150;
    }
    expect(est.getEstimate().offsetMs).toBeCloseTo(250, 5);
    // uncertainty = δ_min/2 = (40+40)/2 = 40
    expect(est.getEstimate().uncertaintyMs).toBeCloseTo(40, 5);
  });

  it('bias on an asymmetric path is bounded by half the asymmetry', () => {
    const est = new ClockEstimator();
    let t = 1_000;
    for (let i = 0; i < 8; i++) {
      est.addSample(exchange(t, 250, 120, 20)); // 100ms asymmetry
      t += 150;
    }
    const { offsetMs } = est.getEstimate();
    // θ = offset + (up-down)/2 = 250 + 50
    expect(offsetMs).toBeCloseTo(300, 5);
    expect(Math.abs(offsetMs - 250)).toBeLessThanOrEqual(50 + 1e-9);
  });

  it('min-RTT selection rejects delay spikes', () => {
    const est = new ClockEstimator();
    let t = 1_000;
    for (let i = 0; i < 6; i++) {
      est.addSample(exchange(t, 250, 20, 20));
      t += 150;
    }
    // burst of congested samples with wild asymmetric delays
    for (let i = 0; i < 3; i++) {
      est.addSample(exchange(t, 250, 900, 30));
      t += 150;
    }
    expect(est.getEstimate().offsetMs).toBeCloseTo(250, 3);
  });

  it('discards non-causal samples (negative rtt)', () => {
    const est = new ClockEstimator();
    // t3-t0 = 30ms but the server claims 50ms of processing: δ = -20
    expect(est.addSample({ t0: 1000, t1: 1240, t2: 1290, t3: 1030 })).toBe(
      false,
    );
    expect(est.hasEstimate()).toBe(false);
  });

  it('small corrections slew instead of stepping', () => {
    const est = new ClockEstimator();
    let t = 1_000;
    for (let i = 0; i < 8; i++) {
      est.addSample(exchange(t, 250, 30, 30));
      t += 150;
    }
    est.tick(t);
    // nudge the true offset by 10ms — below the 20ms step threshold
    for (let i = 0; i < 8; i++) {
      est.addSample(exchange(t, 260, 30, 30));
      t += 150;
    }
    const before = est.getEstimate().offsetMs;
    expect(before).toBeLessThan(260); // not stepped
    // 2 simulated seconds of ticking at 4Hz: slew limit 5ms/s → ≤10ms travel
    for (let i = 0; i < 8; i++) {
      t += 250;
      est.tick(t);
    }
    const after = est.getEstimate().offsetMs;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(260 + 1e-9);
  });

  it('large corrections step immediately', () => {
    const est = new ClockEstimator();
    let t = 1_000;
    for (let i = 0; i < 8; i++) {
      est.addSample(exchange(t, 250, 30, 30));
      t += 150;
    }
    // clock jumped 500ms (e.g. host NTP step)
    for (let i = 0; i < 8; i++) {
      est.addSample(exchange(t, 750, 30, 30));
      t += 150;
    }
    expect(est.getEstimate().offsetMs).toBeCloseTo(750, 3);
  });

  it('serverNow maps local time through the applied offset', () => {
    const est = new ClockEstimator();
    est.addSample(exchange(1000, 250, 30, 30));
    expect(est.serverNow(5000)).toBeCloseTo(5250, 5);
  });

  it('reset clears history for reconnect re-burst', () => {
    const est = new ClockEstimator();
    est.addSample(exchange(1000, 250, 30, 30));
    est.reset();
    expect(est.hasEstimate()).toBe(false);
    expect(est.getEstimate().sampleCount).toBe(0);
  });
});
