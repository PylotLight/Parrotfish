import * as ort from 'onnxruntime-web'
import { fromUrls } from 'parakeet.js'
import type { SttCommand, SttEvent } from '../../shared/stt-engine'
import { requireLocalSttModel } from '../../shared/local-stt-models'

type Model = Awaited<ReturnType<typeof fromUrls>>
const origin = self.location.origin
const wasmPaths = `${origin}/ort/`
ort.env.wasm.wasmPaths = wasmPaths
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2)
ort.env.wasm.initTimeout = 30_000
const REDUX = 'moondream/parakeet-redux'
let model: Model | null = null
let modelId: string | null = null
let modelBackend: 'wasm' | 'webgpu' = 'wasm'
let backend = ''
let gpuSelected = false
let chain: Promise<void> = Promise.resolve()
const controllers = new Map<number, AbortController>()
const canceled = new Set<number>()
const gpuWaiters = new Map<number, { resolve(): void; reject(error: Error): void }>()
let nextGpuId = 0
function post(e: SttEvent): void { self.postMessage(e) }
function modelFiles(id: string, gpu = false) {
  const base = `${origin}/model/${encodeURIComponent(id)}/`
  if (id === REDUX) return { encoderUrl: `${base}encoder-model.onnx`, decoderUrl: `${base}decoder_joint-model.onnx`, tokenizerUrl: `${base}vocab.txt` }
  if (gpu) return { encoderUrl: `${base}encoder-model.onnx`, encoderDataUrl: `${base}encoder-model.onnx.data`, decoderUrl: `${base}decoder_joint-model.int8.onnx`, tokenizerUrl: `${base}vocab.txt`, filenames: { encoder: 'encoder-model.onnx', decoder: 'decoder_joint-model.int8.onnx' } }
  return { encoderUrl: `${base}encoder-model.int8.onnx`, decoderUrl: `${base}decoder_joint-model.int8.onnx`, tokenizerUrl: `${base}vocab.txt` }
}
function options(id: string, b: 'webgpu' | 'wasm', gpu = false) { return { ...modelFiles(id, gpu), backend: b, preprocessorBackend: 'js' as const, nMels: 128, wasmPaths, cpuThreads: Math.min(4, navigator.hardwareConcurrency || 2) } }
function release(m: Model): void {
  const x = m as unknown as { encoderSession?: { release?: () => void }; joinerSession?: { release?: () => void }; _combState1?: { dispose?: () => void }; _combState2?: { dispose?: () => void }; _targetTensor?: { dispose?: () => void }; _targetLenTensor?: { dispose?: () => void } }
  x.encoderSession?.release?.(); x.joinerSession?.release?.(); x._combState1?.dispose?.(); x._combState2?.dispose?.(); x._targetTensor?.dispose?.(); x._targetLenTensor?.dispose?.()
}
function clearModel(): void { if (model) release(model); model = null; modelId = null; modelBackend = 'wasm'; gpuSelected = false; backend = '' }
function requestGpuAssets(): Promise<void> {
  const id = ++nextGpuId
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { gpuWaiters.delete(id); reject(new Error('GPU encoder download timed out')) }, 600_000); gpuWaiters.set(id, { resolve: () => { clearTimeout(timer); resolve() }, reject: e => { clearTimeout(timer); reject(e) } }); post({ type: 'gpu-assets', id }) })
}
async function create(id: string, b: 'webgpu' | 'wasm', gpu = false): Promise<Model> { return fromUrls(options(id, b, gpu)) }
async function load(id: string, requestedBackend: 'wasm' | 'webgpu' = 'wasm'): Promise<Model> {
  if (model && modelId === id && modelBackend === requestedBackend) return model
  if (model) clearModel()
  post({ type: 'status', state: 'loading', modelId: id, detail: `Loading ${id === REDUX ? 'Parakeet Redux' : 'Parakeet TDT 0.6B v2'} (128-mel configuration)` })
  if (requestedBackend === 'wasm') {
    model = await create(id, 'wasm'); modelId = id; modelBackend = 'wasm'; gpuSelected = false; backend = 'WASM CPU'
    post({ type: 'status', state: 'ready', modelId: id, backend, detail: 'WASM CPU selected explicitly; GPU was not probed.' }); return model
  }
  let gpuReason = 'WebGPU is unavailable'
  if ('gpu' in navigator) {
    let candidate: Model | undefined, cpu: Model | undefined
    try {
      const adapter = await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter()
      if (adapter) {
        if (id !== REDUX) {
          post({ type: 'status', state: 'loading', modelId: id, detail: 'WebGPU trial requires verified full-precision v2 encoder weights.' })
          await requestGpuAssets()
        } else post({ type: 'status', state: 'loading', modelId: id, detail: 'Probing the pinned Redux encoder with WebGPU; no additional model files are required.' })
        candidate = await fromUrls({ ...options(id, 'webgpu', id !== REDUX), backend: 'webgpu-strict' })
        const probe = new Float32Array(16000); post({ type: 'status', state: 'benchmarking', modelId: id, backend: 'WebGPU encoder + WASM decoder', detail: 'Comparing warmed one-second inference against WASM CPU' })
        await candidate.transcribe(probe, 16000); const start = performance.now(); await candidate.transcribe(probe, 16000); const gpuMs = performance.now() - start
        cpu = await create(id, 'wasm'); await cpu.transcribe(probe, 16000); const cpuStart = performance.now(); await cpu.transcribe(probe, 16000); const cpuMs = performance.now() - cpuStart
        if (gpuMs < cpuMs) { release(cpu); model = candidate; candidate = undefined; modelId = id; modelBackend = 'webgpu'; gpuSelected = true; backend = 'WebGPU encoder + WASM decoder'; post({ type: 'status', state: 'ready', modelId: id, backend, detail: `Selected after warmed probe (${Math.round(gpuMs)} ms GPU vs ${Math.round(cpuMs)} ms CPU).` }); return model }
        gpuReason = `WebGPU was slower (${Math.round(gpuMs)} ms vs CPU ${Math.round(cpuMs)} ms)`; model = cpu; cpu = undefined
      } else gpuReason = 'No WebGPU adapter was available'
    } catch (e) { gpuReason = `WebGPU initialization or probe failed: ${e instanceof Error ? e.message : String(e)}` }
    if (candidate) release(candidate); if (cpu) release(cpu)
  }
  if (!model) model = await create(id, 'wasm')
  modelId = id; modelBackend = requestedBackend; gpuSelected = false; backend = 'WASM CPU'; post({ type: 'status', state: 'ready', modelId: id, backend, detail: `${gpuReason}; using WASM CPU.` }); return model
}
async function fallbackToCpu(id: string, reason: string): Promise<Model> {
  clearModel(); model = await create(id, 'wasm'); modelId = id; modelBackend = 'webgpu'; backend = 'WASM CPU (fallback after WebGPU failure)'
  post({ type: 'status', state: 'ready', modelId: id, backend, detail: `WebGPU inference failed (${reason}); retried with WASM CPU.` }); return model
}
async function run(c: Extract<SttCommand, { type: 'transcribe' }>): Promise<void> {
  const ctrl = controllers.get(c.id)
  if (!ctrl || ctrl.signal.aborted || canceled.has(c.id)) { controllers.delete(c.id); canceled.delete(c.id); return }
  try {
    const selected = requireLocalSttModel(c.modelId)
    let m = await load(selected.id, c.backend === 'webgpu' ? 'webgpu' : 'wasm')
    if (ctrl.signal.aborted || canceled.has(c.id)) return
    if (c.sampleRate !== 16000) throw new Error('Parakeet expects 16 kHz mono PCM; resample audio before transcription.')
    let result
    try { result = await m.transcribe(c.samples, 16000) }
    catch (e) { if (!gpuSelected || ctrl.signal.aborted || canceled.has(c.id)) throw e; m = await fallbackToCpu(selected.id, e instanceof Error ? e.message : String(e)); if (ctrl.signal.aborted || canceled.has(c.id)) return; result = await m.transcribe(c.samples, 16000) }
    if (!ctrl.signal.aborted && !canceled.has(c.id)) post({ type: 'result', id: c.id, modelId: selected.id, text: result.utterance_text ?? '' })
  } catch (e) { if (!ctrl.signal.aborted && !canceled.has(c.id)) post({ type: 'error', id: c.id, modelId: c.modelId, message: e instanceof Error ? e.message : String(e) }) }
  finally { controllers.delete(c.id); canceled.delete(c.id) }
}
self.onmessage = (event: MessageEvent<SttCommand>) => {
  const c = event.data
  if (c.type === 'gpu-assets-ready') { const w = gpuWaiters.get(c.id); if (w) { gpuWaiters.delete(c.id); if (c.error) w.reject(new Error(c.error)); else w.resolve() } return }
  if (c.type === 'cancel') { canceled.add(c.id); controllers.get(c.id)?.abort(); return }
  if (c.type === 'warm') {
    chain = chain.then(async () => { const selected = requireLocalSttModel(c.modelId); await load(selected.id, c.backend === 'webgpu' ? 'webgpu' : 'wasm'); post({ type: 'warmed', id: c.id, modelId: selected.id }) }).catch(e => post({ type: 'error', id: c.id, modelId: c.modelId, message: `Could not load ${c.modelId}. ${e instanceof Error ? e.message : String(e)}` }))
    return
  }
  canceled.delete(c.id); controllers.set(c.id, new AbortController()); chain = chain.then(() => run(c)).catch(e => post({ type: 'error', id: c.id, modelId: c.modelId, message: String(e) }))
}
