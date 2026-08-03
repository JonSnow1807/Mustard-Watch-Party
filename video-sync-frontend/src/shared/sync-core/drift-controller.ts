// GENERATED FILE — do not edit here.
// Canonical source: /shared/. Regenerate: node scripts/sync-shared.mjs
// Drift-correction state machine. SEEK-first by design: the YouTube IFrame
// API rounds unsupported playbackRate values toward 1 (per its reference),
// so fractional-rate nudging is an opportunistic enhancement enabled per
// video by a runtime probe (fractionalRateOK) — not the primary path.
//
// Pure and deterministic: evaluate() receives everything it needs and
// returns an action; the engine (browser or SimPlayer bot) executes it.
// All thresholds are named tuning constants, tuned against committed
// measurement runs — never adjectives.

import { Timeline } from '../sync-protocol';
import { projectMediaTime } from './timeline';

export type PlayerLifecycle =
  | 'unstarted'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'cued';

export interface ControllerInput {
  /** local ms clock (performance-independent, same domain as estimator t0/t3) */
  tLocal: number;
  /** estimator-mapped server-domain time for tLocal */
  serverNow: number;
  /** de-quantized playhead seconds (edge-reconstructed by the adapter) */
  playerTime: number;
  playerState: PlayerLifecycle;
  timeline: Timeline | null;
  /** result of the per-video setPlaybackRate probe */
  fractionalRateOK: boolean;
}

export type ControllerAction =
  | { type: 'none' }
  | { type: 'seek'; toMediaTime: number }
  | { type: 'set-rate'; rate: number }
  | { type: 'clear-rate' }
  | { type: 'play' }
  | { type: 'pause' };

export type ControllerState =
  | 'LOCKED'
  | 'NUDGING'
  | 'SEEKING'
  | 'BUFFERING'
  | 'PAUSED_SYNC'
  | 'SUSPENDED';

export interface ControllerTuning {
  /** |drift| below this is noise, not error (floored at 2× measured noise σ) */
  deadbandS: number;
  /** SEEK mode: correct when |drift| exceeds this for `sustainEvals` evals */
  seekThresholdS: number;
  sustainEvals: number;
  /** single-reading drift beyond this seeks immediately (post-sleep etc.) */
  instantSeekS: number;
  /** minimum spacing between corrective seeks, ms */
  seekSpacingMs: number;
  /** post-seek cooldown before drift is trusted again, ms */
  seekCooldownMs: number;
  /** stable in-band evals required to re-LOCK after a seek */
  postSeekStableEvals: number;
  /** initial seek lead (EMA of measured settle replaces it at runtime), s */
  seekLeadS: number;
  seekLeadMaxS: number;
  /** RATE mode window: nudge between deadband and this bound */
  rateZoneMaxS: number;
  nudgeRate: number;
  /** exit nudging when |drift| falls below this */
  nudgeExitS: number;
  /** give up on nudging and seek if not back in band within this, ms */
  nudgeStuckMs: number;
  /** paused reconcile: silent seek when |playerTime − mediaTime| exceeds */
  pausedReconcileS: number;
}

export const DEFAULT_CONTROLLER_TUNING: ControllerTuning = {
  deadbandS: 0.12,
  seekThresholdS: 0.3,
  sustainEvals: 2,
  instantSeekS: 2.5,
  seekSpacingMs: 3000,
  seekCooldownMs: 1500,
  postSeekStableEvals: 2,
  seekLeadS: 0.3,
  seekLeadMaxS: 1.2,
  rateZoneMaxS: 0.6,
  nudgeRate: 0.05,
  nudgeExitS: 0.06,
  nudgeStuckMs: 15_000,
  pausedReconcileS: 0.25,
};

export interface ControllerStatus {
  state: ControllerState;
  lastDriftS: number;
  seekLeadS: number;
  seeksIssued: number;
  nudgesIssued: number;
}

export class DriftController {
  private state: ControllerState = 'LOCKED';
  private driftWindow: number[] = [];
  private outOfBandCount = 0;
  private lastSeekAt = -Infinity;
  private seekTargetS: number | null = null;
  private stableEvals = 0;
  private nudgeSince: number | null = null;
  private rateApplied = false;
  private seekLead: number;
  private seeksIssued = 0;
  private nudgesIssued = 0;
  private lastDrift = 0;

  constructor(private tuning: ControllerTuning = DEFAULT_CONTROLLER_TUNING) {
    this.seekLead = tuning.seekLeadS;
  }

  suspend(): void {
    this.state = 'SUSPENDED';
    this.driftWindow = [];
    this.outOfBandCount = 0;
  }

  /** visibility restore / reconnect: evaluate immediately, hysteresis dropped */
  resume(): void {
    this.state = 'LOCKED';
    this.driftWindow = [];
    this.outOfBandCount = this.tuning.sustainEvals; // first out-of-band eval acts
  }

  getStatus(): ControllerStatus {
    return {
      state: this.state,
      lastDriftS: this.lastDrift,
      seekLeadS: this.seekLead,
      seeksIssued: this.seeksIssued,
      nudgesIssued: this.nudgesIssued,
    };
  }

