// Optional in-process STT with sherpa-onnx (k2-fsa, Apache-2.0) via the `sherpa-onnx-node` package,
// which is NOT a dependency: install it yourself (`bun add sherpa-onnx-node`) and point the options
// at an offline NeMo transducer export, e.g. sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8:
//   { "encoder": ".../encoder.int8.onnx", "decoder": ".../decoder.int8.onnx", "joiner": ".../joiner.int8.onnx", "tokens": ".../tokens.txt" }
// UNVERIFIED: written against sherpa-onnx's node examples, never run here.
import { optNumber, optString } from "../../../shared/profile";
import type { ProviderFactory, SttProvider } from "../types";

interface SherpaRecognizer {
  createStream(): {
    acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
  };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
}

export const sherpaOnnxStt: ProviderFactory<SttProvider> = (options) => {
  let recognizer: SherpaRecognizer | null = null;
  const load = async (): Promise<SherpaRecognizer> => {
    if (recognizer) return recognizer;
    const moduleName = "sherpa-onnx-node";
    let sherpa: {
      OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
    };
    try {
      sherpa = (await import(/* @vite-ignore */ moduleName)) as typeof sherpa;
    } catch {
      throw new Error(
        "sherpa-onnx-node is not installed (bun add sherpa-onnx-node)",
      );
    }
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: optString(options, "encoder", ""),
          decoder: optString(options, "decoder", ""),
          joiner: optString(options, "joiner", ""),
        },
        tokens: optString(options, "tokens", ""),
        numThreads: optNumber(options, "threads", 2),
        provider: optString(options, "provider", "cpu"),
        modelType: optString(options, "modelType", "nemo_transducer"),
      },
    });
    return recognizer;
  };
  return {
    id: "sherpa-onnx",
    async transcribe(audio) {
      const r = await load();
      const stream = r.createStream();
      stream.acceptWaveform({
        samples: audio.samples,
        sampleRate: audio.sampleRate,
      });
      r.decode(stream);
      return { text: r.getResult(stream).text.trim() };
    },
  };
};
