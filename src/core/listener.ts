// Mic stream -> VAD -> segmenter -> orchestrator callbacks. Takes 16 kHz mono floats in any chunk
// size (the renderer's AudioWorklet posts 512-sample frames) and processes frames in order.
import type { VadConfig } from '../shared/profile'
import type { VadSession } from './providers/types'
import { Segmenter } from './segmenter'

export interface ListenerCallbacks {
  onSpeechStart(): void
  onUtterance(audio: Float32Array, speechMs: number): void
  /** Speech probability of the latest frame (for the level meter), ~30 times a second. */
  onLevel?(probability: number, speaking: boolean): void
}

export class Listener {
  private readonly segmenter: Segmenter
  private buffer = new Float32Array(0)
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly vad: VadSession,
    config: Pick<VadConfig, 'threshold' | 'minSilenceMs' | 'minSpeechMs' | 'padMs'>,
    private readonly callbacks: ListenerCallbacks
  ) {
    this.segmenter = new Segmenter(config, vad.frameSamples)
  }

  push(samples: Float32Array): void {
    if (this.closed) return
    const merged = new Float32Array(this.buffer.length + samples.length)
    merged.set(this.buffer)
    merged.set(samples, this.buffer.length)
    const n = this.vad.frameSamples
    let at = 0
    const frames: Float32Array[] = []
    while (merged.length - at >= n) {
      frames.push(merged.slice(at, at + n))
      at += n
    }
    this.buffer = merged.slice(at)
    if (frames.length) this.chain = this.chain.then(() => this.process(frames))
  }

  private async process(frames: Float32Array[]): Promise<void> {
    for (const frame of frames) {
      if (this.closed) return
      const p = await this.vad.process(frame)
      for (const event of this.segmenter.push(frame, p)) {
        if (event.type === 'start') this.callbacks.onSpeechStart()
        else if (event.type === 'end') this.callbacks.onUtterance(event.audio, event.speechMs)
      }
      this.callbacks.onLevel?.(p, this.segmenter.speaking)
    }
  }

  /** Waits for queued frames (tests, Bench). */
  async flush(): Promise<void> {
    await this.chain
  }

  close(): void {
    this.closed = true
    this.vad.release()
  }
}
