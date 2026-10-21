import type { ProviderContext, SttProvider, SttResult } from '../types'
import { throwIfAborted } from '../types'
export const parakeetLocal: SttProvider = {
  id: 'parakeet-local',
  async transcribe(audio, ctx: ProviderContext): Promise<SttResult> {
    throwIfAborted(ctx.signal)
    const engine = ctx.host.parakeet
    if (!engine) throw new Error('Local Parakeet v2 is unavailable. Start or retry the in-process STT engine.')
    const result = await engine.transcribe(audio, ctx.signal)
    throwIfAborted(ctx.signal)
    return { text: result.text, raw: { model: 'nvidia/parakeet-tdt-0.6b-v2', backend: 'local' } }
  }
}
