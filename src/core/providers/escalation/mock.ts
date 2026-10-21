// Mock escalation: two fake tool events, then a result.
import { optNumber } from '../../../shared/profile'
import { sleep, type EscalationProvider, type ProviderFactory } from '../types'

export const mockEscalation: ProviderFactory<EscalationProvider> = (options) => ({
  id: 'mock',
  async *run(prompt, ctx) {
    const step = optNumber(options, 'delayMs', 300)
    for (const text of ['Reading the repo.', 'Running the tests.']) {
      await sleep(step, ctx.signal)
      yield { kind: 'progress', text }
    }
    await sleep(step, ctx.signal)
    yield { kind: 'result', text: `Mock agent finished: ${prompt.slice(0, 60)}. All tests pass.` }
  }
})
