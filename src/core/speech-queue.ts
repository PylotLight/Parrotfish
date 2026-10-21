// TTS queue for one turn: sentences in, audio out to the sink, one sentence at a time (each
// provider streams faster than real time, so the next sentence is ready before this one ends).
// Abort (barge-in) stops synthesis; the sink is stopped by the orchestrator.
import type { PcmChunk } from '../shared/types'
import { isAbort, type Host, type TtsProvider } from './providers/types'

export interface AudioSink {
  /** First chunk of a turn's audio. `onStart` fires when the first sample actually plays. */
  begin(turnId: string, onStart: () => void): void
  write(turnId: string, chunk: PcmChunk): void
  /** No more audio for this turn. */
  end(turnId: string): void
  /** Barge-in: silence now and drop everything queued. */
  stop(): void
}

export class SpeechQueue {
  private readonly pending: string[] = []
  private running: Promise<void> | null = null
  private began = false
  private failure: Error | null = null
  readonly spoken: string[] = []

  constructor(
    private readonly tts: TtsProvider,
    private readonly sink: AudioSink,
    private readonly turnId: string,
    private readonly host: Host,
    private readonly signal: AbortSignal,
    private readonly onFirstAudio: () => void
  ) {}

  say(text: string): void {
    const t = text.trim()
    if (!t || this.signal.aborted) return
    this.pending.push(t)
    this.running ??= this.loop()
  }

  /** Resolves when every queued sentence has been synthesized (playback may still be going). */
  async drain(): Promise<void> {
    while (this.running) await this.running
    if (this.began) this.sink.end(this.turnId)
    if (this.failure) throw this.failure
  }

  private async loop(): Promise<void> {
    try {
      while (this.pending.length && !this.signal.aborted) {
        const text = this.pending.shift()!
        try {
          for await (const chunk of this.tts.synthesize(text, { signal: this.signal, host: this.host })) {
            if (this.signal.aborted) return
            if (chunk.samples.length === 0) continue
            if (!this.began) {
              this.began = true
              this.sink.begin(this.turnId, this.onFirstAudio)
            }
            this.sink.write(this.turnId, chunk)
          }
          this.spoken.push(text)
        } catch (error) {
          if (isAbort(error) || this.signal.aborted) return
          this.failure ??= error instanceof Error ? error : new Error(String(error))
          this.host.log('tts', `sentence failed: ${this.failure.message}`)
          return
        }
      }
    } finally {
      this.running = null
    }
  }
}
