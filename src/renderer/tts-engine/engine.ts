// Phonon engine page (hidden, cross-origin isolated so the threaded wasm build runs). Loads the
// official phonon-tts 0.4.0 build that main downloaded (served under /runtime/ and /model/ on the
// parrotfish-tts:// scheme), speaks one sentence at a time and streams float PCM back to main.
// Unlike Surffish's Read Aloud engine it plays nothing itself: the app window's player does, so
// every TTS provider shares one audio path and one first-audio clock. Engine core ported from
// Surffish PR #290 (src/renderer/src/read-aloud/engine.ts).
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
interface PhononModule {
  PhononTTS: { load(options: Record<string, unknown>): Promise<PhononInstance> }
}
interface Bridge {
  onCommand(cb: (c: EngineCommand) => void): void
  send(e: EngineEvent): void
}

const bridge = (window as unknown as { parrotfishEngine?: Bridge }).parrotfishEngine
const ORIGIN = location.origin

let phonon: { tts: PhononInstance; delta: number } | null = null
let loading: Promise<PhononInstance> | null = null

/** duration_delta is a load-time condition, so a new speed means a fresh instance (files come from disk). */
async function load(delta: number): Promise<PhononInstance> {
  if (phonon && phonon.delta === delta) return phonon.tts
  while (loading) await loading.catch(() => undefined)
  if (phonon && phonon.delta === delta) return phonon.tts
  phonon?.tts.dispose()
  phonon = null
  const started = performance.now()
  const run = (async () => {
    const module = (await import(/* @vite-ignore */ `${ORIGIN}/runtime/index.js`)) as PhononModule
    const model = `${ORIGIN}/model/`
    const tts = await module.PhononTTS.load({
      lang: 'en',
      quant: 'q8',
      cache: false,
      model: {
        weights: { q8: `${model}model.q8.gguf` },
        tokenizer: `${model}tokenizer.json`,
        config: `${model}config.json`,
        voices: { default: `${model}default-voice.safetensors` },
        defaultVoice: 'default'
      },
      rewrites: 'default',
      device: 'cpu',
      threads: 'auto',
      conditions: { duration_delta: delta },
      wasmUrl: `${ORIGIN}/runtime/wasm/phonon_tts_bg.wasm`,
      threadsWasmUrl: `${ORIGIN}/runtime/wasm-threads/phonon_tts_bg.wasm`
    })
    phonon = { tts, delta }
    bridge?.send({ type: 'loaded', loadMs: Math.round(performance.now() - started), threads: tts.threads, device: tts.device, isolated: self.crossOriginIsolated === true })
    return tts
  })()
  loading = run
  try {
    return await run
  } finally {
    if (loading === run) loading = null
  }
}

const controllers = new Map<number, AbortController>()
let chain: Promise<void> = Promise.resolve()

async function speak(command: Extract<EngineCommand, { type: 'speak' }>): Promise<void> {
  const controller = controllers.get(command.id)
  if (!controller || controller.signal.aborted) return
  const started = performance.now()
  let firstAudioMs: number | null = null
  try {
    const tts = await load(command.durationDelta)
    let voice = 'default'
    if (command.voice.id !== 'default' && /^[\w-]{1,40}$/.test(command.voice.id)) {
      if (!tts.voices.includes(command.voice.id)) await tts.addVoice(command.voice.id, `${ORIGIN}/model/${command.voice.file}`)
      voice = command.voice.id
    }
    const speech = tts.stream(command.text, {
      voice,
      signal: controller.signal,
      ...(typeof command.temperature === 'number' ? { temperature: command.temperature } : {}),
      ...(typeof command.seed === 'number' ? { seed: command.seed } : {})
    })
    const stretcher = command.stretch !== 1 ? new WsolaStretcher(command.stretch, tts.sampleRate) : null
    try {
      for await (const pcm of speech) {
        if (controller.signal.aborted) break
        const out = stretcher ? stretcher.push(pcm) : pcm
        if (out.length === 0) continue
        firstAudioMs ??= Math.round(performance.now() - started)
        bridge?.send({ type: 'chunk', id: command.id, samples: out, sampleRate: tts.sampleRate })
      }
      if (stretcher && !controller.signal.aborted) {
        const tail = stretcher.flush()
        if (tail.length) bridge?.send({ type: 'chunk', id: command.id, samples: tail, sampleRate: tts.sampleRate })
      }
    } finally {
      if (controller.signal.aborted) speech.cancel()
    }
    bridge?.send({ type: 'done', id: command.id, firstAudioMs })
  } catch (error) {
    bridge?.send({ type: 'error', id: command.id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    controllers.delete(command.id)
  }
}

bridge?.onCommand((command) => {
  if (command.type === 'cancel') {
    controllers.get(command.id)?.abort()
    return
  }
  if (command.type === 'speak') {
    controllers.set(command.id, new AbortController())
    chain = chain.then(() => speak(command))
  }
})

bridge?.send({ type: 'ready' })
