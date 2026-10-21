import type { LocalInferenceStatus } from './local-inference'
import { localSttModel } from './local-stt-models'

/** Never present another checkpoint or requested backend's cached readiness. */
export function localSttStatus(value: unknown, backend: 'wasm' | 'webgpu' = 'wasm', cached?: LocalInferenceStatus): LocalInferenceStatus {
  try {
    const model = localSttModel(value)
    if (!model.available) return { stage: 'stt', state: 'error', modelId: model.id, requestedBackend: backend, label: model.label, detail: model.blocker }
    if (cached?.modelId === model.id && cached.requestedBackend === backend) return cached
    return { stage: 'stt', state: 'idle', modelId: model.id, requestedBackend: backend, label: model.label, detail: backend === 'webgpu' ? 'Prepare models to verify assets and run the opt-in WebGPU trial.' : 'Prepare models to verify compact CPU assets and load WASM. No GPU weights are needed.' }
  } catch (error) {
    return { stage: 'stt', state: 'error', label: 'Unknown local STT model', detail: error instanceof Error ? error.message : String(error) }
  }
}
