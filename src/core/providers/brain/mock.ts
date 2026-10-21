// Mock brain: streams a canned reply token by token (tokenMs apart) after delayMs.
import { optNumber, optString } from '../../../shared/profile'
import { sleep, type BrainProvider, type ProviderFactory } from '../types'

export const mockBrain: ProviderFactory<BrainProvider> = (options) => ({
  id: 'mock',
  async *stream(messages, ctx) {
    await sleep(optNumber(options, 'delayMs', 180), ctx.signal)
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const reply = optString(options, 'reply', `You said ${last.replace(/[.?!]+$/, '')}. This is the mock brain, so every stage is fake but the timings are real. Swap a stage to see what changes.`)
    const tokenMs = optNumber(options, 'tokenMs', 25)
    for (const token of reply.match(/\S+\s*/g) ?? []) {
      await sleep(tokenMs, ctx.signal)
      yield token
    }
  }
})
