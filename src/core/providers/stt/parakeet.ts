// Parakeet TDT 0.6B v2 through parakeet-api (mlx backend) on :8816. Mac setup (README):
//   brew install ffmpeg; uv tool install "parakeet-api[mlx]"
//   parakeet-api download mlx --id mlx-community/parakeet-tdt-0.6b-v2
//   env STT__MLX__MODEL_ID=mlx-community/parakeet-tdt-0.6b-v2 parakeet-api serve
import { transcriptionsStt } from "./openai-transcriptions";

export const parakeetStt = transcriptionsStt("parakeet", {
  baseUrl: "http://127.0.0.1:8816/v1",
  model: "mlx-community/parakeet-tdt-0.6b-v2",
});
