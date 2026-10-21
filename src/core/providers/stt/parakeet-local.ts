import { requireLocalSttModel } from '../../../shared/local-stt-models'
import type { ProviderContext, ProviderFactory, SttProvider, SttResult } from '../types'
import { throwIfAborted } from '../types'
export const parakeetLocal: ProviderFactory<SttProvider> = (options) => ({
  id: 'parakeet-local',
  async transcribe(audio, ctx: ProviderContext): Promise<SttResult> {
    throwIfAborted(ctx.signal)
    // Fail before engine access: Redux must never silently transcribe with v2.
    const model = requireLocalSttModel(options.model)
    const engine = ctx.host.parakeet
    if (!engine) throw new Error('Local Parakeet is unavailable. Start or retry the in-process STT engine.')
    const backend = options.backend === 'webgpu' ? 'webgpu' : 'wasm'
    const result = await engine.transcribe(audio, ctx.signal, model.id, backend)
    throwIfAborted(ctx.signal)
    return { text: result.text, raw: { model: model.id, backend: 'local' } }
  }
})
