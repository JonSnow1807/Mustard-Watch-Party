/**
 * Audio ground truth (M10).
 *
 * Every drift number this project publishes ultimately comes from a player's
 * own `currentTime`. That is the instrument grading itself: if the readout
 * were biased, every client would agree on a wrong answer and the harness
 * would report perfect sync.
 *
 * This measures the SIGNAL instead. A same-origin media element is routed
 * through a Web Audio graph; an AudioWorklet running on the audio thread
 * examines every 128-sample quantum (~2.7ms at 48kHz) for the test asset's
 * periodic click and reports each onset with the AudioContext clock, which
 * the main thread maps onto the page clock the harness shares across all
 * browsers. Two clients playing the same click at the same instant produce
 * the same stamp - so the difference between their stamps is the REAL output
 * skew, computed without consulting any player clock.
 *
 * The click index is labelled from `currentTime` (clicks are 2s apart, so
 * ±100ms of player-clock error cannot mislabel one) while the timing comes
 * only from the audio onset. Coarse identification, precise measurement.
 *
 * Known constant offsets - device output latency and the worklet's own
 * quantum - are IDENTICAL across clients on one machine and therefore cancel
 * in the pairwise comparison. They would not cancel across heterogeneous
 * hardware; that is stated in docs/AUDIO_TRUTH.md rather than hidden.
 */

export interface AudioOnset {
  /** click index in the asset: click k occurs at mediaTime = k * spacing */
  index: number;
  /** page clock (ms) at onset - the cross-client comparison basis */
  tLocal: number;
  /** the player's own clock at that instant, for the calibration chart */
  playerTime: number;
  /** peak RMS of the detected burst (quality filter) */
  level: number;
}

const CLICK_SPACING_S = 2;
const RMS_THRESHOLD = 0.08;
/** a click is ~30ms; refuse re-triggering inside one burst */
const REARM_S = 0.4;
const MAX_ONSETS = 400;

/** Runs on the audio thread: one RMS per 128-sample quantum, no jitter. */
const WORKLET_SRC = `
class ClickDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this._armedAt = -1;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (rms > ${RMS_THRESHOLD} && currentTime - this._armedAt > ${REARM_S}) {
      this._armedAt = currentTime;
      // currentTime is the AudioContext clock at the START of this quantum
      this.port.postMessage({ ctxTime: currentTime, level: rms });
    }
    return true;
  }
}
registerProcessor('click-detector', ClickDetector);
`;

export class AudioTruthProbe {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private onsets: AudioOnset[] = [];

  constructor(private el: HTMLMediaElement) {}

  async start(): Promise<boolean> {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return false;
    try {
      this.ctx = new Ctor();
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const source = this.ctx.createMediaElementSource(this.el);
      this.node = new AudioWorkletNode(this.ctx, 'click-detector');
      source.connect(this.node);
      // keep the element audible: routing through the graph would otherwise
      // silence it, and a muted player is not the thing under test
      source.connect(this.ctx.destination);

      this.node.port.onmessage = (ev: MessageEvent) => {
        const { ctxTime, level } = ev.data as { ctxTime: number; level: number };
        const tLocal = this.toWallClock(ctxTime);
        const playerTime = this.el.currentTime;
        this.onsets.push({
          index: Math.round(playerTime / CLICK_SPACING_S),
          tLocal,
          playerTime,
          level,
        });
        if (this.onsets.length > MAX_ONSETS) this.onsets.shift();
      };

      (window as unknown as { __mustardAudio: unknown }).__mustardAudio = {
        version: 'audio-truth-1',
        spacingS: CLICK_SPACING_S,
        sampleRate: this.ctx.sampleRate,
        // constant per-client offsets, reported so a reader can see they were
        // considered rather than ignored
        baseLatency: this.ctx.baseLatency ?? null,
        outputLatency:
          (this.ctx as AudioContext & { outputLatency?: number })
            .outputLatency ?? null,
        getOnsets: () => this.onsets.slice(),
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Map an AudioContext instant onto the page clock.
   *
   * A fixed epoch pair sampled at construction is WRONG: the context clock
   * does not advance while suspended (autoplay policy suspends it until the
   * first gesture), so clients that started at different times accumulate
   * different offsets. The first run of this experiment reported a 1.75s
   * audio skew against a 6ms player-clock agreement - entirely this artifact,
   * exactly the stagger between client launches.
   *
   * getOutputTimestamp() is the API for this: the browser maintains an exact
   * (contextTime, performanceTime) correspondence that already accounts for
   * suspension and output latency.
   */
  private toWallClock(ctxTime: number): number {
    if (!this.ctx) return Date.now();
    const ts = this.ctx.getOutputTimestamp();
    if (
      typeof ts.contextTime === 'number' &&
      typeof ts.performanceTime === 'number'
    ) {
      const wallAtStamp = performance.timeOrigin + ts.performanceTime;
      return wallAtStamp + (ctxTime - ts.contextTime) * 1000;
    }
    return Date.now();
  }

  stop(): void {
    this.node?.port.close();
    void this.ctx?.close();
    delete (window as unknown as { __mustardAudio?: unknown }).__mustardAudio;
  }
}
