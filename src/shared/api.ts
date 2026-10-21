// The window.parrotfish API the preload exposes to the app renderer.
import type { BenchReport, BenchRow } from '../core/bench'
import type { ProviderInfo } from '../core/registry'
import type { CatalogVoice } from './phonon-voices'
import type { Profile, ProfileIssue, Stage } from './profile'
import type { ApprovalRequest, LiveState, TurnEvent, TurnRecord } from './types'

export type SidecarStatus = 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'exited'

export interface SidecarState {
  id: string
  label: string
  command: string
  healthUrl?: string
  status: SidecarStatus
  pid?: number
  exitCode?: number | null
  /** Last health probe result. */
  detail: string
}

export interface MicStatus {
  on: boolean
  vad: string
  error?: string
}

export interface PhononProgress {
  label: string
  received: number
  total: number
  done: boolean
  error?: string
}

export interface BenchRequest {
  wavPaths: string[]
  texts: string[]
  profiles: string[]
  repeats: number
}

export interface LogLine {
  at: number
  scope: string
  line: string
}

export interface ParrotfishApi {
  platform: string
  profiles: {
    list(): Promise<{ names: string[]; active: string; builtins: string[] }>
    get(name: string): Promise<Profile>
    save(raw: unknown, previousName?: string): Promise<{ profile: Profile; issues: ProfileIssue[] }>
    remove(name: string): Promise<void>
    setActive(name: string): Promise<void>
    providers(): Promise<Record<Stage, ProviderInfo[]>>
  }
  turns: {
    text(text: string): Promise<TurnRecord>
    cancel(): Promise<void>
    history(): Promise<TurnRecord[]>
    answerApproval(id: string, ok: boolean): Promise<void>
  }
  mic: {
    start(): Promise<MicStatus>
    stop(): Promise<MicStatus>
    /** 16 kHz mono frames from the AudioWorklet. */
    frames(samples: Float32Array): void
  }
  audio: {
    started(turnId: string): void
    idle(): void
  }
  bench: {
    pickWavs(): Promise<string[]>
    run(request: BenchRequest): Promise<BenchReport>
    cancel(): Promise<void>
    exportJson(report: BenchReport): Promise<string | null>
  }
  sidecars: {
    list(): Promise<SidecarState[]>
    start(id: string): Promise<void>
    stop(id: string): Promise<void>
    logs(id: string): Promise<string[]>
  }
  phonon: {
    warm(): Promise<{ ok: boolean; error?: string }>
    voices(): Promise<CatalogVoice[]>
  }
  logs(): Promise<LogLine[]>
  /** Easter egg: say something with the active profile's TTS. */
  speak(text: string): Promise<void>
  on<K extends keyof EventMap>(channel: K, listener: (payload: EventMap[K]) => void): () => void
}

export interface EventMap {
  'turn:event': TurnEvent
  state: LiveState
  level: { p: number; speaking: boolean }
  mic: MicStatus
  'approval:request': ApprovalRequest
  'audio:begin': string
  'audio:chunk': { turnId: string; samples: Float32Array; sampleRate: number }
  'audio:end': string
  'audio:stop': null
  sidecar: SidecarState
  'sidecar:log': { id: string; line: string }
  log: LogLine
  'phonon:progress': PhononProgress
  'bench:row': { row: BenchRow; done: number; total: number }
  'profiles:changed': { active: string }
}

export const EVENT_CHANNELS: Array<keyof EventMap> = [
  'turn:event',
  'state',
  'level',
  'mic',
  'approval:request',
  'audio:begin',
  'audio:chunk',
  'audio:end',
  'audio:stop',
  'sidecar',
  'sidecar:log',
  'log',
  'phonon:progress',
  'bench:row',
  'profiles:changed'
]
