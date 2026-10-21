// Shared types: used by main, preload, renderer and the Electron-free core (src/core).

/** Mono float PCM, the unit every audio-producing stage hands on. */
export interface PcmChunk {
  samples: Float32Array
  sampleRate: number
}

/** The five things the router (System One) can decide for a user turn. */
export const ROUTER_CHOICES = ['reply_local', 'device_action', 'escalate', 'clarify', 'ignore'] as const
export type RouterChoice = (typeof ROUTER_CHOICES)[number]

export interface RouterDecision {
  /** What the model picked (top probability). */
  choice: RouterChoice
  /** What the pipeline will actually do after the confidence threshold (low confidence -> fallback). */
  action: RouterChoice
  probabilities: Partial<Record<RouterChoice, number>>
  confidence: number
  /** True when confidence was under the threshold and `action` is the fallback. */
  belowThreshold: boolean
  /** Optional extra questions (end-of-turn / barge-in), probability of "yes". */
  endOfTurn?: number
  bargeIn?: number
  /** Provider that decided, and its raw response for the inspector. */
  provider: string
  raw?: unknown
}

/** A stage mark on the per-turn timeline, in ms since the turn started (end of speech or text submit). */
export const TIMING_MARKS = [
  'endOfSpeech',
  'sttFinal',
  'routerDecision',
  'toolCall',
  'firstToken',
  'firstSentence',
  'firstAudio',
  'done'
] as const
export type TimingMark = (typeof TIMING_MARKS)[number]

export interface TurnTimings {
  /** Epoch ms the turn started (used to order history). */
  startedAt: number
  /** Offsets in ms from startedAt. endOfSpeech is 0 for mic turns. */
  marks: Partial<Record<TimingMark, number>>
  /** Voice-to-voice: end of speech -> first audio out. */
  voiceToVoiceMs: number | null
  totalMs: number | null
}

export type TurnSource = 'mic' | 'text' | 'bench'

export type TurnStatus = 'running' | 'done' | 'cancelled' | 'error'

export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  result: string
  /** Destructive tools wait for the user; this says what happened. */
  approval: 'not-needed' | 'approved' | 'denied' | 'timeout'
  ms: number
}

export interface TurnRecord {
  id: string
  profile: string
  source: TurnSource
  status: TurnStatus
  transcript: string
  reply: string
  decision: RouterDecision | null
  tools: ToolCallRecord[]
  escalation: string[]
  timings: TurnTimings
  error?: string
}

/** Events the orchestrator emits while a turn runs (main forwards them to the renderer). */
export type TurnEvent =
  | { type: 'turn-start'; id: string; source: TurnSource; profile: string }
  | { type: 'transcript'; id: string; text: string; final: boolean }
  | { type: 'decision'; id: string; decision: RouterDecision }
  | { type: 'token'; id: string; text: string }
  | { type: 'sentence'; id: string; text: string; index: number }
  | { type: 'tool'; id: string; call: ToolCallRecord }
  | { type: 'progress'; id: string; text: string }
  | { type: 'mark'; id: string; mark: TimingMark; ms: number }
  | { type: 'turn-end'; id: string; record: TurnRecord }

/** A destructive tool asking the user first. */
export interface ApprovalRequest {
  id: string
  turnId: string
  tool: string
  args: Record<string, unknown>
  summary: string
}

export type LiveState = 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking'
