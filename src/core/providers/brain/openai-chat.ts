// Brain: any OpenAI-compatible streaming /chat/completions (llama-server, LM Studio, Ollama, vLLM...).
import { optNumber, optString } from '../../../shared/profile'
import { authHeaders, chatDelta, expectOk, joinUrl, sseData } from '../../http'
import type { BrainProvider, ProviderFactory } from '../types'

export const openaiChat: ProviderFactory<BrainProvider> = (options) => {
  const baseUrl = optString(options, 'baseUrl', 'http://127.0.0.1:8081/v1')
  const model = optString(options, 'model', 'local')
  return {
    id: 'openai-chat',
    async *stream(messages, ctx) {
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        temperature: optNumber(options, 'temperature', 0.6),
        max_tokens: optNumber(options, 'maxTokens', 300)
      }
      // Qwen3 hybrids: keep thinking off for voice unless asked (llama-server reads chat_template_kwargs).
      if (options.thinking !== true) body.chat_template_kwargs = { enable_thinking: false }
      const response = await ctx.host.fetch(joinUrl(baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(options.apiKey) },
        body: JSON.stringify(body),
        signal: ctx.signal
      })
      await expectOk(response, 'brain')
      if (!response.body) throw new Error('brain: empty response body')
      for await (const data of sseData(response.body)) {
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const delta = chatDelta(json)
        if (delta) yield delta
      }
    }
  }
}
