// Plays the agent's audio: PCM chunks from main scheduled back to back on the Web Audio clock.
// Reports when a turn's first sample actually reaches the output (scheduled start + output
// latency), which is the "first audio" mark on the waterfall, and when everything has played.
const api = window.parrotfish

export class Player {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private readonly sources = new Set<AudioBufferSourceNode>()
  private turn: string | null = null
  private nextAt = 0
  private started = false
  private ended = false
  private startTimer: ReturnType<typeof setTimeout> | null = null
  onActivity: (playing: boolean) => void = () => {}

  private context(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 256
      this.gain.connect(this.analyser)
      this.analyser.connect(this.ctx.destination)
    }
    return this.ctx
  }

  /** Output level 0..1 for the speaking meter. */
  level(): number {
    if (!this.analyser || this.sources.size === 0) return 0
    const data = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(data)
    let peak = 0
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
    return peak
  }

  begin(turnId: string): void {
    this.stop(false)
    this.turn = turnId
    this.started = false
    this.ended = false
    this.nextAt = 0
    void this.context().resume()
  }

  chunk(turnId: string, samples: Float32Array, sampleRate: number): void {
    if (turnId !== this.turn || samples.length === 0) return
    const ctx = this.context()
    const buffer = ctx.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain!)
    const at = Math.max(this.nextAt, ctx.currentTime + 0.02)
    source.start(at)
    this.nextAt = at + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
      this.checkIdle()
    }
    if (!this.started) {
      this.started = true
      this.onActivity(true)
      const latency = (ctx.outputLatency || ctx.baseLatency || 0) * 1000
      const delay = Math.max(0, (at - ctx.currentTime) * 1000 + latency)
      this.startTimer = setTimeout(() => api.audio.started(turnId), delay)
    }
  }

  end(turnId: string): void {
    if (turnId !== this.turn) return
    this.ended = true
    this.checkIdle()
  }

  /** Barge-in / stop: silence now. */
  stop(report = true): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        // already stopped
      }
      s.disconnect()
    }
    this.sources.clear()
    const had = this.turn !== null
    this.turn = null
    if (had && report) {
      this.onActivity(false)
      api.audio.idle()
    }
  }

  private checkIdle(): void {
    if (this.ended && this.sources.size === 0 && this.turn) {
      this.turn = null
      this.onActivity(false)
      api.audio.idle()
    }
  }
}
