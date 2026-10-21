# Parrotfish

on-device realtime voice agent playground for Apple silicon Macs. every stage of the pipeline is its own swappable provider, every turn is timed, and you can A/B two stacks on the same recordings to see where the latency actually goes.

![Live view on the Mock profile](docs/assets/live-mock.png)

```
mic ─▶ VAD ─▶ STT ─▶ router (System One) ─┬─▶ brain ───────────┐
                                           ├─▶ tool caller ─────┤─▶ sentence splitter ─▶ TTS queue ─▶ speakers
                                           ├─▶ escalation agent ┘
                                           └─▶ clarify / ignore
            barge-in (you talk over it) cancels everything in flight
```

| stage | providers |
| --- | --- |
| mic + VAD | Silero VAD v6 (onnxruntime-node, model downloaded + sha256 pinned), energy (RMS) fallback |
| STT | **Parakeet TDT v2 (default) or Redux in a local worker** (CPU / WASM default; opt-in WebGPU trial), Parakeet TDT v2 via `parakeet-api` (mlx, :8816), whisper.cpp `whisper-server`, any `/v1/audio/transcriptions`, sherpa-onnx in-process (optional) |
| router | llama-server `/v1/systemone` decision models (Kev-0.8B etc): `reply_local` / `device_action` / `escalate` / `clarify` / `ignore` with probabilities + confidence threshold, optional end-of-turn and barge-in questions. plus LLM-as-router baseline over any chat endpoint (json_schema constrained), and "none" |
| tool caller | OpenAI tool calling (LFM2-1.2B-Tool / FunctionGemma via `llama-server --jinja`). demo tools: `get_time`, allowlisted `open_app`, bounded `create_note`. Model-generated shell execution is refused. `open_app` and `create_note` wait for a click |
| brain | transcript repeat (Local loop, no LLM), any OpenAI-compatible streaming chat endpoint |
| escalation | Claude Code (`claude -p --output-format stream-json --verbose`), Codex (`codex exec --json`). tool events become short spoken progress lines |
| TTS | **Phonon 31m in-process** (phonon-tts 0.4.0 WASM in a hidden cross-origin-isolated window, default), ptts-openai-server, ptts-ws-server, any `/v1/audio/speech`, macOS `say` |

everything else:

- **profiles**: named JSON in the app's data folder. built-ins: `Local loop` (no sidecars, real STT/TTS), `default` (the optional server stack below), `Mock` (no servers at all), `baseline` (whisper.cpp + LLM router + `say`). form editor + raw JSON editor, quick switcher in the title bar
- **sidecar manager**: per-profile start commands (run through your login shell), health checks, logs pane
- **waterfall** per turn: VAD hangover, STT final, router, tools, first token, first sentence, first audio (when the first sample actually plays), done. voice-to-voice = end of speech to first audio
- **bench**: run saved WAVs (and/or typed lines) through one or two profiles, median/p90 table with the B−A delta, JSON export. a `.txt` next to a WAV is its transcript (the Mock STT returns it)
- **text mode**: type instead of talking, skips mic + STT
- click the logo 5 times

Phonon 40m is CC BY-NC, so it's never used or offered. Phonon 31m and the voices are Apache-2.0.

## no-sidecar local speech loop

Needs Bun and an Apple-silicon Mac; no Python or Homebrew inference servers.

```fish
git clone --branch feat/initial-app https://github.com/PylotLight/Parrotfish.git
cd Parrotfish
bun install
bun run dev
```

Select **Local loop** and open **Live**. Choose **STT model** (Parakeet TDT v2 or **Parakeet Redux**) and **STT backend** directly above the readiness cards, then choose **Prepare models**. CPU / WASM is the default, including for older profiles; selecting a model or backend saves the active profile but does not itself prepare or download weights. The app downloads and caches the models, loads inference workers, and shows download progress, readiness, backend choice and retryable errors. Once ready, enable the mic and speak: **mic → energy VAD → Parakeet TDT 0.6B v2 → repeat transcript → Phonon 31m → speakers**. The same model and backend controls are also available under **Profiles → Local loop → Speech to text**; save profile edits, then return to Live and prepare. Each checkpoint has its own verified cache, and readiness is scoped to the selected checkpoint and requested backend. Typed turns skip STT. Use headphones to avoid transcribing the app's own voice.

