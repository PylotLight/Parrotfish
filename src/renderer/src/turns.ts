// Renderer-side turn log: folds TurnEvents into TurnRecords so the UI can show a turn while it runs.
import type { TurnEvent, TurnRecord } from '../../shared/types'

export function emptyTurn(id: string, source: TurnRecord['source'], profile: string): TurnRecord {
  return { id, profile, source, status: 'running', transcript: '', reply: '', decision: null, tools: [], escalation: [], timings: { startedAt: Date.now(), marks: {}, voiceToVoiceMs: null, totalMs: null } }
}

export function applyEvent(turns: TurnRecord[], e: TurnEvent): TurnRecord[] {
  if (e.type === 'turn-start') {
    if (e.source === 'bench') return turns
    return [...turns.filter((t) => t.id !== e.id), emptyTurn(e.id, e.source, e.profile)].slice(-200)
  }
  const i = turns.findIndex((t) => t.id === e.id)
  if (i < 0) return turns
  const t = { ...turns[i]! }
  switch (e.type) {
    case 'transcript':
      t.transcript = e.text
      break
    case 'decision':
      t.decision = e.decision
      break
    case 'sentence':
      t.reply = t.reply ? `${t.reply} ${e.text}` : e.text
      break
    case 'tool':
      t.tools = [...t.tools, e.call]
      break
    case 'progress':
      t.escalation = [...t.escalation, e.text]
      break
    case 'mark': {
      const marks = { ...t.timings.marks, [e.mark]: e.ms }
      const v2v = marks.firstAudio !== undefined ? marks.firstAudio - (marks.endOfSpeech ?? 0) : null
      t.timings = { ...t.timings, marks, voiceToVoiceMs: v2v, totalMs: marks.done ?? null }
      break
    }
    case 'turn-end':
      return turns.map((x) => (x.id === e.id ? { ...e.record, reply: e.record.reply || t.reply } : x))
    default:
      return turns
  }
  const next = [...turns]
  next[i] = t
  return next
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–'
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`
}
