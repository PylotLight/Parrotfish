// Profiles: one named JSON document per voice-agent stack. Every stage names a provider id from the
// registry (src/core/registry.ts) plus that provider's options. Stored as <userData>/profiles/<name>.json.
import { ROUTER_CHOICES, type RouterChoice } from './types'
import { DEFAULT_LOCAL_STT_MODEL } from './local-stt-models'

export interface StageConfig {
  provider: string
  options: Record<string, unknown>
}

export interface RouterConfig extends StageConfig {
  /** Below this confidence the router's pick is replaced by `fallback`. */
  threshold: number
  fallback: RouterChoice
  /** Also ask "is the user done talking?" (noul). Below 0.5 the turn waits for more speech. */
  askEndOfTurn: boolean
  /** While the agent speaks, ask "is this a real interruption?" before cancelling (else cancel on speech start). */
  askBargeIn: boolean
}

export interface VadConfig extends StageConfig {
  /** Speech probability to start / keep a segment. */
  threshold: number
  /** Silence that ends a segment. */
  minSilenceMs: number
  /** Shorter segments are dropped (coughs, clicks). */
  minSpeechMs: number
  /** Audio kept before the detected start. */
  padMs: number
}

export interface SplitterConfig {
  /** A sentence shorter than this is merged into the next one (avoids choppy "Ok." chunks). */
  minChars: number
  /** A run-on longer than this is cut at the last comma/space. */
  maxChars: number
  /** Speak the first clause early (at a comma) to cut time-to-first-audio. */
  eagerFirstClause: boolean
}

/** A local server a provider needs, started and health-checked by the sidecar manager. */
export interface SidecarConfig {
  id: string
  label: string
  /** Run through the user's login shell (`$SHELL -lc`), so brew/uv paths work. */
  command: string
  cwd?: string
  /** GET this until it answers (any status < 500) to call it healthy. */
  healthUrl?: string
  autoStart: boolean
}

export interface ToolsConfig extends StageConfig {
  enabled: string[]
  /** Legacy compatibility only; never grants shell execution. */
  shellAllowlist: string[]
}

export interface BrainConfig extends StageConfig {
  systemPrompt: string
  maxHistoryTurns: number
}

export interface Profile {
  name: string
  description: string
  vad: VadConfig
  stt: StageConfig
  router: RouterConfig
  tools: ToolsConfig
  brain: BrainConfig
  escalation: StageConfig
  tts: StageConfig
  splitter: SplitterConfig
  sidecars: SidecarConfig[]
}

export const STAGES = ['vad', 'stt', 'router', 'tools', 'brain', 'escalation', 'tts'] as const
export type Stage = (typeof STAGES)[number]

export const DEFAULT_SPLITTER: SplitterConfig = { minChars: 12, maxChars: 220, eagerFirstClause: true }

export const DEFAULT_SYSTEM_PROMPT =
  'You are Parrotfish, a voice assistant running on this Mac. Answer in one to three short spoken sentences. No markdown, no lists, no emoji.'

export const DEMO_TOOLS = ['open_app', 'get_time', 'create_note'] as const

const SHELL_ALLOWLIST: string[] = []

