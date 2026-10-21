// Phonon 31m in-process: phonon-tts 0.4.0 (MIT OR Apache-2.0) WASM in a hidden cross-origin-isolated
// window (src/main/phonon), ported from Surffish's Read Aloud (PR #290). Model + voices download on
// first use, pinned and sha256-checked. Speed: duration_delta up to ~1.25x, WSOLA time stretch beyond.
// Phonon 40m is CC BY-NC and is never used.
import { optNumber, optString } from '../../../shared/profile'
import type { ProviderFactory, TtsProvider } from '../types'

export const phononWasm: ProviderFactory<TtsProvider> = (options) => ({
  id: 'phonon-wasm',
  async *synthesize(text, ctx) {
    if (!ctx.host.phonon) throw new Error('in-process Phonon is not available (engine window failed to start)')
    const seed = typeof options.seed === 'number' ? options.seed : undefined
    yield* ctx.host.phonon.stream(
      text,
      { voice: optString(options, 'voice', 'default'), speed: optNumber(options, 'speed', 1), temperature: optNumber(options, 'temperature', 0.3), ...(seed !== undefined ? { seed } : {}) },
      ctx.signal
    )
  }
})
