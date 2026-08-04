// GENERATED FILE — do not edit here.
// Canonical source: /shared/. Regenerate: node scripts/sync-shared.mjs
// Predictive clock-discipline controller (M9): NTP/PTP servo theory applied
// to video playback. Where the reactive controller waits for drift to cross
// a threshold and corrects it, this one estimates each player's intrinsic
// drift RATE and commands a continuous playback rate that cancels drift
// before it accumulates - a discrete PI servo with a feed-forward skew term:
//
//   r = 1 - Kp*drift - Ki*integral(drift) - bHat
//
// where bHat is a recursively-estimated drift rate at r=1 (player clock
// skew + timer error), learned with exponential forgetting. Anti-windup
// stops integration while the command is clamped; command hysteresis avoids
// churning the player with sub-0.5% changes.
//
// Empirical gate: the modern YouTube player ACCEPTS fractional rates on
// probed videos (measured, contradicting the API reference's rounding
// language) - but the probe stays per-video and this controller is only
// engaged where it passed. Lifecycle handling and gross errors delegate to
// the reactive controller: the servo owns only the steady state.

import {
  ControllerAction,
  ControllerInput,
  ControllerStatus,
  ControllerTuning,
  DEFAULT_CONTROLLER_TUNING,
  DriftController,
} from './drift-controller';

export interface ServoTuning {
  /** proportional gain, rate offset per second of drift */
  kp: number;
  /** integral gain */
  ki: number;
  /** RLS forgetting factor for the drift-rate estimate */
  forgetting: number;
  /** command clamp: rate in [1-span, 1+span] */
  clampSpan: number;
  /** don't re-command the player for changes smaller than this */
  commandHysteresis: number;
  /** |drift| above this hands back to the reactive controller's seek path */
  servoZoneS: number;
  /** integral clamp (anti-windup bound), seconds */
  integralClampS: number;
}

export const DEFAULT_SERVO_TUNING: ServoTuning = {
  kp: 0.3,
  ki: 0.05,
  forgetting: 0.98,
  clampSpan: 0.05,
  commandHysteresis: 0.005,
  servoZoneS: 0.6,
  integralClampS: 2.0,
};

export interface ServoStatus extends ControllerStatus {
  servoActive: boolean;
  bHatPpm: number;
  commandedRate: number;
}

export class DisciplineController {
  private reactive: DriftController;
  private integral = 0;
  private bHat = 0; // estimated drift rate at r=1 (s/s)
  private rlsP = 1; // RLS covariance (scalar)
  private lastDrift: number | null = null;
  private lastT: number | null = null;
  private appliedRate = 1;
  private lastCommand = 1;
  private servoActive = false;

  constructor(
    private servo: ServoTuning = DEFAULT_SERVO_TUNING,
    reactiveTuning: ControllerTuning = DEFAULT_CONTROLLER_TUNING,
  ) {
    // the servo owns [deadband, servoZone]; the inner reactive controller
    // must not seek inside that band, so its threshold moves to the zone
    // boundary (its instant path and lifecycle handling are untouched)
    this.reactive = new DriftController({
      ...reactiveTuning,
      seekThresholdS: servo.servoZoneS,
    });
  }

  /** Stand down; the caller restores playback rate 1 (see DriftController). */
  suspend(): void {
    this.reactive.suspend();
    this.resetServo();
  }

  resume(): void {
    this.reactive.resume();
  }

  getStatus(): ServoStatus {
    return {
      ...this.reactive.getStatus(),
      servoActive: this.servoActive,
      bHatPpm: this.bHat * 1e6,
      commandedRate: this.lastCommand,
    };
  }

  private resetServo(): void {
    this.integral = 0;
    this.lastDrift = null;
    this.lastT = null;
    this.servoActive = false;
    // The executor restores playback rate 1 whenever it seeks or suspends
    // (SyncEngine.execute / bot executor), so the servo's belief must match
    // or the next b-hat measurement is biased by the stale command.
    this.appliedRate = 1;
    this.lastCommand = 1;
    // bHat survives resets on purpose: the player's skew doesn't change
    // because we sought; the estimate is the point of the exercise
  }

  evaluate(input: ControllerInput): ControllerAction {
    // The reactive controller owns lifecycle (buffering/paused/play-start),
    // gross errors (instant seeks) and the SEEKING machinery. Feed it a
    // fractionalRateOK=false view so its own NUDGING mode never engages -
    // the servo replaces that entire regime.
    const act = this.reactive.evaluate({ ...input, fractionalRateOK: false });
    const st = this.reactive.getStatus();

    if (act.type === 'seek') {
      this.resetServo();
      return act;
    }
    if (act.type !== 'none' || st.state !== 'LOCKED') {
      // paused/buffering/cooldown etc.: stand down, clear any applied rate
      if (this.servoActive && input.playerState !== 'playing') {
        this.resetServo();
        this.appliedRate = 1;
        return act.type === 'none' ? { type: 'clear-rate' } : act;
      }
      return act;
    }

    // steady playing state - the servo regime
    const drift = st.lastDriftS;
    if (Math.abs(drift) > this.servo.servoZoneS) {
      // outside the servo zone: let the reactive machinery seek next tick
      return { type: 'none' };
    }

    const t = input.tLocal / 1000;
    if (this.lastT !== null && this.lastDrift !== null) {
      const dt = t - this.lastT;
      if (dt > 0 && dt < 2) {
        // observed drift rate this interval, corrected for the rate we
        // commanded: dDrift/dt = (r_applied - 1) + b  =>  b measurement
        const measuredB =
          (drift - this.lastDrift) / dt - (this.appliedRate - 1);
        // scalar RLS with forgetting
        const g = this.rlsP / (this.servo.forgetting + this.rlsP);
        this.bHat += g * (measuredB - this.bHat);
        this.rlsP = (1 - g) * (this.rlsP / this.servo.forgetting);

        // integral with anti-windup: freeze while the last command clamped
        const clamped =
          Math.abs(this.lastCommand - 1) >= this.servo.clampSpan - 1e-9;
        if (!clamped) {
          this.integral = Math.max(
            -this.servo.integralClampS,
            Math.min(this.servo.integralClampS, this.integral + drift * dt),
          );
        }
      }
    }
    this.lastT = t;
    this.lastDrift = drift;

    let r =
      1 - this.servo.kp * drift - this.servo.ki * this.integral - this.bHat;
    r = Math.max(
      1 - this.servo.clampSpan,
      Math.min(1 + this.servo.clampSpan, r),
    );
    this.lastCommand = r;
    this.servoActive = true;

    if (Math.abs(r - this.appliedRate) < this.servo.commandHysteresis) {
      return { type: 'none' };
    }
    this.appliedRate = r;
    return { type: 'set-rate', rate: r };
  }

  /** The engine reports what the player actually applied (probe honesty). */
  onRateApplied(applied: number): void {
    this.appliedRate = applied;
  }
}
