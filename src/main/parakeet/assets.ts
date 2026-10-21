export interface ParakeetAsset {
  sha256: string
  bytes: number
}

// NVIDIA v2 (CC BY 4.0), ONNX conversion by istupakov. Immutable metadata:
// https://huggingface.co/api/models/istupakov/parakeet-tdt-0.6b-v2-onnx/revision/0bbb45a3365852604aef28b538a8f066f4ccaa85?blobs=true
export const PARAKEET_REPO = 'istupakov/parakeet-tdt-0.6b-v2-onnx'
export const PARAKEET_REVISION = '0bbb45a3365852604aef28b538a8f066f4ccaa85'

export const PARAKEET_ASSETS: Record<string, ParakeetAsset> = {
  'encoder-model.int8.onnx': {
    sha256: '3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155',
    bytes: 652184014,
  },
  'decoder_joint-model.int8.onnx': {
    sha256: 'a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3',
    bytes: 8998286,
  },
  'vocab.txt': {
    sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d',
    bytes: 9384,
  },
}

// Full-precision encoder for strict WebGPU; same immutable v2 repository revision.
export const PARAKEET_GPU_ASSETS: Record<string, ParakeetAsset> = {
  'encoder-model.onnx': {
    sha256: '3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3',
    bytes: 41770866,
  },
  'encoder-model.onnx.data': {
    sha256: '4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41',
    bytes: 2435420160,
  },
}
