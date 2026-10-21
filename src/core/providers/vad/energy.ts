// Energy VAD: RMS of each frame mapped to a 0..1 "probability". No model, works everywhere; the
// fallback when Silero can't load. `floor`/`ceiling` are the RMS levels mapped to 0 and 1.
import { optNumber } from '../../../shared/profile'
import { rms } from '../../audio'
import type { ProviderFactory, VadProvider } from '../types'

export const energyVad: ProviderFactory<VadProvider> = (options) => {
  const floor = optNumber(options, 'floor', 0.004)
  const ceiling = optNumber(options, 'ceiling', 0.04)
  return {
    id: 'energy',
    async open() {
      return {
        frameSamples: 512,
        process(frame: Float32Array) {
          return Math.max(0, Math.min(1, (rms(frame) - floor) / Math.max(1e-6, ceiling - floor)))
        },
        reset() {},
        release() {}
      }
    }
  }
}
