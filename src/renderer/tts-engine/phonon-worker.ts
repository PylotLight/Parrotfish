import { WsolaStretcher } from '../../shared/phonon-stretch'
import type { EngineCommand, EngineEvent } from '../../shared/tts-engine'

interface PhononSpeech extends AsyncIterable<Float32Array> {
  readonly done: Promise<{ firstAudioMs?: number | null; cancelled: boolean }>
  cancel(): void
}
interface PhononInstance {
  readonly sampleRate: number
  readonly voices: string[]
  readonly threads: number
  readonly device: string
  addVoice(name: string, source: string): Promise<void>
  stream(text: string, options?: { voice?: string; temperature?: number; seed?: number; signal?: AbortSignal }): PhononSpeech
  dispose(): void
}
interface PhononModule { PhononTTS: { load(options: Record<string, unknown>): Promise<PhononInstance> } }
type SpeakCommand = Extract<EngineCommand, { type: 'speak' }>
const ORIGIN = self.location.origin
let phonon: { tts: PhononInstance; delta: number } | null = null
let loading: Promise<PhononInstance> | null = null
const controllers = new Map<number, AbortController>()

/** duration_delta is a load-time condition, so changing speed requires a fresh instance. */
async function load(delta: number, requestId?: number): Promise<PhononInstance> {
  if (phonon?.delta === delta) {
    if (requestId !== undefined) post({ type: 'loaded', requestId, loadMs: 0, threads: phonon.tts.threads, device: phonon.tts.device, isolated: self.crossOriginIsolated === true })
    return phonon.tts
  }
  while (loading) await loading.catch(() => undefined)
  if (phonon?.delta === delta) {
    if (requestId !== undefined) post({ type: 'loaded', requestId, loadMs: 0, threads: phonon.tts.threads, device: phonon.tts.device, isolated: self.crossOriginIsolated === true })
    return phonon.tts
  }
  phonon?.tts.dispose()
  phonon = null
  const started = performance.now()
  const run = (async () => {
    // Preserve the exact downloaded phonon-tts 0.4.0 runtime and 31M q8 assets.
    const module = (await import(/* @vite-ignore */ `${ORIGIN}/runtime/index.js`)) as PhononModule
    const model = `${ORIGIN}/model/`
    const tts = await module.PhononTTS.load({
      lang: 'en', quant: 'q8', cache: false,
      model: {
        weights: { q8: `${model}model.q8.gguf` },
        tokenizer: `${model}tokenizer.json`,
        config: `${model}config.json`,
        voices: { default: `${model}default-voice.safetensors` },
        defaultVoice: 'default'
      },
      rewrites: 'default', device: 'cpu', threads: 'auto',
      conditions: { duration_delta: delta },
      wasmUrl: `${ORIGIN}/runtime/wasm/phonon_tts_bg.wasm`,
      threadsWasmUrl: `${ORIGIN}/runtime/wasm-threads/phonon_tts_bg.wasm`
    })
    phonon = { tts, delta }
    post({ type: 'loaded', loadMs: Math.round(performance.now() - started), threads: tts.threads, device: tts.device, isolated: self.crossOriginIsolated === true, ...(requestId !== undefined ? { requestId } : {}) })
    return tts
  })()
  loading = run
  try { return await run } finally { if (loading === run) loading = null }
}
function post(event: EngineEvent): void { self.postMessage(event) }

async function speak(command: SpeakCommand): Promise<void> {
  const controller = controllers.get(command.id)
  if (!controller || controller.signal.aborted) return
  const started = performance.now()
  let firstAudioMs: number | null = null
  try {
    const tts = await load(command.durationDelta)
    if (controller.signal.aborted) return
    let voice = 'default'
    if (command.voice.id !== 'default' && /^[\w-]{1,40}$/.test(command.voice.id)) {
      if (!tts.voices.includes(command.voice.id)) await tts.addVoice(command.voice.id, `${ORIGIN}/model/${command.voice.file}`)
      voice = command.voice.id
    }
    if (controller.signal.aborted) return
    const speech = tts.stream(command.text, {
      voice, signal: controller.signal,
      ...(typeof command.temperature === 'number' ? { temperature: command.temperature } : {}),
      ...(typeof command.seed === 'number' ? { seed: command.seed } : {})
    })
    const stretcher = command.stretch !== 1 ? new WsolaStretcher(command.stretch, tts.sampleRate) : null
    try {
      for await (const pcm of speech) {
        if (controller.signal.aborted) break
        const out = stretcher ? stretcher.push(pcm) : pcm
        if (!out.length) continue
        firstAudioMs ??= Math.round(performance.now() - started)
        post({ type: 'chunk', id: command.id, samples: out, sampleRate: tts.sampleRate })
      }
      if (stretcher && !controller.signal.aborted) {
        const tail = stretcher.flush()
        if (tail.length) post({ type: 'chunk', id: command.id, samples: tail, sampleRate: tts.sampleRate })
      }
    } finally { if (controller.signal.aborted) speech.cancel() }
    post({ type: 'done', id: command.id, firstAudioMs })
  } catch (error) {
    post({ type: 'error', id: command.id, message: error instanceof Error ? error.message : String(error) })
  } finally { controllers.delete(command.id) }
}
let chain: Promise<void> = Promise.resolve()
self.onmessage = (event: MessageEvent<EngineCommand>) => {
  const command = event.data
  if (command.type === 'cancel') { controllers.get(command.id)?.abort(); return }
  if (command.type === 'warm') {
    chain = chain.then(async () => {
      try { await load(command.durationDelta, command.requestId) }
      catch (error) { post({ type: 'warm-error', requestId: command.requestId, message: error instanceof Error ? error.message : String(error) }) }
    })
    return
  }
  if (command.type === 'speak') {
    // Register now, not when dequeued, so cancellation while queued suppresses inference.
    controllers.set(command.id, new AbortController())
    chain = chain.then(() => speak(command)).catch((error) => {
      post({ type: 'error', id: command.id, message: error instanceof Error ? error.message : String(error) })
    })
  }
}
