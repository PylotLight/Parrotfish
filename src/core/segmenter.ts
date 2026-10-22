// VAD probabilities -> utterances. Keeps `padMs` of audio before the start, ends a segment after
// `minSilenceMs` below threshold (with hysteresis), drops segments shorter than `minSpeechMs`.
// "start" fires once ~150 ms of speech is in, so clicks don't barge in.
import type { VadConfig } from "../shared/profile";
import { concatPcm } from "./audio";

export type SegmentEvent =
  | { type: "start" }
  | { type: "end"; audio: Float32Array; speechMs: number }
  | { type: "drop"; speechMs: number };

export const START_CONFIRM_MS = 150;

export class Segmenter {
  private readonly frameMs: number;
  private preroll: Float32Array[] = [];
  private collected: Float32Array[] = [];
  private inSpeech = false;
  private started = false;
  private speechMs = 0;
  private silenceMs = 0;

  constructor(
    private readonly config: Pick<
      VadConfig,
      "threshold" | "minSilenceMs" | "minSpeechMs" | "padMs"
    >,
    readonly frameSamples = 512,
    readonly sampleRate = 16000,
  ) {
    this.frameMs = (frameSamples / sampleRate) * 1000;
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  push(frame: Float32Array, probability: number): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    const { threshold } = this.config;
    if (!this.inSpeech) {
      if (probability >= threshold) {
        this.inSpeech = true;
        this.started = false;
        this.speechMs = this.frameMs;
        this.silenceMs = 0;
        this.collected = [...this.preroll, frame];
        this.preroll = [];
      } else {
        this.preroll.push(frame);
        const keep = Math.ceil(this.config.padMs / this.frameMs);
        if (this.preroll.length > keep)
          this.preroll.splice(0, this.preroll.length - keep);
      }
    } else {
      this.collected.push(frame);
      if (probability >= threshold - 0.15) {
        this.speechMs += this.frameMs + this.silenceMs;
        this.silenceMs = 0;
      } else {
        this.silenceMs += this.frameMs;
      }
      if (this.silenceMs >= this.config.minSilenceMs) {
        const speechMs = Math.round(this.speechMs);
        if (speechMs >= this.config.minSpeechMs) {
          // keep ~100 ms of the trailing silence, drop the rest
          const tailFrames = Math.max(
            0,
            Math.floor((this.silenceMs - 100) / this.frameMs),
          );
          const audio = concatPcm(
            this.collected.slice(0, this.collected.length - tailFrames),
          );
          events.push({ type: "end", audio, speechMs });
        } else {
          events.push({ type: "drop", speechMs });
        }
        this.inSpeech = false;
        this.started = false;
        this.collected = [];
        this.speechMs = 0;
        this.silenceMs = 0;
        return events;
      }
    }
    if (
      this.inSpeech &&
      !this.started &&
      this.speechMs >=
        Math.min(START_CONFIRM_MS, this.config.minSpeechMs || START_CONFIRM_MS)
    ) {
      this.started = true;
      events.push({ type: "start" });
    }
    return events;
  }

  reset(): void {
    this.preroll = [];
    this.collected = [];
    this.inSpeech = false;
    this.started = false;
    this.speechMs = 0;
    this.silenceMs = 0;
  }
}
