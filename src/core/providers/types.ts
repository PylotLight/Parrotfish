// Provider interfaces: one per pipeline stage. Implementations live one per file next to this one
// and register in ../registry.ts. Nothing here imports Electron, so the orchestrator and every
// provider run under `bun test` with mocks.
import type { PcmChunk, RouterChoice } from '../../shared/types'

/** Capabilities the app (Electron main) lends to providers. Tests pass a fake. */
export interface Host {
  fetch: typeof fetch
  /** Spawn a process (no shell); stdout as lines. Used by escalation, tools and `say`. */
  spawn(command: string, args: string[], options: { cwd?: string; signal: AbortSignal; stdin?: string }): SpawnedProcess
  /** In-process Phonon (hidden cross-origin-isolated window). Absent in tests / on failure. */
  phonon?: PhononHost
  /** In-process Parakeet v2 worker (no HTTP server). */
  parakeet?: { transcribe(audio: SttAudio, signal: AbortSignal): Promise<SttResult> }
  /** onnxruntime-node in main (Silero VAD). Absent in tests. */
  onnx?: OnnxHost
  /** Where downloaded models live (userData/models). */
  modelsDir: string
  /** Where create_note writes. */
  notesDir: string
  files: {
    read(path: string): Promise<Uint8Array>
    write(path: string, data: Uint8Array | string): Promise<void>
    /** A fresh path in the temp folder with this extension. */
    temp(ext: string): string
    remove(path: string): Promise<void>
  }
  log(scope: string, line: string): void
}

export interface SpawnedProcess {
  lines: AsyncIterable<string>
  stderr(): string
  exit: Promise<number | null>
  kill(): void
}

export interface PhononSpeakOptions {
  voice: string
  speed: number
  temperature?: number
  seed?: number
}

export interface PhononHost {
  /** Streams float PCM for one sentence. Abort stops generation. */
  stream(text: string, options: PhononSpeakOptions, signal: AbortSignal): AsyncIterable<PcmChunk>
}

export interface OnnxTensorIn {
  type: 'float32' | 'int64'
  data: Float32Array | BigInt64Array
  dims: number[]
}
export interface OnnxSession {
  run(feeds: Record<string, OnnxTensorIn>): Promise<Record<string, { data: Float32Array; dims: number[] }>>
  release(): void
}
export interface OnnxHost {
  load(path: string): Promise<OnnxSession>
  /** Download (pinned, sha256 checked) into modelsDir if missing; returns the path. */
  ensureModel(name: string, url: string, sha256: string, bytes: number): Promise<string>
}

export interface ProviderContext {
  signal: AbortSignal
  host: Host
}

// ---------------------------------------------------------------- VAD

/** One VAD session per mic stream. Frames are 16 kHz mono, `frameSamples` long. */
export interface VadSession {
  readonly frameSamples: number
  /** Probability of speech for one frame. */
  process(frame: Float32Array): Promise<number> | number
  reset(): void
  release(): void
}
export interface VadProvider {
  readonly id: string
  open(host: Host): Promise<VadSession>
}

// ---------------------------------------------------------------- STT

export interface SttResult {
  text: string
  raw?: unknown
}
/** 16 kHz mono; Bench may attach the expected transcript as `hint` (the mock STT returns it). */
export type SttAudio = PcmChunk & { hint?: string }
export interface SttProvider {
  readonly id: string
  transcribe(audio: SttAudio, ctx: ProviderContext): Promise<SttResult>
}

// ---------------------------------------------------------------- Router

export interface RouterInput {
  transcript: string
  /** Last few turns, oldest first, for context. */
  history: Array<{ user: string; assistant: string }>
  askEndOfTurn: boolean
  /** Set when the user spoke over the agent: what the agent was saying. */
  bargeInOver?: string
}
export interface RawRouterDecision {
  choice: RouterChoice
  probabilities: Partial<Record<RouterChoice, number>>
  confidence: number
  endOfTurn?: number
  bargeIn?: number
  raw?: unknown
}
export interface RouterProvider {
  readonly id: string
  decide(input: RouterInput, ctx: ProviderContext): Promise<RawRouterDecision>
}

// ---------------------------------------------------------------- Tool caller

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Needs a click in the UI before it runs. */
  destructive: boolean
}
export interface PlannedToolCall {
  name: string
  args: Record<string, unknown>
}
export interface ToolCallerProvider {
  readonly id: string
  plan(transcript: string, tools: ToolSpec[], ctx: ProviderContext): Promise<{ calls: PlannedToolCall[]; text: string }>
}

// ---------------------------------------------------------------- Brain

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
export interface BrainProvider {
  readonly id: string
  /** Token (delta) stream. */
  stream(messages: ChatMessage[], ctx: ProviderContext): AsyncIterable<string>
}

// ---------------------------------------------------------------- Escalation

export type EscalationEvent = { kind: 'progress'; text: string } | { kind: 'text'; text: string } | { kind: 'result'; text: string }
export interface EscalationProvider {
  readonly id: string
  run(prompt: string, ctx: ProviderContext): AsyncIterable<EscalationEvent>
}

// ---------------------------------------------------------------- TTS

export interface TtsProvider {
  readonly id: string
  /** Float PCM chunks for one sentence. */
  synthesize(text: string, ctx: ProviderContext): AsyncIterable<PcmChunk>
}

export type ProviderFactory<T> = (options: Record<string, unknown>) => T

/** Throws if the turn was cancelled (barge-in, stop, new turn). */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

export function abortError(): Error {
  const e = new Error('cancelled')
  e.name = 'AbortError'
  return e
}

export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ((error as Error).name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
}

/** Resolves after `ms`, rejects with AbortError when the signal fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = (): void => {
      clearTimeout(t)
      reject(abortError())
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
