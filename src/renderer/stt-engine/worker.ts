import * as ort from 'onnxruntime-web'
import { fromUrls } from 'parakeet.js'
import type { SttCommand, SttEvent } from '../../shared/stt-engine'

type Model = Awaited<ReturnType<typeof fromUrls>>
const origin = self.location.origin
const modelBase = `${origin}/model/`
const wasmPaths = `${origin}/ort/`
// 1.4.4's initOrt accepts but does not apply wasmPaths; set it explicitly before loading.
ort.env.wasm.wasmPaths = wasmPaths
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2)
ort.env.wasm.initTimeout = 30_000
const files = {
  encoderUrl: `${modelBase}encoder-model.int8.onnx`,
  decoderUrl: `${modelBase}decoder_joint-model.int8.onnx`,
  tokenizerUrl: `${modelBase}vocab.txt`,
}
const gpuFiles = { ...files, encoderUrl: `${modelBase}encoder-model.onnx`, encoderDataUrl: `${modelBase}encoder-model.onnx.data`, filenames: { encoder: 'encoder-model.onnx', decoder: 'decoder_joint-model.int8.onnx' } }
const options = (backend: 'webgpu' | 'wasm') => ({ ...files, backend, preprocessorBackend: 'js' as const, nMels: 128, wasmPaths, cpuThreads: Math.min(4, navigator.hardwareConcurrency || 2) })
let model: Model | null = null
let backend = ''
let gpuSelected = false
let chain: Promise<void> = Promise.resolve()
const controllers = new Map<number, AbortController>()
const canceled = new Set<number>()
const gpuWaiters = new Map<number, { resolve(): void; reject(error: Error): void }>()
let nextGpuId = 0
function requestGpuAssets(): Promise<void> {
  const id = ++nextGpuId
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { gpuWaiters.delete(id); reject(new Error('GPU encoder download timed out')) }, 600_000)
    gpuWaiters.set(id, { resolve: () => { clearTimeout(timer); resolve() }, reject: error => { clearTimeout(timer); reject(error) } })
    post({ type: 'gpu-assets', id })
  })
}
function post(e: SttEvent): void { self.postMessage(e) }
function release(m: Model): void {
  // parakeet.js 1.4.4 does not publish a model.dispose(); its sessions expose release().
  const internals = m as unknown as { encoderSession?: { release?: () => void }; joinerSession?: { release?: () => void }; _combState1?: { dispose?: () => void }; _combState2?: { dispose?: () => void }; _targetTensor?: { dispose?: () => void }; _targetLenTensor?: { dispose?: () => void } }
  internals.encoderSession?.release?.()
  internals.joinerSession?.release?.()
  internals._combState1?.dispose?.(); internals._combState2?.dispose?.()
  internals._targetTensor?.dispose?.(); internals._targetLenTensor?.dispose?.()
}
async function create(backend: 'webgpu' | 'wasm'): Promise<Model> {
  return fromUrls(options(backend))
}
async function load(): Promise<Model> {
  if (model) return model
  post({ type: 'status', state: 'loading', detail: 'Loading Parakeet TDT 0.6B v2 (English), 128-mel configuration' })
  let gpuReason = 'WebGPU is unavailable'
  if ('gpu' in navigator) {
    let candidate: Model | undefined
    let cpu: Model | undefined
    try {
      const adapter = await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter()
      if (adapter) {
        post({ type: 'status', state: 'loading', detail: 'WebGPU trial requires ~2.5 GB of additional cached v2 weights; downloading and verifying full-precision encoder.' })
        await requestGpuAssets()
        // Strict mode avoids ORT silently replacing a failed WebGPU encoder with WASM.
        candidate = await fromUrls({ ...options('webgpu'), ...gpuFiles, backend: 'webgpu-strict' })
        const probe = new Float32Array(16000) // bounded one-second silence probe
        post({ type: 'status', state: 'benchmarking', backend: 'WebGPU encoder + WASM decoder', detail: 'Warm-up, then comparing one-second inference against WASM CPU' })
        await candidate.transcribe(probe, 16000)
        const gpuStart = performance.now(); await candidate.transcribe(probe, 16000); const gpuMs = performance.now() - gpuStart
        cpu = await create('wasm')
        await cpu.transcribe(probe, 16000)
        const cpuStart = performance.now(); await cpu.transcribe(probe, 16000); const cpuMs = performance.now() - cpuStart
        if (gpuMs < cpuMs) {
          release(cpu); model = candidate; candidate = undefined; gpuSelected = true; backend = 'WebGPU encoder + WASM decoder'
          post({ type: 'status', state: 'ready', backend, detail: `Selected after warmed one-second probe (${Math.round(gpuMs)} ms GPU vs ${Math.round(cpuMs)} ms CPU).` })
          return model
        }
        gpuReason = `WebGPU was slower in warmed probe (${Math.round(gpuMs)} ms vs CPU ${Math.round(cpuMs)} ms)`
        model = cpu; cpu = undefined
      } else gpuReason = 'No WebGPU adapter was available'
    } catch (e) { gpuReason = `WebGPU initialization or probe failed: ${e instanceof Error ? e.message : String(e)}` }
    if (candidate) release(candidate)
    if (cpu) release(cpu)
  }
  if (!model) model = await create('wasm')
  gpuSelected = false; backend = 'WASM CPU'
  post({ type: 'status', state: 'ready', backend, detail: `${gpuReason}; using WASM CPU.` })
  return model
}
async function fallbackToCpu(reason: string): Promise<Model> {
  if (model) release(model)
  model = await create('wasm')
  gpuSelected = false; backend = 'WASM CPU (fallback after WebGPU failure)'
  post({ type: 'status', state: 'ready', backend, detail: `WebGPU inference failed (${reason}); retried with WASM CPU.` })
  return model
}
async function run(c: Extract<SttCommand, { type: 'transcribe' }>): Promise<void> {
  const ctrl = controllers.get(c.id)
  if (!ctrl || ctrl.signal.aborted || canceled.has(c.id)) { controllers.delete(c.id); canceled.delete(c.id); return }
  try {
    let m = await load()
    if (ctrl.signal.aborted || canceled.has(c.id)) return
    if (c.sampleRate !== 16000) throw new Error('Parakeet expects 16 kHz mono PCM; resample audio before transcription.')
    let result
    try { result = await m.transcribe(c.samples, 16000) }
    catch (e) {
      if (!gpuSelected || ctrl.signal.aborted || canceled.has(c.id)) throw e
      m = await fallbackToCpu(e instanceof Error ? e.message : String(e))
      if (ctrl.signal.aborted || canceled.has(c.id)) return
      result = await m.transcribe(c.samples, 16000)
    }
    if (!ctrl.signal.aborted && !canceled.has(c.id)) post({ type: 'result', id: c.id, text: result.utterance_text ?? '' })
  } catch (e) {
    if (!ctrl.signal.aborted && !canceled.has(c.id)) post({ type: 'error', id: c.id, message: e instanceof Error ? e.message : String(e) })
  } finally { controllers.delete(c.id); canceled.delete(c.id) }
}
self.onmessage = (event: MessageEvent<SttCommand>) => {
  const c = event.data
  if (c.type === 'gpu-assets-ready') { const waiter = gpuWaiters.get(c.id); if (waiter) { gpuWaiters.delete(c.id); if (c.error) waiter.reject(new Error(c.error)); else waiter.resolve() } return }
  if (c.type === 'cancel') { canceled.add(c.id); controllers.get(c.id)?.abort(); return }
  if (c.type === 'warm') {
    chain = chain.then(async () => { await load(); post({ type: 'warmed', id: c.id }) }).catch(e => post({ type: 'error', id: c.id, message: `Could not load Parakeet v2. ${e instanceof Error ? e.message : String(e)}` }))
    return
  }
  canceled.delete(c.id); controllers.set(c.id, new AbortController())
  chain = chain.then(() => run(c)).catch(e => post({ type: 'error', id: c.id, message: String(e) }))
}
