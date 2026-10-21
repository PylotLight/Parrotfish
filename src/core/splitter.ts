// Streaming sentence splitter: brain tokens in, speakable chunks out, as early as is safe.
// The TTS queue speaks each chunk as soon as it is emitted, so where this cuts decides
// time-to-first-audio as much as any model does.
import type { SplitterConfig } from '../shared/profile'

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'no', 'fig', 'inc', 'ltd', 'co', 'mt', 'u.s', 'a.m', 'p.m'])

/** Strips what a TTS would read out literally: markdown marks, code ticks, list bullets, emoji. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(\*{1,3}|_{2,3}|~~)([^*_~]+)\1/g, '$2')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Index just past the first sentence end in `text`, or -1 when none is certain yet. */
export function findBoundary(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\n') return i + 1
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue
    // need to see what follows before deciding (the stream may continue "3.5", "e.g.")
    let j = i + 1
    while (j < text.length && /["')\]’”.!?]/.test(text[j]!)) j++
    if (j >= text.length) return -1
    if (!/\s/.test(text[j]!)) {
      i = j - 1
      continue
    }
    if (ch === '.') {
      const word = /([A-Za-z.]+)$/.exec(text.slice(Math.max(0, i - 8), i))?.[1]?.toLowerCase() ?? ''
      if (ABBREVIATIONS.has(word)) continue
      // single capital initial ("J. R. R. Tolkien")
      if (/(?:^|\s)[A-Z]$/.test(text.slice(Math.max(0, i - 2), i))) continue
    }
    return j
  }
  return -1
}

export class SentenceSplitter {
  private buffer = ''
  private pending = ''
  private emitted = 0

  constructor(private readonly config: SplitterConfig) {}

  /** Feed a token delta; returns the chunks now ready to speak. */
  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    let boundary = findBoundary(this.buffer)
    while (boundary >= 0) {
      this.accept(this.buffer.slice(0, boundary), out)
      this.buffer = this.buffer.slice(boundary)
      boundary = findBoundary(this.buffer)
    }
    // Nothing spoken yet: cut the first clause early at a comma.
    if (this.emitted === 0 && out.length === 0 && this.config.eagerFirstClause && !this.pending) {
      const m = /^([\s\S]{24,}?[,;:—–])\s/.exec(this.buffer)
      if (m) {
        this.accept(m[1]!, out, true)
        this.buffer = this.buffer.slice(m[0].length)
      }
    }
    // A run-on: cut at the last comma (or space) inside maxChars.
    while (this.buffer.length > this.config.maxChars) {
      const window = this.buffer.slice(0, this.config.maxChars)
      const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
      const at = comma > this.config.maxChars / 3 ? comma + 1 : Math.max(window.lastIndexOf(' '), 1)
      this.accept(this.buffer.slice(0, at), out, true)
      this.buffer = this.buffer.slice(at)
    }
    return out
  }

  /** End of the stream: whatever is left. */
  flush(): string[] {
    const rest = speakable(`${this.pending} ${this.buffer}`)
    this.pending = ''
    this.buffer = ''
    if (!rest) return []
    this.emitted++
    return [rest]
  }

  private accept(raw: string, out: string[], force = false): void {
    const text = speakable(`${this.pending} ${raw}`)
    if (!text) return
    // too short to be worth its own TTS call: carry it into the next one
    if (!force && text.length < this.config.minChars) {
      this.pending = text
      return
    }
    this.pending = ''
    out.push(text)
    this.emitted++
  }
}

/** Whole-text split (escalation results, the easter egg). */
export function splitAll(text: string, config: SplitterConfig): string[] {
  const s = new SentenceSplitter(config)
  return [...s.push(text), ...s.flush()]
}
