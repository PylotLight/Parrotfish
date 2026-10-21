import type { LocalInferenceStatus } from './local-inference'
import { localSttModel } from './local-stt-models'

/** Never present one checkpoint's cached readiness/backend as another's. */
export function localSttStatus(value: unknown, cached?: LocalInferenceStatus): LocalInferenceStatus {
  try {
    const model = localSttModel(value)
    if (!model.available) return { stage: 'stt', state: 'error', modelId: model.id, label: model.label, detail: model.blocker }
    if (cached?.modelId === model.id) return cached
    return { stage: 'stt', state: 'idle', modelId: model.id, label: model.label, detail: 'Prepare models to verify cached assets and select the fastest available backend.' }
  } catch (error) {
    return { stage: 'stt', state: 'error', label: 'Unknown local STT model', detail: error instanceof Error ? error.message : String(error) }
  }
}
