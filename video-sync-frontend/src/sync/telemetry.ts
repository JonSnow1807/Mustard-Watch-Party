/**
 * Telemetry ring exposed at window.__mustardSync for the measurement
 * harness. The contract (getSamplesSince with absolute indices) is
 * unchanged from the baseline shim so old and new engines are measured
 * identically; the sample is a superset of the baseline's fields.
 */
export interface EngineTelemetrySample {
  tLocal: number;
  playerTime: number;
  /** raw numeric YT state (1 = PLAYING) — harness compatibility */
  playerState: number;
  /** estimator RTT, ms */
  rtt: number;
  driftMs: number;
  offsetMs: number;
  uncertaintyMs: number;
  ctrlState: string;
  seq: number;
  fractionalRateOK: boolean;
}

const MAX = 6000;

export class TelemetryRing {
  private base = 0;
  private buf: EngineTelemetrySample[] = [];

  push(sample: EngineTelemetrySample): void {
    this.buf.push(sample);
    if (this.buf.length > MAX) {
      this.base += this.buf.length - MAX;
      this.buf.splice(0, this.buf.length - MAX);
    }
  }

  install(): void {
    (window as any).__mustardSync = {
      version: 'engine-2',
      getSamplesSince: (abs: number) => {
        const start = Math.max(0, abs - this.base);
        return {
          next: this.base + this.buf.length,
          samples: this.buf.slice(start),
        };
      },
    };
  }

  uninstall(): void {
    delete (window as any).__mustardSync;
  }
}