/** The Mac stack from the README "getting started": Parakeet, Kev-0.8B, LFM2 tools, Qwen3 4B, Phonon 31m in-process. */
export function defaultProfile(): Profile {
  return {
    name: 'default',
    description: 'On-device stack: Silero VAD, Parakeet TDT v2 (parakeet-api mlx), Kev-0.8B router, LFM2-1.2B-Tool, Qwen3-4B brain, Claude Code escalation, Phonon 31m in-process.',
    vad: { provider: 'silero', options: {}, threshold: 0.5, minSilenceMs: 450, minSpeechMs: 200, padMs: 200 },
    stt: { provider: 'parakeet', options: { baseUrl: 'http://127.0.0.1:8816/v1', model: 'mlx-community/parakeet-tdt-0.6b-v2' } },
    router: { provider: 'systemone', options: { baseUrl: 'http://127.0.0.1:8082' }, threshold: 0.55, fallback: 'reply_local', askEndOfTurn: false, askBargeIn: false },
    tools: { provider: 'openai-tools', options: { baseUrl: 'http://127.0.0.1:8083/v1', model: 'lfm2-1.2b-tool' }, enabled: [...DEMO_TOOLS], shellAllowlist: SHELL_ALLOWLIST },
    brain: { provider: 'openai-chat', options: { baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3-4b-instruct-2507', temperature: 0.6 }, systemPrompt: DEFAULT_SYSTEM_PROMPT, maxHistoryTurns: 6 },
    escalation: { provider: 'claude-code', options: { command: 'claude', cwd: '~', extraArgs: [] } },
    tts: { provider: 'phonon-wasm', options: { voice: 'default', speed: 1.1, temperature: 0.3 } },
    splitter: { ...DEFAULT_SPLITTER },
    sidecars: [
      { id: 'parakeet', label: 'Parakeet STT (:8816)', command: 'env STT__MLX__MODEL_ID=mlx-community/parakeet-tdt-0.6b-v2 parakeet-api serve', healthUrl: 'http://127.0.0.1:8816/v1/models', autoStart: false },
      { id: 'router', label: 'Kev-0.8B router (:8082)', command: 'llama-server -hf ggml-org/Kev-0.8B-GGUF:Q8_0 --port 8082', healthUrl: 'http://127.0.0.1:8082/health', autoStart: false },
      { id: 'brain', label: 'Qwen3-4B brain (:8081)', command: 'llama-server -hf unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M --jinja -c 8192 --port 8081', healthUrl: 'http://127.0.0.1:8081/health', autoStart: false },
      { id: 'tools', label: 'LFM2-1.2B-Tool (:8083)', command: 'llama-server -hf LiquidAI/LFM2-1.2B-Tool-GGUF:Q4_K_M --jinja --port 8083', healthUrl: 'http://127.0.0.1:8083/health', autoStart: false }
    ]
  }
}

/** Everything mocked: runs with no servers, models or mic. The test suite and CI use the same providers. */
export function mockProfile(): Profile {
  const base = defaultProfile()
  return {
    ...base,
    name: 'Mock',
    description: 'Every stage mocked with fixed delays: no servers, models or network. Good for checking the UI and the waterfall.',
    vad: { ...base.vad, provider: 'energy' },
    stt: { provider: 'mock', options: { delayMs: 120, text: 'what time is it' } },
    router: { ...base.router, provider: 'mock', options: { delayMs: 15 } },
    tools: { ...base.tools, provider: 'mock', options: { delayMs: 60 } },
    brain: { ...base.brain, provider: 'mock', options: { delayMs: 180, tokenMs: 25 } },
    escalation: { provider: 'mock', options: { delayMs: 300 } },
    tts: { provider: 'mock', options: { delayMs: 80, msPerChar: 55 } },
    sidecars: []
  }
}

/** The usual baseline: energy VAD, whisper.cpp, the brain model as router, macOS `say`. */
export function baselineProfile(): Profile {
  const base = defaultProfile()
  return {
    ...base,
    name: 'baseline',
    description: 'Baseline to beat: energy VAD, whisper.cpp server, the brain model as router (constrained JSON), macOS say.',
    vad: { ...base.vad, provider: 'energy' },
    stt: { provider: 'whisper-cpp', options: { baseUrl: 'http://127.0.0.1:8090' } },
    router: { ...base.router, provider: 'llm-router', options: { baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3-4b-instruct-2507' } },
    tts: { provider: 'macos-say', options: { voice: '', rate: 200 } },
    sidecars: [
      { id: 'whisper', label: 'whisper.cpp (:8090)', command: 'whisper-server -m ~/models/ggml-large-v3-turbo.bin --port 8090', healthUrl: 'http://127.0.0.1:8090/', autoStart: false },
      base.sidecars[2]!
    ]
  }
}

/** Narrow real-inference loop: repeat the transcript, no language model or device actions. */
export function localLoopProfile(): Profile {
  const base = defaultProfile()
  return {
    ...base,
    name: 'Local loop',
    description: 'No-sidecar mic → Parakeet TDT 0.6B v2 → repeat transcript → CPU Phonon 31m. This is a speech loop, not a conversational brain.',
    vad: { ...base.vad, provider: 'energy' },
    stt: { provider: 'parakeet-local', options: { model: DEFAULT_LOCAL_STT_MODEL } },
    router: { ...base.router, provider: 'none', options: {}, askEndOfTurn: false, askBargeIn: false },
    brain: { ...base.brain, provider: 'echo', options: {}, maxHistoryTurns: 0 },
    tools: { ...base.tools, provider: 'none', options: {}, enabled: [] },
    escalation: { provider: 'none', options: {} },
    sidecars: []
  }
}

export const BUILTIN_PROFILES = [localLoopProfile, defaultProfile, mockProfile, baselineProfile] as const

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function strList(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback
}
function stage<T extends StageConfig>(v: unknown, fallback: T): T {
  const raw = obj(v)
  const sameProvider = raw.provider === undefined || raw.provider === fallback.provider
  return { ...fallback, provider: str(raw.provider, fallback.provider), options: raw.options === undefined && sameProvider ? { ...fallback.options } : { ...obj(raw.options) } }
}

export function isRouterChoice(v: unknown): v is RouterChoice {
  return typeof v === 'string' && (ROUTER_CHOICES as readonly string[]).includes(v)
}

export const PROFILE_NAME = /^\w[\w .-]{0,47}$/

export interface ProfileIssue {
  path: string
  message: string
}

/**
 * Parse anything (a file, the raw JSON editor) into a full Profile: missing fields come from the
 * fallback, out-of-range numbers are clamped. `issues` says what was replaced, so the editor
 * can show it instead of silently fixing it.
 */
export function parseProfile(value: unknown, fallback: Profile = defaultProfile()): { profile: Profile; issues: ProfileIssue[] } {
  const issues: ProfileIssue[] = []
  const raw = obj(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) issues.push({ path: '', message: 'profile must be a JSON object' })
  const name = str(raw.name, fallback.name).trim()
  if (!PROFILE_NAME.test(name)) issues.push({ path: 'name', message: 'name: letters, digits, space . _ - (max 48)' })
  for (const key of STAGES) {
    if (raw[key] !== undefined && typeof obj(raw[key]).provider !== 'string') issues.push({ path: `${key}.provider`, message: `${key}.provider missing, using ${fallback[key].provider}` })
  }
  const vadRaw = obj(raw.vad)
  const routerRaw = obj(raw.router)
  const toolsRaw = obj(raw.tools)
  const brainRaw = obj(raw.brain)
  const splitRaw = obj(raw.splitter)
  const fallbackChoice = isRouterChoice(routerRaw.fallback) ? routerRaw.fallback : fallback.router.fallback
  if (routerRaw.fallback !== undefined && !isRouterChoice(routerRaw.fallback)) issues.push({ path: 'router.fallback', message: `router.fallback must be one of ${ROUTER_CHOICES.join(', ')}` })
  const sidecars = Array.isArray(raw.sidecars)
    ? raw.sidecars.flatMap((s, i): SidecarConfig[] => {
        const r = obj(s)
        if (typeof r.command !== 'string' || !r.command.trim()) {
          issues.push({ path: `sidecars[${i}].command`, message: 'sidecar needs a command' })
          return []
        }
        const id = str(r.id, `sidecar-${i + 1}`).replace(/[^\w-]/g, '-').slice(0, 40) || `sidecar-${i + 1}`
        return [{ id, label: str(r.label, id), command: r.command, cwd: typeof r.cwd === 'string' ? r.cwd : undefined, healthUrl: typeof r.healthUrl === 'string' ? r.healthUrl : undefined, autoStart: bool(r.autoStart, false) }]
      })
    : fallback.sidecars
  const profile: Profile = {
    name: PROFILE_NAME.test(name) ? name : fallback.name,
    description: str(raw.description, fallback.description),
    vad: {
      ...stage(raw.vad, fallback.vad),
      threshold: num(vadRaw.threshold, fallback.vad.threshold, 0.05, 0.95),
      minSilenceMs: num(vadRaw.minSilenceMs, fallback.vad.minSilenceMs, 64, 5000),
      minSpeechMs: num(vadRaw.minSpeechMs, fallback.vad.minSpeechMs, 0, 5000),
      padMs: num(vadRaw.padMs, fallback.vad.padMs, 0, 1000)
    },
    stt: stage(raw.stt, fallback.stt),
    router: {
      ...stage(raw.router, fallback.router),
      threshold: num(routerRaw.threshold, fallback.router.threshold, 0, 1),
      fallback: fallbackChoice,
      askEndOfTurn: bool(routerRaw.askEndOfTurn, fallback.router.askEndOfTurn),
      askBargeIn: bool(routerRaw.askBargeIn, fallback.router.askBargeIn)
    },
    tools: { ...stage(raw.tools, fallback.tools), enabled: strList(toolsRaw.enabled, fallback.tools.enabled), shellAllowlist: strList(toolsRaw.shellAllowlist, fallback.tools.shellAllowlist) },
    brain: {
      ...stage(raw.brain, fallback.brain),
      systemPrompt: str(brainRaw.systemPrompt, fallback.brain.systemPrompt),
      maxHistoryTurns: Math.round(num(brainRaw.maxHistoryTurns, fallback.brain.maxHistoryTurns, 0, 50))
    },
    escalation: stage(raw.escalation, fallback.escalation),
    tts: stage(raw.tts, fallback.tts),
    splitter: {
      minChars: Math.round(num(splitRaw.minChars, fallback.splitter.minChars, 0, 200)),
      maxChars: Math.round(num(splitRaw.maxChars, fallback.splitter.maxChars, 40, 2000)),
      eagerFirstClause: bool(splitRaw.eagerFirstClause, fallback.splitter.eagerFirstClause)
    },
    sidecars
  }
  return { profile, issues }
}

/** Option helpers for providers (options are free-form JSON). */
export function optString(options: Record<string, unknown>, key: string, fallback: string): string {
  const v = options[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}
export function optNumber(options: Record<string, unknown>, key: string, fallback: number): number {
  const v = options[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
export function optBool(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = options[key]
  return typeof v === 'boolean' ? v : fallback
}
export function optStrings(options: Record<string, unknown>, key: string): string[] {
  const v = options[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
