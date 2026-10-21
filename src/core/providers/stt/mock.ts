// Mock STT: fixed delay, returns the audio's `hint` (Bench) or options.text.
import { optNumber, optString } from '../../../shared/profile'
import { sleep, type ProviderFactory, type SttProvider } from '../types'

export const mockStt: ProviderFactory<SttProvider> = (options) => ({
  id: 'mock',
  async transcribe(audio, ctx) {
    await sleep(optNumber(options, 'delayMs', 120), ctx.signal)
    return { text: audio.hint ?? optString(options, 'text', 'what time is it') }
  }
})
