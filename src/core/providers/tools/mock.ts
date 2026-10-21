// Mock tool caller: maps keywords onto the demo tools.
import { optNumber } from '../../../shared/profile'
import { sleep, type PlannedToolCall, type ProviderFactory, type ToolCallerProvider } from '../types'

export const mockTools: ProviderFactory<ToolCallerProvider> = (options) => ({
  id: 'mock',
  async plan(transcript, tools, ctx) {
    await sleep(optNumber(options, 'delayMs', 60), ctx.signal)
    const t = transcript.toLowerCase()
    const has = (n: string): boolean => tools.some((x) => x.name === n)
    const calls: PlannedToolCall[] = []
    const open = /open (\w+)/.exec(t)
    if (open && has('open_app')) calls.push({ name: 'open_app', args: { name: open[1]!.charAt(0).toUpperCase() + open[1]!.slice(1) } })
    else if (/note/.test(t) && has('create_note')) calls.push({ name: 'create_note', args: { body: transcript.replace(/^.*?note( that)?\s*/i, '') || transcript } })
    else if (/time|date/.test(t) && has('get_time')) calls.push({ name: 'get_time', args: {} })
    return { calls, text: '' }
  }
})
