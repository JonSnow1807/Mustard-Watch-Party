// NTP-style clock-offset estimator over the sync:clock exchange.
//
// Per exchange: client stamps t0 on send and t3 on receipt; the server's ack
// carries t1 (receive) and t2 (send), all in its own clock domain.
//
//   offset θ = ((t1 - t0) + (t2 - t3)) / 2      (server − client)
//   rtt    δ = (t3 - t0) - (t2 - t1)
//
// |θ_true − θ| ≤ δ/2 + |path asymmetry|/2. The asymmetry term is irreducible
// for any NTP-family scheme — scenario S6 exists to demonstrate it honestly.
//
// Estimation: keep a ring of samples, select the K lowest-δ samples within a
// recency window (min-RTT filtering tightens the δ/2 bound), use their median
// θ (kills single-sample jumpiness). Apply small corrections as a slew so the
// drift controller never sees the clock step under it; large corrections step
// immediately and the controller re-evaluates.
//
// Deterministic: no Date.now() inside — callers pass local timestamps.

export interface ClockSample {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
}

export interface ClockEstimate {
  /** currently applied offset (server − client), ms */
  offsetMs: number;
  /** raw target from the sample set, ms */
  targetOffsetMs: number;
  /** δ_min/2 over the selected samples, ms; Infinity until a sample lands */
  uncertaintyMs: number;
  /** most recent rtt observation, ms */
  lastRttMs: number;
  sampleCount: number;
}

export interface ClockTuning {
  ringSize: number;
  /** samples older than this are ignored for selection (bounds skew error) */
  windowMs: number;
  /** how many lowest-δ samples the median is taken over */
  bestK: number;
  /** |Δθ| below this slews instead of stepping */
  slewThresholdMs: number;
  /** slew rate limit, ms of correction per second of local time */
  slewRatePerS: number;
}

export const DEFAULT_CLOCK_TUNING: ClockTuning = {
  ringSize: 64,
  windowMs: 60_000,
  bestK: 5,
  slewThresholdMs: 20,
  slewRatePerS: 5,
};

interface StoredSample {
  theta: number;
  delta: number;
  t3: number;
}

export class ClockEstimator {
  private samples: StoredSample[] = [];
  private applied: number | null = null;
  private target = 0;
  private uncertainty = Infinity;
  private lastRtt = NaN;
  private lastTick: number | null = null;

  constructor(private tuning: ClockTuning = DEFAULT_CLOCK_TUNING) {}

  /** Feed one completed exchange. Returns true if the sample was usable. */
  addSample(s: ClockSample): boolean {
    const delta = s.t3 - s.t0 - (s.t2 - s.t1);
    if (delta < 0) return false; // non-causal: clock stepped mid-exchange
    const theta = (s.t1 - s.t0 + (s.t2 - s.t3)) / 2;
    this.samples.push({ theta, delta, t3: s.t3 });
    if (this.samples.length > this.tuning.ringSize) {
      this.samples.splice(0, this.samples.length - this.tuning.ringSize);
    }
    this.lastRtt = delta;
    this.recompute(s.t3);
    return true;
  }

  private recompute(nowLocal: number): void {
    const recent = this.samples.filter(
      (x) => nowLocal - x.t3 <= this.tuning.windowMs,
    );
    if (recent.length === 0) return;
    // lowest δ first; among equal-quality samples prefer the newest, so a
    // genuine server-clock change wins over stale history within the window
    const best = [...recent]
      .sort((a, b) => a.delta - b.delta || b.t3 - a.t3)
      .slice(0, this.tuning.bestK);
    const thetas = best.map((x) => x.theta).sort((a, b) => a - b);
    const median = thetas[Math.floor(thetas.length / 2)];
    this.target = median;
    this.uncertainty = best[0].delta / 2;

    if (this.applied === null) {
      // first estimate: step, there is nothing to disturb yet
      this.applied = this.target;
    } else if (
      Math.abs(this.target - this.applied) >= this.tuning.slewThresholdMs
    ) {
      this.applied = this.target;
    }
    // otherwise tick() slews toward target
  }

  /** Advance the slew; call at the controller cadence with local ms time. */
  tick(nowLocal: number): void {
    if (this.applied === null) return;
    if (this.lastTick !== null) {
      const dtS = (nowLocal - this.lastTick) / 1000;
      const maxStep = this.tuning.slewRatePerS * dtS;
      const diff = this.target - this.applied;
      if (Math.abs(diff) <= maxStep) this.applied = this.target;
      else this.applied += Math.sign(diff) * maxStep;
    }
    this.lastTick = nowLocal;
  }

  /** Map a local timestamp into the server clock domain. */
  serverNow(nowLocal: number): number {
    return nowLocal + (this.applied ?? 0);
  }

  hasEstimate(): boolean {
    return this.applied !== null;
  }

  getEstimate(): ClockEstimate {
    return {
      offsetMs: this.applied ?? 0,
      targetOffsetMs: this.target,
      uncertaintyMs: this.uncertainty,
      lastRttMs: this.lastRtt,
      sampleCount: this.samples.length,
    };
  }

  /** Drop history (reconnect, visibility restore): re-burst follows. */
  reset(): void {
    this.samples = [];
    this.applied = null;
    this.target = 0;
    this.uncertainty = Infinity;
    this.lastRtt = NaN;
    this.lastTick = null;
  }
}
