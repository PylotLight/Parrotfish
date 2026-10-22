// What the in-process Phonon engine downloads on first use (nothing is bundled), each file checked
// against a pinned hash before use. Same pins as Surffish Read Aloud (PR #290):
//  - runtime: the official phonon-tts 0.4.0 npm tarball (gradium-ai/xn-ptts ptts-wasm, MIT OR Apache-2.0)
//  - model: gradium/phonon-31m-en (Apache-2.0) q8 at a pinned commit. Phonon 40m is CC BY-NC: never used.
//  - voices: gradium/phonon-voices (Apache-2.0) voices.jsonl + the 37 English voice files.
import {
  ENGLISH_VOICE_SHA256,
  VOICE_CATALOG_BYTES,
  VOICE_CATALOG_SHA256,
  VOICE_CATALOG_URL,
  VOICE_FILE_BYTES,
  VOICES_REPO,
} from "../../shared/phonon-voices";

const MODEL_REPO =
  "https://huggingface.co/gradium/phonon-31m-en/resolve/8c64b55ec301728e2d1695bfea87a08a267d0c2d";

export interface PinnedAsset {
  label: string;
  url: string;
  /** Path under the phonon folder. */
  file: string;
  bytes: number;
  sha256?: string;
  /** npm Subresource Integrity (sha512-...) for the tarball. */
  integrity?: string;
}

export const PHONON_RUNTIME_VERSION = "0.4.0";
export const PHONON_RUNTIME: PinnedAsset = {
  label: "Phonon runtime",
  url: `https://registry.npmjs.org/phonon-tts/-/phonon-tts-${PHONON_RUNTIME_VERSION}.tgz`,
  file: `phonon-tts-${PHONON_RUNTIME_VERSION}.tgz`,
  bytes: 5927575,
  integrity:
    "sha512-008+bytDUgx2npm+KXJV4Quo8BTXeRVLiYkX4mXPcToy81RQ2cu3Vvi2bdRjFZdpyaWfDy574w4bIZnGqRd44g==",
};

/** Files unpacked from the tarball: the JS and both wasm builds (paths without `package/`). */
export function isPhononRuntimeFile(path: string): boolean {
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(path) || path.startsWith("/")) return false;
  if (/^[a-z]+\.js$/.test(path) || /^LICENSE-(?:MIT|APACHE)$/.test(path))
    return true;
  if (
    /^wasm(?:-threads)?\/phonon_tts\.js$/.test(path) ||
    /^wasm(?:-threads)?\/phonon_tts_bg\.wasm$/.test(path)
  )
    return true;
  return /^wasm-threads\/snippets\/[\w.-]+\/src\/[\w.-]+\.js$/.test(path);
}

export const DEFAULT_VOICE_FILE = "default-voice.safetensors";

export const PHONON_MODEL: readonly PinnedAsset[] = [
  {
    label: "Model weights",
    url: `${MODEL_REPO}/model.q8.gguf`,
    file: "model/model.q8.gguf",
    bytes: 64512352,
    sha256: "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae",
  },
  {
    label: "Tokenizer",
    url: `${MODEL_REPO}/tokenizer.json`,
    file: "model/tokenizer.json",
    bytes: 277967,
    sha256: "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936",
  },
  {
    label: "Model config",
    url: `${MODEL_REPO}/config.json`,
    file: "model/config.json",
    bytes: 2851,
    sha256: "7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06",
  },
  {
    label: "Default voice",
    url: `${MODEL_REPO}/${DEFAULT_VOICE_FILE}`,
    file: `model/${DEFAULT_VOICE_FILE}`,
    bytes: 256136,
    sha256: "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18",
  },
];

export const PHONON_VOICE_CATALOG: PinnedAsset = {
  label: "Voice catalog",
  url: VOICE_CATALOG_URL,
  file: "model/voices.jsonl",
  bytes: VOICE_CATALOG_BYTES,
  sha256: VOICE_CATALOG_SHA256,
};

export function voiceAsset(id: string): PinnedAsset | null {
  const sha256 = ENGLISH_VOICE_SHA256[id];
  if (!sha256 || !/^[\w-]{1,40}$/.test(id)) return null;
  return {
    label: `Voice ${id}`,
    url: `${VOICES_REPO}/voices/${id}.safetensors`,
    file: `model/voices/${id}.safetensors`,
    bytes: VOICE_FILE_BYTES,
    sha256,
  };
}

export function firstUseBytes(): number {
  return PHONON_RUNTIME.bytes + PHONON_MODEL.reduce((n, a) => n + a.bytes, 0);
}