This is deliberately a speech-in/speech-out playground, **not an LLM conversation or a model-driven device-action demo**. It starts no local servers, requires no Python/Homebrew inference setup, and enables no device actions or escalation. It is the initial profile for new installs; existing profiles and the saved active selection are preserved. The older `default` and `baseline` HTTP/server stacks remain available for comparisons.

- **STT:** pinned ONNX conversion of the English **v2** checkpoint, run with `parakeet.js` / ONNX Runtime Web in a dedicated worker. Preparation downloads about 661 MB for the compact CPU path. Only when you explicitly select **WebGPU trial** and prepare, an available WebGPU adapter triggers an additional download of about 2.48 GB of FP32 v2 encoder files (a 41.8 MB ONNX graph plus 2,435,420,160 bytes of external weights, often displayed as about 2.3 GiB); it never attempts to run the CPU-only int8 graph as a GPU model. The opt-in short local backend trial chooses WebGPU only when it works and measures faster than WASM; otherwise it reports the CPU fallback reason. The small probe is not a guarantee for every utterance/device. GPU failure during transcription falls back to WASM rather than silently switching models.
- **Redux STT:** the same local worker can load the exact Moondream Redux weights through a pinned, weight-preserving ONNX conversion (~417 MB). This is not ordinary NVIDIA v3, Ultra, or the original 178 MB Photon-packed download. Redux also defaults to CPU / WASM, with no extra GPU weights. An explicitly selected strict GPU trial may fail for its `MatMulNBits` graph; the worker then uses the verified WASM CPU path with a visible reason, without changing checkpoints.
- **TTS:** the owner's tested **CPU Phonon 31m** path is retained (phonon-tts 0.4.0, q8, threaded WASM), now off the engine page in its own worker. No unverified GPU TTS or 40m substitution.
- **Local files:** model downloads are persistent and checked before use; inference engines are isolated from the app's privileged API. Audio is not sent to a hosted STT/TTS service by this profile. First preparation needs network access for the pinned model files; cached runs do not.
- **Device actions in other profiles:** model output is validated again at the main-process boundary. Only typed clock, allowlisted app-open and bounded note actions exist; app opening and note creation still require approval. Arbitrary model-generated shell commands are not executable, including in legacy saved profiles.

### exact Parakeet version and license

