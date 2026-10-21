// LLM-as-router baseline: any OpenAI-compatible chat endpoint, asked for a score per choice under a
// JSON schema (llama-server turns response_format json_schema into a grammar). Scores are normalised
// into probabilities so the UI and threshold work the same as System One.
import { optString } from '../../../shared/profile'
import { ROUTER_CHOICES, type RouterChoice } from '../../../shared/types'
import { authHeaders, expectOk, joinUrl } from '../../http'
import type { ProviderFactory, RawRouterDecision, RouterInput, RouterProvider } from '../types'
import { CHOICE_CRITERIA } from './systemone'

export function routerSchema(input: RouterInput): Record<string, unknown> {
  const score = { type: 'number', minimum: 0, maximum: 1 }
  const properties: Record<string, unknown> = {
    scores: { type: 'object', properties: Object.fromEntries(ROUTER_CHOICES.map((c) => [c, score])), required: [...ROUTER_CHOICES], additionalProperties: false }
  }
  const required = ['scores']
  if (input.askEndOfTurn) {
    properties.end_of_turn = score
    required.push('end_of_turn')
  }
  if (input.bargeInOver !== undefined) {
    properties.barge_in = score
    required.push('barge_in')
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function routerPrompt(input: RouterInput): string {
  const lines = [
    'You route a voice assistant. Score how well each option fits what the user just said (0 to 1).',
    ...ROUTER_CHOICES.map((c) => `- ${c}: ${CHOICE_CRITERIA[c]}`)
  ]
  if (input.askEndOfTurn) lines.push('end_of_turn: probability the user has finished their thought.')
  if (input.bargeInOver !== undefined) lines.push(`barge_in: probability the user is interrupting the assistant (who was saying: "${input.bargeInOver.slice(0, 200)}"), not just backchanneling.`)
  if (input.history.length) lines.push('Recent conversation:', ...input.history.slice(-3).map((h) => `user: ${h.user}\nassistant: ${h.assistant}`))
  lines.push('Answer with JSON only.')
  return lines.join('\n')
}

export function parseLlmRouter(content: string): RawRouterDecision {
  const json = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim()) as { scores?: Record<string, unknown>; end_of_turn?: unknown; barge_in?: unknown }
  const raw = ROUTER_CHOICES.map((c) => [c, Math.max(0, Number(json.scores?.[c] ?? 0) || 0)] as const)
  const total = raw.reduce((n, [, v]) => n + v, 0)
  const probabilities: Partial<Record<RouterChoice, number>> = {}
  for (const [c, v] of raw) probabilities[c] = total > 0 ? v / total : 1 / ROUTER_CHOICES.length
  const [choice, confidence] = Object.entries(probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0] as [RouterChoice, number]
  const out: RawRouterDecision = { choice, probabilities, confidence, raw: json }
  if (typeof json.end_of_turn === 'number') out.endOfTurn = json.end_of_turn
  if (typeof json.barge_in === 'number') out.bargeIn = json.barge_in
  return out
}

export const llmRouter: ProviderFactory<RouterProvider> = (options) => {
  const baseUrl = optString(options, 'baseUrl', 'http://127.0.0.1:8081/v1')
  const model = optString(options, 'model', 'local')
  return {
    id: 'llm-router',
    async decide(input, ctx) {
      const response = await ctx.host.fetch(joinUrl(baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(options.apiKey) },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 120,
          messages: [
            { role: 'system', content: routerPrompt(input) },
            { role: 'user', content: input.transcript }
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'route', strict: true, schema: routerSchema(input) } }
        }),
        signal: ctx.signal
      })
      await expectOk(response, 'llm router')
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      return parseLlmRouter(json.choices?.[0]?.message?.content ?? '{}')
    }
  }
}
