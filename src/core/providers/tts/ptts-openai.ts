// Phonon 31m through gradium-ai's ptts-openai-server (docker, :8880). pcm = s16le 24 kHz mono.
// The server only does speed 1.0, so speed isn't sent.
//   docker run --rm -p 127.0.0.1:8880:8880 -e PTTS_LANG=en -e PTTS_QUANT=q8 ghcr.io/gradium-ai/ptts-openai-server:latest
import { speechTts } from "./openai-speech";

export const pttsOpenai = speechTts("ptts-openai", {
  baseUrl: "http://127.0.0.1:8880/v1",
  model: "phonon",
  voice: "default",
  speed: false,
});
