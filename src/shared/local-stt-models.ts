export const DEFAULT_LOCAL_STT_MODEL = 'nvidia/parakeet-tdt-0.6b-v2'

// Redux is not an alias for NVIDIA v3 or Ultra. The pinned ONNX conversion
// preserves its ternary weights; it passed transcription with our installed
// parakeet.js 1.4.4 / ORT Web 1.24.1 WASM runtime before being enabled.
export const LOCAL_STT_MODELS = [
  { id: DEFAULT_LOCAL_STT_MODEL, label: 'Parakeet TDT 0.6B v2', available: true, blocker: undefined },
  {
    id: 'moondream/parakeet-redux',
    label: 'Parakeet Redux',
    available: true,
    blocker: undefined,
  },
] as const

export function localSttModel(value: unknown): (typeof LOCAL_STT_MODELS)[number] {
  const id = value == null || value === '' ? DEFAULT_LOCAL_STT_MODEL : value
  const model = LOCAL_STT_MODELS.find(item => item.id === id)
  if (!model) throw new Error(`Unknown local STT model: ${String(id)}. No model substitution is allowed.`)
  return model
}

export function requireLocalSttModel(value: unknown): (typeof LOCAL_STT_MODELS)[number] {
  const model = localSttModel(value)
  if (!model.available) throw new Error(model.blocker)
  return model
}
