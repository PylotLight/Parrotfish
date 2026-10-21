export const STT_SCHEME = 'parrotfish-stt'
export const STT_ORIGIN = `${STT_SCHEME}://engine`
export const STT_PAGE = 'stt-engine.html'
export const STT_PARTITION = 'persist:parrotfish-stt'
export type SttCommand = { type: 'warm'; id: number } | { type: 'transcribe'; id: number; samples: Float32Array; sampleRate: number } | { type: 'cancel'; id: number } | { type: 'gpu-assets-ready'; id: number; error?: string }
export type SttEvent = { type: 'ready' } | { type: 'warmed'; id: number } | { type: 'gpu-assets'; id: number } | { type: 'status'; state: 'loading' | 'benchmarking' | 'ready'; backend?: string; detail?: string } | { type: 'result'; id: number; text: string } | { type: 'error'; id?: number; message: string }
