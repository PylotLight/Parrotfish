// Mock TTS: a faint tone sized like real speech (msPerChar), in 80 ms chunks, faster than real time.
import { optBool, optNumber } from '../../../shared/profile'
import { sleep, type ProviderFactory, type TtsProvider } from '../types'

export const mockTts: ProviderFactory<TtsProvider> = (options) => ({
  id: 'mock',
  async *synthesize(text, ctx) {
    const rate = 24000
    await sleep(optNumber(options, 'delayMs', 80), ctx.signal)
    const totalMs = Math.max(200, text.length * optNumber(options, 'msPerChar', 55))
    const audible = optBool(options, 'audible', true)
    let phase = 0
    for (let at = 0; at < totalMs; at += 80) {
      const n = Math.round((Math.min(80, totalMs - at) / 1000) * rate)
      const samples = new Float32Array(n)
      if (audible) for (let i = 0; i < n; i++) samples[i] = 0.03 * Math.sin((phase += (2 * Math.PI * 220) / rate))
      yield { samples, sampleRate: rate }
      await sleep(optNumber(options, 'chunkDelayMs', 4), ctx.signal)
    }
  }
})
