// Per-turn clock: each stage marks once, as an offset from the turn's start.
import type { TimingMark, TurnTimings } from '../shared/types'

export type Now = () => number

export class TurnClock {
  readonly startedAt: number
  private readonly t0: number
  private readonly marks: Partial<Record<TimingMark, number>> = {}

  constructor(
    private readonly now: Now = () => performance.now(),
    epoch: number = Date.now(),
    readonly vadHangMs?: number
  ) {
    this.t0 = now()
    this.startedAt = epoch
  }

  /** First call wins (a later "firstToken" is not the first token). Returns the offset. */
  mark(name: TimingMark): number {
    const existing = this.marks[name]
    if (existing !== undefined) return existing
    const ms = Math.max(0, Math.round((this.now() - this.t0) * 10) / 10)
    this.marks[name] = ms
    return ms
  }

  has(name: TimingMark): boolean {
    return this.marks[name] !== undefined
  }

  get(name: TimingMark): number | undefined {
    return this.marks[name]
  }

  snapshot(): TurnTimings {
    const marks = { ...this.marks }
    const firstAudio = marks.firstAudio
    const start = marks.endOfSpeech ?? 0
    return {
      startedAt: this.startedAt,
      marks,
      voiceToVoiceMs: firstAudio === undefined ? null : Math.round((firstAudio - start) * 10) / 10,
      totalMs: marks.done === undefined ? null : marks.done,
      ...(this.vadHangMs !== undefined ? { vadHangMs: this.vadHangMs } : {})
    }
  }
}

export const WATERFALL_ORDER = ['endOfSpeech', 'sttFinal', 'routerDecision', 'toolCall', 'firstToken', 'firstSentence', 'firstAudio', 'done'] as const
export type WaterfallMark = (typeof WATERFALL_ORDER)[number]

/** Stage bars for the waterfall: each runs from the previous mark that exists. */
export function waterfallBars(t: TurnTimings): Array<{ mark: WaterfallMark; from: number; to: number }> {
  const bars: Array<{ mark: WaterfallMark; from: number; to: number }> = []
  let prev = 0
  for (const mark of WATERFALL_ORDER) {
    const at = t.marks[mark]
    if (at === undefined) continue
    bars.push({ mark, from: prev, to: at })
    prev = Math.max(prev, at)
  }
  return bars
}

export interface TimingSummary {
  n: number
  median: number | null
  p90: number | null
  mean: number | null
}

export function summarize(values: Array<number | null | undefined>): TimingSummary {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return { n: 0, median: null, p90: null, mean: null }
  const q = (p: number): number => {
    const idx = (v.length - 1) * p
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return Math.round((v[lo]! + (v[hi]! - v[lo]!) * (idx - lo)) * 10) / 10
  }
  return { n: v.length, median: q(0.5), p90: q(0.9), mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 }
}