The checkpoint is [NVIDIA Parakeet TDT 0.6B **v2**](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), an English, 16 kHz mono model. Its published model card currently specifies **CC BY 4.0**, including commercial use with attribution. The [istupakov ONNX conversion](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx) is pinned to revision `0bbb45a3365852604aef28b538a8f066f4ccaa85`, with SHA-256 and byte lengths for every model/tokenizer file in `src/main/parakeet/assets.ts`; this is a format/quantization conversion, not a new model trained by Parrotfish. NVIDIA is the original model author; retain attribution and the [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/) when redistributing it. The JavaScript runtime [parakeet.js](https://github.com/ysdede/parakeet.js) is MIT and supports explicit model URLs, so its v3 defaults are not used. **The original NVIDIA v3 model is not loaded or substituted.** Check the selected checkpoint's own terms before considering any future upgrade.

### exact Redux conversion and license

[Moondream Parakeet Redux](https://huggingface.co/moondream/parakeet-redux) is a ternary-weight model derived from NVIDIA v3, with 25-language support. Its original `model.safetensors` requires Photon's packed-weight loader; it is not directly consumable by ONNX Runtime. We use [eschmidbauer's Redux ONNX export](https://huggingface.co/eschmidbauer/parakeet-redux-onnx/tree/1c285ba78d6f1880803f65355133a5ad3559a407), pinned to revision `1c285ba78d6f1880803f65355133a5ad3559a407`, converted from Moondream source revision `2bf128600aac4b16946f7ed8372e56117fe5e23b`. The conversion stores the ternary values exactly in 4-bit `MatMulNBits` blocks, rather than replacing Redux with standard v3 weights. Encoder, decoder and vocabulary downloads are byte-length/SHA-256 verified. Our existing 128-mel JavaScript preprocessing and TDT decoder successfully transcribed a real speech clip using the installed `parakeet.js` 1.4.4 / ONNX Runtime Web 1.24.1 WASM runtime, including Redux's dynamic blank ID 8192. The app retains its existing 30-second utterance limit and external energy/Silero VAD; it does not claim Photon's long-form segmentation or performance.

Redux and this ONNX conversion are **CC BY 4.0**. Attribution: NVIDIA (base v3), Moondream (Redux training/ternary weights), eschmidbauer (ONNX conversion); neither model author endorses this app. The converted weights are downloaded, not bundled. TDT v2 remains the default, including for older saved local profiles without an explicit model option. Unknown model IDs fail before downloading or running another checkpoint.

## optional server-based stack on the Mac (fish)

needs bun, Homebrew, and an M-series Mac. arm64 only.

For the optional server stacks, pick the **Mock** profile in the title bar and type something: the whole pipeline runs with fake stages so you can check the UI with no models. then set up the real stack. each server below matches a sidecar in the `default` profile, so you can also start them from the **Sidecars** tab instead of a terminal.

```fish
# STT: Parakeet TDT 0.6B v2 on mlx (:8816, /v1/audio/transcriptions)
brew install ffmpeg uv
uv tool install "parakeet-api[mlx]"
parakeet-api download mlx --id mlx-community/parakeet-tdt-0.6b-v2
env STT__MLX__MODEL_ID=mlx-community/parakeet-tdt-0.6b-v2 parakeet-api serve

# llama.cpp: /v1/systemone landed 2026-10-02 (b11361). check `llama-server --version`,
# and if brew's bottle is older, `llama update` or build from source
brew install llama.cpp

# router: Kev-0.8B decision model (:8082, /v1/systemone)
llama-server -hf ggml-org/Kev-0.8B-GGUF:Q8_0 --port 8082

# brain: Qwen3 4B instruct (:8081)
llama-server -hf unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M --jinja -c 8192 --port 8081

# tool caller: LFM2-1.2B-Tool (:8083). smaller alt: ggml-org/functiongemma-270m-it-GGUF
llama-server -hf LiquidAI/LFM2-1.2B-Tool-GGUF:Q4_K_M --jinja --port 8083

# escalation: Claude Code and/or Codex, signed in as usual
claude --version; codex --version
```

TTS needs nothing: the default profile runs Phonon 31m in-process and downloads it (~71 MB, pinned + checksum-checked) on the first sentence, or ahead of time from **Profiles → default → Phonon 31m model → Download + warm up**. the other Phonon options if you want to compare:

```fish
# ptts-openai-server (docker, :8880). pcm is s16le 24 kHz, speed is 1.0 only
docker run --rm -p 127.0.0.1:8880:8880 -e PTTS_LANG=en -e PTTS_QUANT=q8 ghcr.io/gradium-ai/ptts-openai-server:latest

# ptts-ws-server (:8080, /speech/tts), from a clone of gradium-ai/xn-ptts (needs `brew install opus`)
cargo run --release -p ptts-ws-server -- --quant q8 --lang en

# the CLI, handy for sanity checks
brew install gradium-ai/tap/ptts
ptts --lang en "Hello from Phonon." -o speech.wav
```

baseline profile extras:

```fish
brew install whisper.cpp
# grab a ggml model (e.g. ggml-large-v3-turbo.bin) into ~/models first
whisper-server -m ~/models/ggml-large-v3-turbo.bin --port 8090
```

For that optional stack, switch to `default`, hit **mic off → listening**, and talk. macOS asks for mic access the first time.

### what's verified vs not

checked against each project's README (Oct 2026), not run on a Mac by me:

- parakeet-api commands and port, llama-server `-hf` lines (`ggml-org/Kev-0.8B-GGUF` has a `Q8_0` file), the `/v1/systemone` request/answer shape (from ggml-org's decision models post), ptts-openai-server docker line, ptts-ws-server protocol, `claude -p --output-format stream-json --verbose`
- **unverified**: whether brew's current `llama.cpp` bottle already has `/v1/systemone`, `codex exec --json` event names (parsed defensively), the sherpa-onnx provider (not a dependency, untested), LFM2 / FunctionGemma tool-call parsing through llama-server `--jinja`, Qwen3's `enable_thinking` kwarg being honoured by the 2507 instruct template (harmless if not)
- **run in CI / the Linux sandbox**: the whole orchestrator with mock providers (tests), every HTTP provider against fake servers, Silero VAD v6 through onnxruntime-node (real model), and the app booting under xvfb with two typed turns, including first audio coming back from the real renderer player and a real **Phonon 31m in-process** turn (loaded in ~1 s, cross-origin isolated, 2 threads)
- **real no-sidecar smoke:** a public 7.43-second speech WAV → selected STT → exact transcript repeat → Phonon worker synthesis passed for **v2 → Redux → v2** in both built and `bun run dev` modes, with the UI reporting each exact checkpoint and its backend. Redux also passed a standalone installed-runtime compatibility probe. Both used WASM CPU; WebGPU was unavailable, so real GPU execution remains unverified. These are Linux cloud results, not Mac latency claims. The 78-test suite covers model-ID forwarding, per-model cache/status isolation, immutable Redux manifests, download integrity/repair/partial cleanup, and worker failure/readiness invalidation.
- never tested: a real mic, real speakers, echo cancellation during barge-in, any real model server. CPU Phonon TTS was separately tested successfully by the owner; this does not establish real-microphone or WebGPU STT performance on their Mac.

## notes

- **barge-in**: speech start (≥150 ms) while the agent is thinking or talking cancels the turn and silences playback. with `router.askBargeIn` on, it instead waits for the utterance and asks the router whether it's a real interruption (so "mhm" doesn't stop it). mic capture has echo cancellation on, but use headphones if your speakers leak into the mic
- **end of turn**: with `router.askEndOfTurn`, a trailing fragment ("and...") under 0.5 is held and joined to your next utterance
- **threshold**: below the confidence threshold the router's pick becomes `router.fallback` (default `reply_local`). the slider on the Live view edits the active profile
- **first audio** on the Live view is when the first sample plays (scheduled start + output latency). in Bench nothing plays, so it's when the first chunk is synthesized
- escalation runs the CLI in `escalation.options.cwd` (default `~`) with your own CLI permissions. add flags like `["--permission-mode", "acceptEdits"]` (claude) or `["--full-auto"]` (codex) to `escalation.options.extraArgs` if you want it to edit things
- profiles, notes and downloaded models live in `~/Library/Application Support/parrotfish/`

## dev

```fish
bun run dev          # electron-vite dev
bun test             # mock-provider tests
bun run typecheck    # bun check
bun run lint         # oxlint
bun run build && bun run check:css
bun run dist:mac     # arm64 zip + dmg (unsigned)

# boot smoke: Mock profile, two typed turns, prints a JSON line and quits
bun run build; env PARROTFISH_SMOKE=1 ./node_modules/.bin/electron .

# opt-in real-model loop (downloads models on first run; short 16 kHz speech WAV)
env PARROTFISH_SMOKE=1 PARROTFISH_SMOKE_LOCAL=1 PARROTFISH_SMOKE_WAV=/absolute/path/speech.wav ./node_modules/.bin/electron .

# both exact checkpoints plus a switch back to v2, including selected-model UI status
env PARROTFISH_SMOKE=1 PARROTFISH_SMOKE_LOCAL=1 PARROTFISH_SMOKE_REDUX=1 PARROTFISH_SMOKE_WAV=/absolute/path/speech.wav ./node_modules/.bin/electron .
```

adding a provider: one file under `src/core/providers/<stage>/`, one line in `src/core/registry.ts`. the settings form picks up its options from the registry entry.

## license

MIT app. Bundled inference libraries: parakeet.js and ONNX Runtime (MIT). Downloaded assets, not bundled weights: Phonon runtime (MIT OR Apache-2.0), Phonon 31m weights and voices (Apache-2.0), Parakeet TDT v2 (NVIDIA, CC BY 4.0; ONNX conversion by istupakov), Redux (Moondream, derived from NVIDIA v3, CC BY 4.0; ONNX conversion by eschmidbauer), and Silero VAD (MIT).
