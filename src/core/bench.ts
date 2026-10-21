// Bench: run saved WAVs (or typed lines) through one or two profiles and compare the timings.
// Each case runs as an isolated turn (no shared history, destructive tools auto-denied), with a
// sink that counts the first chunk as first audio (no speakers involved, so it's synthesis time).
import type { Profile } from '../shared/profile'
import type { TurnRecord } from '../shared/types'
import type { Orchestrator } from './orchestrator'
import type { SttAudio } from './providers/types'
import type { AudioSink } from './speech-queue'
import { summarize, type TimingSummary } from './timing'

export interface BenchCase {
  name: string
  audio?: SttAudio
  text?: string
}

export interface BenchRow {
  case: string
  profile: string
  status: TurnRecord['status']
  transcript: string
  route: string
  reply: string
  sttMs: number | null
  routerMs: number | null
  firstTokenMs: number | null
  firstAudioMs: number | null
  voiceToVoiceMs: number | null
  totalMs: number | null
  error?: string
}

export interface BenchProfileSummary {
  profile: string
  voiceToVoice: TimingSummary
  stt: TimingSummary
  router: TimingSummary
  firstToken: TimingSummary
  total: TimingSummary
  errors: number
}

export interface BenchReport {
  createdAt: string
  profiles: string[]
  repeats: number
  rows: BenchRow[]
  summary: BenchProfileSummary[]
}

export function rowFrom(name: string, record: TurnRecord): BenchRow {
  const m = record.timings.marks
  const delta = (a: number | undefined, b: number | undefined): number | null => (a === undefined || b === undefined ? null : Math.round((a - b) * 10) / 10)
  return {
    case: name,
    profile: record.profile,
    status: record.status,
    transcript: record.transcript,
    route: record.decision ? `${record.decision.action}${record.decision.belowThreshold ? ` (was ${record.decision.choice})` : ''} ${record.decision.confidence.toFixed(2)}` : '',
    reply: record.reply,
    sttMs: m.sttFinal ?? null,
    routerMs: delta(m.routerDecision, m.sttFinal),
    firstTokenMs: m.firstToken ?? null,
    firstAudioMs: m.firstAudio ?? null,
    voiceToVoiceMs: record.timings.voiceToVoiceMs,
    totalMs: record.timings.totalMs,
    ...(record.error ? { error: record.error } : {})
  }
}

export function summarizeRows(rows: BenchRow[], profile: string): BenchProfileSummary {
  const mine = rows.filter((r) => r.profile === profile)
  return {
    profile,
    voiceToVoice: summarize(mine.map((r) => r.voiceToVoiceMs)),
    stt: summarize(mine.map((r) => r.sttMs)),
    router: summarize(mine.map((r) => r.routerMs)),
    firstToken: summarize(mine.map((r) => r.firstTokenMs)),
    total: summarize(mine.map((r) => r.totalMs)),
    errors: mine.filter((r) => r.status === 'error').length
  }
}

/** Counts the first synthesized chunk as first audio; plays nothing. */
export const benchSink: AudioSink = {
  begin(_turnId, onStart) {
    onStart()
  },
  write() {},
  end() {},
  stop() {}
}

/** Runs every case on each profile in turn (A then B per case, so drift hits both). */
export async function runBench(
  orchestrator: Orchestrator,
  cases: BenchCase[],
  profiles: Profile[],
  options: { repeats?: number; signal?: AbortSignal; onRow?: (row: BenchRow, done: number, total: number) => void } = {}
): Promise<BenchReport> {
  const repeats = Math.max(1, Math.min(20, options.repeats ?? 1))
  const rows: BenchRow[] = []
  const total = cases.length * profiles.length * repeats
  for (let r = 0; r < repeats; r++) {
    for (const c of cases) {
      for (const profile of profiles) {
        if (options.signal?.aborted) break
        const record = await orchestrator.runTurn({ source: 'bench', isolated: true, sink: benchSink, autoApprove: false, profile, ...(c.text !== undefined ? { text: c.text } : { audio: c.audio }) })
        const row = rowFrom(c.name, record)
        rows.push(row)
        options.onRow?.(row, rows.length, total)
      }
    }
  }
  return { createdAt: new Date().toISOString(), profiles: profiles.map((p) => p.name), repeats, rows, summary: profiles.map((p) => summarizeRows(rows, p.name)) }
}