  evaluate(input: ControllerInput): ControllerAction {
    const { timeline } = input;
    if (this.state === 'SUSPENDED' || timeline === null)
      return { type: 'none' };

    // ---- lifecycle reconciliation before drift logic ----
    if (input.playerState === 'buffering') {
      this.state = 'BUFFERING';
      if (this.rateApplied) {
        this.rateApplied = false;
        this.nudgeSince = null;
        return { type: 'clear-rate' };
      }
      return { type: 'none' };
    }

    if (!timeline.isPlaying) {
      // room is paused: reconcile position, make sure we are paused too
      if (input.playerState === 'playing') return { type: 'pause' };
      this.state = 'PAUSED_SYNC';
      const err = Math.abs(input.playerTime - timeline.mediaTime);
      if (
        err > this.tuning.pausedReconcileS &&
        input.tLocal - this.lastSeekAt > this.tuning.seekSpacingMs
      ) {
        this.lastSeekAt = input.tLocal;
        this.seeksIssued += 1;
        return { type: 'seek', toMediaTime: timeline.mediaTime };
      }
      return { type: 'none' };
    }

    // room is playing
    if (input.playerState === 'paused' || input.playerState === 'cued') {
      return { type: 'play' };
    }
    if (input.playerState !== 'playing') return { type: 'none' };

    // leaving BUFFERING: catch-up evaluation with cooldown waived (P2)
    const wasBuffering = this.state === 'BUFFERING';
    if (wasBuffering) this.state = 'LOCKED';

    const expected = projectMediaTime(timeline, input.serverNow);
    const rawDrift = input.playerTime - expected; // positive = ahead

    // median-of-3 guard against readout outliers
    this.driftWindow.push(rawDrift);
    if (this.driftWindow.length > 3) this.driftWindow.shift();
    const sorted = [...this.driftWindow].sort((a, b) => a - b);
    const drift = sorted[Math.floor(sorted.length / 2)];
    this.lastDrift = drift;
    const absDrift = Math.abs(drift);

    // post-seek: measure settle, ignore drift until cooldown + stability
    if (this.state === 'SEEKING') {
      const sinceSeek = input.tLocal - this.lastSeekAt;
      if (sinceSeek < this.tuning.seekCooldownMs) return { type: 'none' };
      if (absDrift <= this.tuning.deadbandS) {
        this.stableEvals += 1;
        if (this.stableEvals >= this.tuning.postSeekStableEvals) {
          // adapt the lead from the residual error of this seek
          if (this.seekTargetS !== null) {
            const residual = drift; // ahead(+)/behind(−) after settling
            this.seekLead = Math.min(
              this.tuning.seekLeadMaxS,
              Math.max(0, this.seekLead - residual * 0.5),
            );
            this.seekTargetS = null;
          }
          this.state = 'LOCKED';
          this.stableEvals = 0;
        }
        return { type: 'none' };
      }
      this.stableEvals = 0;
      if (sinceSeek < this.tuning.seekSpacingMs) return { type: 'none' };
      // fall through: still out of band after full spacing → act again
    }

    // instant path for gross desync (single reading, no filtering)
    if (Math.abs(rawDrift) > this.tuning.instantSeekS) {
      return this.issueSeek(input, timeline);
    }

    if (absDrift <= this.tuning.deadbandS) {
      this.outOfBandCount = 0;
      if (this.state === 'NUDGING' && absDrift <= this.tuning.nudgeExitS) {
        this.state = 'LOCKED';
        this.nudgeSince = null;
        this.rateApplied = false;
        return { type: 'clear-rate' };
      }
      if (this.state !== 'NUDGING') this.state = 'LOCKED';
      return { type: 'none' };
    }

    // out of band
    this.outOfBandCount += 1;
    if (this.outOfBandCount < this.tuning.sustainEvals && !wasBuffering) {
      return { type: 'none' };
    }

    // RATE mode: only when the probe proved fractional rates stick and the
    // error is small enough that a nudge closes it in reasonable time
    if (
      input.fractionalRateOK &&
      absDrift <= this.tuning.rateZoneMaxS &&
      this.state !== 'SEEKING'
    ) {
      if (this.state !== 'NUDGING') {
        this.state = 'NUDGING';
        this.nudgeSince = input.tLocal;
        this.rateApplied = true;
        this.nudgesIssued += 1;
        const rate =
          drift > 0 ? 1 - this.tuning.nudgeRate : 1 + this.tuning.nudgeRate;
        return { type: 'set-rate', rate };
      }
      if (
        this.nudgeSince !== null &&
        input.tLocal - this.nudgeSince > this.tuning.nudgeStuckMs
      ) {
        // stuck (or the probe lied): escalate
        this.nudgeSince = null;
        this.rateApplied = false;
        return this.issueSeek(input, timeline);
      }
      // keep the applied rate; direction flips are handled by exit+re-enter
      return { type: 'none' };
    }

    // SEEK mode (the default path)
    if (absDrift >= this.tuning.seekThresholdS || wasBuffering) {
      if (input.tLocal - this.lastSeekAt < this.tuning.seekSpacingMs) {
        return { type: 'none' };
      }
      return this.issueSeek(input, timeline);
    }

    // between deadband and seek threshold without rate support: tolerated
    // (documented: the SEEK-mode effective deadband is seekThresholdS)
    return { type: 'none' };
  }

  private issueSeek(
    input: ControllerInput,
    timeline: Timeline,
  ): ControllerAction {
    this.state = 'SEEKING';
    this.lastSeekAt = input.tLocal;
    this.stableEvals = 0;
    this.outOfBandCount = 0;
    this.driftWindow = [];
    this.seeksIssued += 1;
    if (this.rateApplied) this.rateApplied = false;
    const lead = timeline.isPlaying ? this.seekLead : 0;
    const target = projectMediaTime(timeline, input.serverNow) + lead;
    this.seekTargetS = target;
    return { type: 'seek', toMediaTime: Math.max(0, target) };
  }
}
