// Provider registry: stage -> provider id -> factory. Add a provider by writing one file under
// providers/<stage>/ and listing it here; the settings UI reads `describeProviders()`.
import type { Profile, Stage } from '../shared/profile'
import { mockBrain } from './providers/brain/mock'
import { openaiChat } from './providers/brain/openai-chat'
import { claudeCode, codexExec } from './providers/escalation/cli-agent'
import { mockEscalation } from './providers/escalation/mock'
import { alwaysReply } from './providers/router/always'
import { llmRouter } from './providers/router/llm-router'
import { mockRouter } from './providers/router/mock'
import { systemOneRouter } from './providers/router/systemone'
import { mockStt } from './providers/stt/mock'
import { openaiTranscriptions } from './providers/stt/openai-transcriptions'
import { parakeetStt } from './providers/stt/parakeet'
import { sherpaOnnxStt } from './providers/stt/sherpa-onnx'
import { whisperCppStt } from './providers/stt/whisper-cpp'
import { mockTools } from './providers/tools/mock'
import { openaiTools } from './providers/tools/openai-tools'
import { macosSay } from './providers/tts/macos-say'
import { mockTts } from './providers/tts/mock'
import { openaiSpeech } from './providers/tts/openai-speech'
import { phononWasm } from './providers/tts/phonon-wasm'
import { pttsOpenai } from './providers/tts/ptts-openai'
import { pttsWs } from './providers/tts/ptts-ws'
import type { BrainProvider, EscalationProvider, ProviderFactory, RouterProvider, SttProvider, ToolCallerProvider, TtsProvider, VadProvider } from './providers/types'
import { energyVad } from './providers/vad/energy'
import { sileroVad } from './providers/vad/silero'

interface Entry<T> {
  factory: ProviderFactory<T>
  label: string
  /** Options the settings form offers, with defaults (the raw JSON editor takes anything). */
  options: Record<string, string | number | boolean>
}

const none: ProviderFactory<never> = () => {
  throw new Error('stage disabled')
}

