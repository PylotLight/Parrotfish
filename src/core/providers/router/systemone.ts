// System One router: llama-server's POST /v1/systemone with a decision model (Kev-0.8B, Kev-4B,
// Julia-1...). One forward pass scores our five choices; `confidence` comes back calibrated.
// Request/response shape from ggml-org's "Decision Models" post (2026-10-02):
//   { state, questions: { id: { type: 'choice', instructions, criteria: { option: description } } | { type: 'noul', instructions } } }
//   -> { answers: { id: { choice, probabilities, confidence } | { noul } } }
import { optString } from '../../../shared/profile'
import { ROUTER_CHOICES, type RouterChoice } from '../../../shared/types'
import { authHeaders, expectOk, joinUrl } from '../../http'
import type { ProviderFactory, RawRouterDecision, RouterInput, RouterProvider } from '../types'

export const CHOICE_CRITERIA: Record<RouterChoice, string> = {
  reply_local: 'chit-chat, a general question or anything a small local assistant can answer directly from what it knows',
  device_action: 'asks to do something on this computer: the time or date, open an app, check the system, save a note',
  escalate: 'a hard multi-step task needing a coding agent: write or change code, work in a repo, research, long tasks',
  clarify: 'the request is ambiguous or missing a key detail, so ask one short question first',
  ignore: 'not addressed to the assistant: background talk, filler, noise, or an unfinished fragment'
}

export function systemOneRequest(input: RouterInput, model?: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    route: { type: 'choice', instructions: 'What should the voice assistant do with what the user just said?', criteria: CHOICE_CRITERIA }
  }
  if (input.askEndOfTurn) questions.end_of_turn = { type: 'noul', instructions: 'Has the user finished their thought, so the assistant should respond now?' }
  if (input.bargeInOver !== undefined) questions.barge_in = { type: 'noul', instructions: 'Is the user interrupting to stop or redirect the assistant (not just a backchannel like "mhm" or "yeah")?' }
  const state: Record<string, unknown> = { user_said: input.transcript }
  if (input.history.length) state.recent_conversation = input.history.slice(-3)
  if (input.bargeInOver !== undefined) state.assistant_was_saying = input.bargeInOver
  return { ...(model ? { model } : {}), state, questions }
}

export function parseSystemOne(json: unknown): RawRouterDecision {
  const answers = (json as { answers?: Record<string, Record<string, unknown>> })?.answers ?? {}
  const route = answers.route ?? {}
  const probs: Partial<Record<RouterChoice, number>> = {}
  const rawProbs = (route.probabilities ?? {}) as Record<string, unknown>
  for (const c of ROUTER_CHOICES) if (typeof rawProbs[c] === 'number') probs[c] = rawProbs[c] as number
  let choice = route.choice as RouterChoice
  if (!ROUTER_CHOICES.includes(choice)) {
    const best = Object.entries(probs).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]
    if (!best) throw new Error('systemone answered without a route choice')
    choice = best[0] as RouterChoice
  }
  const confidence = typeof route.confidence === 'number' ? route.confidence : (probs[choice] ?? 0)
  const noul = (id: string): number | undefined => (typeof answers[id]?.noul === 'number' ? (answers[id]!.noul as number) : undefined)
  const out: RawRouterDecision = { choice, probabilities: probs, confidence, raw: json }
  const eot = noul('end_of_turn')
  const barge = noul('barge_in')
  if (eot !== undefined) out.endOfTurn = eot
  if (barge !== undefined) out.bargeIn = barge
  return out
}

export const systemOneRouter: ProviderFactory<RouterProvider> = (options) => {
  const baseUrl = optString(options, 'baseUrl', 'http://127.0.0.1:8082')
  const model = optString(options, 'model', '')
  return {
    id: 'systemone',
    async decide(input, ctx) {
      const url = /\/v1\/?$/.test(baseUrl) ? joinUrl(baseUrl, 'systemone') : joinUrl(baseUrl, 'v1/systemone')
      const response = await ctx.host.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(options.apiKey) },
        body: JSON.stringify(systemOneRequest(input, model || undefined)),
        signal: ctx.signal
      })
      await expectOk(response, 'systemone')
      return parseSystemOne(await response.json())
    }
  }
}
