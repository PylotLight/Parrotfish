export interface ParakeetAsset {
  sha256: string
  bytes: number
}

export interface ParakeetManifest {
  repo: string
  revision: string
  assets: Record<string, ParakeetAsset>
  cacheKey: string
  label: string
}

// NVIDIA v2 (CC BY 4.0), ONNX conversion by istupakov. Immutable metadata:
// https://huggingface.co/api/models/istupakov/parakeet-tdt-0.6b-v2-onnx/revision/0bbb45a3365852604aef28b538a8f066f4ccaa85?blobs=true
export const PARAKEET_REPO = 'istupakov/parakeet-tdt-0.6b-v2-onnx'
export const PARAKEET_REVISION = '0bbb45a3365852604aef28b538a8f066f4ccaa85'
export const PARAKEET_ASSETS: Record<string, ParakeetAsset> = {
  'encoder-model.int8.onnx': { sha256: '3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155', bytes: 652184014 },
  'decoder_joint-model.int8.onnx': { sha256: 'a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3', bytes: 8998286 },
  'vocab.txt': { sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d', bytes: 9384 },
}
export const PARAKEET_GPU_ASSETS: Record<string, ParakeetAsset> = {
  'encoder-model.onnx': { sha256: '3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3', bytes: 41770866 },
  'encoder-model.onnx.data': { sha256: '4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41', bytes: 2435420160 },
}

export const REDUX_REPO = 'eschmidbauer/parakeet-redux-onnx'
export const REDUX_REVISION = '1c285ba78d6f1880803f65355133a5ad3559a407'
export const REDUX_ASSETS: Record<string, ParakeetAsset> = {
  'encoder-model.onnx': { bytes: 343841943, sha256: 'ade2c65c188776b3662db620a553ab82ac7e9ca11a7be6b696bcc5190f75382e' },
  'decoder_joint-model.onnx': { bytes: 72552270, sha256: '97ae0cb049f32a5d7a6572e91020b8d87d66baffa0ff9de2cf6de4c0960e92f8' },
  'vocab.txt': { bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
}

export const V2_MANIFEST: ParakeetManifest = { repo: PARAKEET_REPO, revision: PARAKEET_REVISION, assets: PARAKEET_ASSETS, cacheKey: 'parakeet-tdt-0.6b-v2', label: 'Parakeet TDT 0.6B v2' }
export const REDUX_MANIFEST: ParakeetManifest = { repo: REDUX_REPO, revision: REDUX_REVISION, assets: REDUX_ASSETS, cacheKey: 'parakeet-redux', label: 'Parakeet Redux' }
export const PARAKEET_MANIFESTS: Record<string, ParakeetManifest> = { 'nvidia/parakeet-tdt-0.6b-v2': V2_MANIFEST, 'moondream/parakeet-redux': REDUX_MANIFEST }
