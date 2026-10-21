// whisper.cpp's whisper-server: POST /inference (multipart file, response_format=json) -> { text }.
import { optNumber, optString } from '../../../shared/profile'
import { encodeWav } from '../../audio'
import { expectOk, joinUrl } from '../../http'
import type { ProviderFactory, SttProvider } from '../types'

export const whisperCppStt: ProviderFactory<SttProvider> = (options) => {
  const baseUrl = optString(options, 'baseUrl', 'http://127.0.0.1:8090')
  return {
    id: 'whisper-cpp',
    async transcribe(audio, ctx) {
      const form = new FormData()
      form.append('file', new Blob([encodeWav(audio)], { type: 'audio/wav' }), 'utterance.wav')
      form.append('response_format', 'json')
      form.append('temperature', String(optNumber(options, 'temperature', 0)))
      const language = optString(options, 'language', '')
      if (language) form.append('language', language)
      const response = await ctx.host.fetch(joinUrl(baseUrl, 'inference'), { method: 'POST', body: form, signal: ctx.signal })
      await expectOk(response, 'whisper.cpp inference')
      const json = (await response.json()) as { text?: unknown }
      return { text: typeof json.text === 'string' ? json.text.trim() : '', raw: json }
    }
  }
}