export const REGISTRY = {
  vad: {
    silero: { factory: sileroVad, label: 'Silero VAD v6 (onnxruntime)', options: {} },
    energy: { factory: energyVad, label: 'Energy (RMS) fallback', options: { floor: 0.004, ceiling: 0.04 } }
  } satisfies Record<string, Entry<VadProvider>>,
  stt: {
    parakeet: { factory: parakeetStt, label: 'Parakeet TDT v2 (parakeet-api mlx, :8816)', options: { baseUrl: 'http://127.0.0.1:8816/v1', model: 'mlx-community/parakeet-tdt-0.6b-v2', language: '' } },
    'whisper-cpp': { factory: whisperCppStt, label: 'whisper.cpp server (/inference)', options: { baseUrl: 'http://127.0.0.1:8090', language: '' } },
    'openai-transcriptions': { factory: openaiTranscriptions, label: 'OpenAI-compatible /v1/audio/transcriptions', options: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', apiKey: '', language: '' } },
    'sherpa-onnx': { factory: sherpaOnnxStt, label: 'sherpa-onnx in-process (optional, unverified)', options: { encoder: '', decoder: '', joiner: '', tokens: '', threads: 2 } },
    mock: { factory: mockStt, label: 'Mock', options: { delayMs: 120, text: 'what time is it' } }
  } satisfies Record<string, Entry<SttProvider>>,
  router: {
    systemone: { factory: systemOneRouter, label: 'System One decision model (llama-server /v1/systemone)', options: { baseUrl: 'http://127.0.0.1:8082', model: '' } },
    'llm-router': { factory: llmRouter, label: 'LLM as router (constrained JSON, any chat endpoint)', options: { baseUrl: 'http://127.0.0.1:8081/v1', model: 'local', apiKey: '' } },
    none: { factory: alwaysReply, label: 'None (always reply locally)', options: {} },
    mock: { factory: mockRouter, label: 'Mock (keyword rules)', options: { delayMs: 15 } }
  } satisfies Record<string, Entry<RouterProvider>>,
  tools: {
    'openai-tools': { factory: openaiTools, label: 'OpenAI tool calling (llama-server --jinja)', options: { baseUrl: 'http://127.0.0.1:8083/v1', model: 'local', temperature: 0 } },
    none: { factory: none as ProviderFactory<ToolCallerProvider>, label: 'None (device actions go to the brain)', options: {} },
    mock: { factory: mockTools, label: 'Mock (keyword rules)', options: { delayMs: 60 } }
  } satisfies Record<string, Entry<ToolCallerProvider>>,
  brain: {
    'openai-chat': { factory: openaiChat, label: 'OpenAI-compatible streaming chat', options: { baseUrl: 'http://127.0.0.1:8081/v1', model: 'local', temperature: 0.6, maxTokens: 300, apiKey: '', thinking: false } },
    mock: { factory: mockBrain, label: 'Mock', options: { delayMs: 180, tokenMs: 25 } }
  } satisfies Record<string, Entry<BrainProvider>>,
  escalation: {
    'claude-code': { factory: claudeCode, label: 'Claude Code (claude -p, stream-json)', options: { command: 'claude', cwd: '~' } },
    codex: { factory: codexExec, label: 'Codex (codex exec --json)', options: { command: 'codex', cwd: '~' } },
    none: { factory: none as ProviderFactory<EscalationProvider>, label: 'None (escalations go to the brain)', options: {} },
    mock: { factory: mockEscalation, label: 'Mock', options: { delayMs: 300 } }
  } satisfies Record<string, Entry<EscalationProvider>>,
  tts: {
    'phonon-wasm': { factory: phononWasm, label: 'Phonon 31m in-process (WASM)', options: { voice: 'default', speed: 1, temperature: 0.3 } },
    'ptts-openai': { factory: pttsOpenai, label: 'Phonon via ptts-openai-server (:8880)', options: { baseUrl: 'http://127.0.0.1:8880/v1', voice: 'default' } },
    'ptts-ws': { factory: pttsWs, label: 'Phonon via ptts-ws-server (WebSocket)', options: { url: 'ws://127.0.0.1:8080/speech/tts', voice: '' } },
    'openai-speech': { factory: openaiSpeech, label: 'OpenAI-compatible /v1/audio/speech', options: { baseUrl: 'http://127.0.0.1:8880/v1', model: 'tts-1', voice: 'alloy', format: 'pcm', sampleRate: 24000, speed: 1, apiKey: '' } },
    'macos-say': { factory: macosSay, label: 'macOS say', options: { voice: '', rate: 200 } },
    mock: { factory: mockTts, label: 'Mock (tone)', options: { delayMs: 80, msPerChar: 55 } }
  } satisfies Record<string, Entry<TtsProvider>>
} as const

type StageProviders = {
  vad: VadProvider
  stt: SttProvider
  router: RouterProvider
  tools: ToolCallerProvider
  brain: BrainProvider
  escalation: EscalationProvider
  tts: TtsProvider
}

/** Stages whose `none` provider means "skip this stage". */
export function isDisabled(profile: Profile, stage: Stage): boolean {
  return profile[stage].provider === 'none' && (stage === 'tools' || stage === 'escalation')
}

export function createProvider<S extends Stage>(stage: S, profile: Profile): StageProviders[S] {
  const config = profile[stage]
  const entries = REGISTRY[stage] as Record<string, Entry<StageProviders[S]>>
  const entry = entries[config.provider]
  if (!entry) throw new Error(`unknown ${stage} provider "${config.provider}" (have: ${Object.keys(entries).join(', ')})`)
  return entry.factory(config.options)
}

export interface ProviderInfo {
  id: string
  label: string
  options: Record<string, string | number | boolean>
}

export function describeProviders(): Record<Stage, ProviderInfo[]> {
  const out = {} as Record<Stage, ProviderInfo[]>
  for (const [stage, entries] of Object.entries(REGISTRY)) {
    out[stage as Stage] = Object.entries(entries as Record<string, Entry<unknown>>).map(([id, e]) => ({ id, label: e.label, options: e.options }))
  }
  return out
}
