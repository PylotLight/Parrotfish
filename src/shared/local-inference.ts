export interface LocalInferenceStatus {
  stage: 'stt' | 'tts'
  state: 'idle' | 'downloading' | 'loading' | 'benchmarking' | 'ready' | 'error'
  label: string
	/** Exact checkpoint identity, not the backend or cache filename. */
	modelId?: string
	backend?: string
	/** Requested execution backend (wasm/webgpu), distinct from observed runtime detail. */
	requestedBackend?: 'wasm' | 'webgpu'
	detail?: string
  received?: number
  total?: number
}
