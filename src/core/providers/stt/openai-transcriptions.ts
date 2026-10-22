// Any OpenAI-compatible POST /v1/audio/transcriptions (multipart: file, model, response_format).
// Parakeet (parakeet-api) and many local servers speak this; see parakeet.ts for the preset.
import { optString } from "../../../shared/profile";
import { encodeWav } from "../../audio";
import { authHeaders, expectOk, joinUrl } from "../../http";
import type { ProviderFactory, SttProvider } from "../types";

export function transcriptionsStt(
  id: string,
  defaults: { baseUrl: string; model: string },
): ProviderFactory<SttProvider> {
  return (options) => {
    const baseUrl = optString(options, "baseUrl", defaults.baseUrl);
    const model = optString(options, "model", defaults.model);
    const language = optString(options, "language", "");
    return {
      id,
      async transcribe(audio, ctx) {
        const form = new FormData();
        form.append(
          "file",
          new Blob([encodeWav(audio)], { type: "audio/wav" }),
          "utterance.wav",
        );
        form.append("model", model);
        form.append("response_format", "json");
        if (language) form.append("language", language);
        const response = await ctx.host.fetch(
          joinUrl(baseUrl, "audio/transcriptions"),
          {
            method: "POST",
            body: form,
            headers: authHeaders(options.apiKey),
            signal: ctx.signal,
          },
        );
        await expectOk(response, `${id} transcription`);
        const json = (await response.json()) as { text?: unknown };
        return {
          text: typeof json.text === "string" ? json.text.trim() : "",
          raw: json,
        };
      },
    };
  };
}

export const openaiTranscriptions = transcriptionsStt("openai-transcriptions", {
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "whisper-1",
});
