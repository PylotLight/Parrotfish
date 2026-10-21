// Mock router: keyword rules, so the Mock profile exercises every branch.
import { optNumber } from '../../../shared/profile'
import { ROUTER_CHOICES, type RouterChoice } from '../../../shared/types'
import { sleep, type ProviderFactory, type RouterProvider } from '../types'

export function mockChoice(text: string): { choice: RouterChoice; confidence: number } {
  const t = text.toLowerCase()
  if (!t.trim() || /^(um+|uh+|hmm+)\W*$/.test(t)) return { choice: 'ignore', confidence: 0.9 }
  if (/\b(time|open|note|uptime|disk)\b/.test(t)) return { choice: 'device_action', confidence: 0.86 }
  if (/\b(code|repo|refactor|claude|codex)\b/.test(t)) return { choice: 'escalate', confidence: 0.8 }
  if (/\b(that thing|what about it)\b/.test(t)) return { choice: 'clarify', confidence: 0.5 }
  return { choice: 'reply_local', confidence: 0.75 }
}

export const mockRouter: ProviderFactory<RouterProvider> = (options) => ({
  id: 'mock',
  async decide(input, ctx) {
    await sleep(optNumber(options, 'delayMs', 15), ctx.signal)
    const forced = typeof options.choice === 'string' ? (options.choice as RouterChoice) : undefined
    const { choice, confidence } = forced ? { choice: forced, confidence: optNumber(options, 'confidence', 0.9) } : mockChoice(input.transcript)
    const rest = (1 - confidence) / (ROUTER_CHOICES.length - 1)
    const probabilities = Object.fromEntries(ROUTER_CHOICES.map((c) => [c, c === choice ? confidence : rest]))
    return {
      choice,
      probabilities,
      confidence,
      ...(input.askEndOfTurn ? { endOfTurn: optNumber(options, 'endOfTurn', /\b(and|but|so|um)$/i.test(input.transcript.trim()) ? 0.2 : 0.92) } : {}),
      ...(input.bargeInOver !== undefined ? { bargeIn: optNumber(options, 'bargeIn', /^(ok|okay|yeah|mhm|right)\W*$/i.test(input.transcript.trim()) ? 0.15 : 0.9) } : {})
    }
  }
})
