// Any OpenAI-compatible POST /v1/audio/speech. response_format "pcm" streams raw s16le mono at
// options.sampleRate (24 kHz for OpenAI and ptts-openai-server); "wav" is decoded whole.
import { optNumber, optString } from '../../../shared/profile'
import { Pcm16Stream, decodeWav } from '../../audio'
import { authHeaders, bodyChunks, expectOk, joinUrl } from '../../http'
import type { ProviderFactory, TtsProvider } from '../types'

export function speechTts(id: string, defaults: { baseUrl: string; model: string; voice: string; speed: boolean }): ProviderFactory<TtsProvider> {
  return (options) => {
    const baseUrl = optString(options, 'baseUrl', defaults.baseUrl)
    const format = optString(options, 'format', 'pcm')
    const sampleRate = optNumber(options, 'sampleRate', 24000)
    return {
      id,
      async *synthesize(text, ctx) {
        const body: Record<string, unknown> = { model: optString(options, 'model', defaults.model), input: text, voice: optString(options, 'voice', defaults.voice), response_format: format }
        if (defaults.speed && typeof options.speed === 'number') body.speed = options.speed
        const response = await ctx.host.fetch(joinUrl(baseUrl, 'audio/speech'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(options.apiKey) },
          body: JSON.stringify(body),
          signal: ctx.signal
        })
        await expectOk(response, `${id} speech`)
        if (format === 'wav') {
          yield decodeWav(new Uint8Array(await response.arrayBuffer()))
          return
        }
        const pcm = new Pcm16Stream()
        for await (const bytes of bodyChunks(response)) {
          const samples = pcm.push(bytes)
          if (samples.length) yield { samples, sampleRate }
        }
      }
    }
  }
}

export const openaiSpeech = speechTts('openai-speech', { baseUrl: 'http://127.0.0.1:8880/v1', model: 'tts-1', voice: 'alloy', speed: true })
