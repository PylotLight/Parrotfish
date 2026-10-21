export interface LocalInferenceStatus {
  stage: 'stt' | 'tts'
  state: 'idle' | 'downloading' | 'loading' | 'benchmarking' | 'ready' | 'error'
  label: string
  /** Exact checkpoint identity, not the backend or cache filename. */
  modelId?: string
  backend?: string
  detail?: string
  received?: number
  total?: number
}
