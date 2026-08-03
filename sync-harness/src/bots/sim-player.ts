// Deterministic simulated player for protocol-level testing at scale.
// Implements the same lifecycle/positions surface the DriftController
// expects, with the imperfections that matter: playback-rate skew, command
// latency, seek/settle buffering, and scripted stalls.

import type { PlayerLifecycle } from '../../../shared/sync-core/drift-controller';

/** mulberry32 — tiny seeded PRNG so every run is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimPlayerConfig {
  /** playback-rate error, e.g. 80e-6 = +80ppm fast */
  playbackSkew: number;
  /** command latency range ms (play/pause/seek take effect after this) */
  commandLatencyMinMs: number;
  commandLatencyMaxMs: number;
  /** seek settle (BUFFERING) duration range ms */
  seekSettleMinMs: number;
  seekSettleMaxMs: number;
  /** supports fractional playbackRate (exercises RATE mode in some bots) */
  fractionalRateOK: boolean;
  rng: () => number;
}

export class SimPlayer {
  private lifecycle: PlayerLifecycle = 'cued';
  private position = 0;
  private lastAdvanceAt: number | null = null;
  private rate = 1;
  private pendingUntil = 0;
  private pending: (() => void)[] = [];
  private stallUntil = 0;

  constructor(private cfg: SimPlayerConfig) {}

  /** Advance the simulation to virtual time t (ms). Call before reads. */
  advance(t: number): void {
    if (this.pending.length > 0 && t >= this.pendingUntil) {
      const actions = this.pending;
      this.pending = [];
      actions.forEach((a) => a());
      this.lastAdvanceAt = t;
    }
    if (this.stallUntil > 0 && t >= this.stallUntil && this.lifecycle === 'buffering') {
      this.lifecycle = 'playing';
      this.stallUntil = 0;
      this.lastAdvanceAt = t;
    }
    if (this.lifecycle === 'playing' && this.lastAdvanceAt !== null) {
      const dt = (t - this.lastAdvanceAt) / 1000;
      this.position += dt * this.rate * (1 + this.cfg.playbackSkew);
    }
    this.lastAdvanceAt = t;
  }

  private later(t: number, action: () => void): void {
    const latency =
      this.cfg.commandLatencyMinMs +
      this.cfg.rng() * (this.cfg.commandLatencyMaxMs - this.cfg.commandLatencyMinMs);
    this.pendingUntil = t + latency;
    this.pending.push(action);
  }

  getPlayerTime(): number {
    return this.position;
  }

  getLifecycle(): PlayerLifecycle {
    return this.lifecycle;
  }

  play(t: number): void {
    this.later(t, () => {
      if (this.lifecycle !== 'playing') this.lifecycle = 'playing';
    });
  }

  pause(t: number): void {
    this.later(t, () => {
      this.lifecycle = 'paused';
    });
  }

  seekTo(t: number, mediaTime: number): void {
    this.later(t, () => {
      this.position = mediaTime;
      const settle =
        this.cfg.seekSettleMinMs +
        this.cfg.rng() * (this.cfg.seekSettleMaxMs - this.cfg.seekSettleMinMs);
      // paused seeks settle instantly enough not to buffer
      if (this.lifecycle === 'playing' || this.lifecycle === 'cued') {
        this.lifecycle = 'buffering';
        this.stallUntil = this.pendingUntil + settle;
      }
    });
  }

  setRate(rate: number): number {
    this.rate = this.cfg.fractionalRateOK ? rate : Math.round(rate);
    return this.rate;
  }

  /** Scripted network stall: freeze playback for durationMs at time t. */
  stall(t: number, durationMs: number): void {
    if (this.lifecycle === 'playing') {
      this.lifecycle = 'buffering';
      this.stallUntil = t + durationMs;
    }
  }
}
