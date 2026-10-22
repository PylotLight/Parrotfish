import {
  DEFAULT_LOCAL_STT_MODEL,
  LOCAL_STT_MODELS,
} from "../../../shared/local-stt-models";

/** The same checkpoint/backend choices in Live and the profile editor. */
export function LocalSttOptions({
  options,
  onChange,
  disabled = false,
}: {
  options: Record<string, unknown>;
  onChange(options: Record<string, unknown>): void;
  disabled?: boolean;
}) {
  const modelId = String(options.model ?? DEFAULT_LOCAL_STT_MODEL);
  const redux = modelId === "moondream/parakeet-redux";
  return (
    <>
      <label className="field wide">
        <span>STT model</span>
        <select
          aria-label="STT model"
          value={modelId}
          disabled={disabled}
          onChange={(e) => onChange({ ...options, model: e.target.value })}
        >
          {LOCAL_STT_MODELS.map((model) => (
            <option key={model.id} value={model.id} disabled={!model.available}>
              {model.label}
            </option>
          ))}
          {!LOCAL_STT_MODELS.some((model) => model.id === modelId) && (
            <option value={modelId}>{modelId} (unknown — blocked)</option>
          )}
        </select>
        <span className="muted small">
          {redux
            ? "Exact Redux ONNX checkpoint · about 417 MB."
            : "English v2 checkpoint · about 661 MB on CPU."}
        </span>
      </label>
      <label className="field wide">
        <span>STT backend</span>
        <select
          aria-label="STT backend"
          value={String(options.backend ?? "wasm")}
          disabled={disabled}
          onChange={(e) => onChange({ ...options, backend: e.target.value })}
        >
          <option value="wasm">CPU / WASM (default)</option>
          <option value="webgpu">WebGPU trial (opt-in, CPU fallback)</option>
          {options.backend != null &&
            options.backend !== "wasm" &&
            options.backend !== "webgpu" && (
              <option value={String(options.backend)}>
                {String(options.backend)} (unknown — uses CPU)
              </option>
            )}
        </select>
        <span className="muted small">
          {options.backend === "webgpu"
            ? redux
              ? "Tries the existing Redux weights on GPU; falls back to CPU if unsupported or slower."
              : "Warning: Prepare models may download an additional 2.48 GB FP32 encoder for the GPU trial. Falls back to CPU if unsupported or slower."
            : "Uses compact CPU weights only. No GPU probe or extra GPU-weight download."}
        </span>
      </label>
    </>
  );
}
