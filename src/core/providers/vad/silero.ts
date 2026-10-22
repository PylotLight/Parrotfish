// Silero VAD v6 (snakers4/silero-vad, MIT) through onnxruntime-node in main. 16 kHz, 512-sample
// frames plus 64 samples of context (what the official OnnxWrapper does), recurrent state [2,1,128].
// Checked in the sandbox with onnxruntime-node 1.30 on Linux: inputs input/state/sr, outputs output/stateN.
import type { ProviderFactory, VadProvider } from "../types";

export const SILERO_MODEL = {
  name: "silero_vad.onnx",
  url: "https://github.com/snakers4/silero-vad/raw/1e261b036686cd0017d500ee96acd1c4ba572a9d/src/silero_vad/data/silero_vad.onnx",
  sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
  bytes: 2327524,
};

const FRAME = 512;
const CONTEXT = 64;

export const sileroVad: ProviderFactory<VadProvider> = () => ({
  id: "silero",
  async open(host) {
    if (!host.onnx)
      throw new Error("onnxruntime is not available in this build");
    const path = await host.onnx.ensureModel(
      SILERO_MODEL.name,
      SILERO_MODEL.url,
      SILERO_MODEL.sha256,
      SILERO_MODEL.bytes,
    );
    const session = await host.onnx.load(path);
    let state = new Float32Array(2 * 128);
    let context = new Float32Array(CONTEXT);
    const sr = BigInt64Array.from([16000n]);
    return {
      frameSamples: FRAME,
      async process(frame: Float32Array) {
        const input = new Float32Array(CONTEXT + FRAME);
        input.set(context, 0);
        input.set(frame.subarray(0, FRAME), CONTEXT);
        const out = await session.run({
          input: { type: "float32", data: input, dims: [1, CONTEXT + FRAME] },
          state: { type: "float32", data: state, dims: [2, 1, 128] },
          sr: { type: "int64", data: sr, dims: [1] },
        });
        state = new Float32Array(out.stateN!.data);
        context = input.slice(input.length - CONTEXT);
        return out.output!.data[0] ?? 0;
      },
      reset() {
        state = new Float32Array(2 * 128);
        context = new Float32Array(CONTEXT);
      },
      release() {
        session.release();
      },
    };
  },
});
