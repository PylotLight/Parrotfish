import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PARAKEET_MANIFESTS, REDUX_MANIFEST, V2_MANIFEST } from '../src/main/parakeet/assets'
import { ParakeetDownloads } from '../src/main/parakeet/downloads'
import type { LocalInferenceStatus } from '../src/shared/local-inference'

test('exact Redux conversion and v2 have different immutable manifests and caches', () => {
  expect(Object.keys(PARAKEET_MANIFESTS)).toEqual(['nvidia/parakeet-tdt-0.6b-v2', 'moondream/parakeet-redux'])
  expect(REDUX_MANIFEST.repo).toBe('eschmidbauer/parakeet-redux-onnx')
  expect(REDUX_MANIFEST.revision).toBe('1c285ba78d6f1880803f65355133a5ad3559a407')
  expect(REDUX_MANIFEST.cacheKey).not.toBe(V2_MANIFEST.cacheKey)
  expect(V2_MANIFEST.cacheKey).toBe('parakeet-tdt-0.6b-v2')
  expect(Object.keys(REDUX_MANIFEST.assets)).toEqual(['encoder-model.onnx', 'decoder_joint-model.onnx', 'vocab.txt'])
  for (const manifest of Object.values(PARAKEET_MANIFESTS)) {
    expect(manifest.revision).toMatch(/^[a-f0-9]{40}$/)
    for (const asset of Object.values(manifest.assets)) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.bytes).toBeGreaterThan(0)
    }
  }
})

test('Redux downloads its own pinned URL and never reuses a same-named v2 cache file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parakeet-model-cache-'))
  try {
    const urls: string[] = []
    const statuses: LocalInferenceStatus[] = []
    for (const manifest of [V2_MANIFEST, REDUX_MANIFEST]) {
      const bytes = new TextEncoder().encode(manifest.cacheKey)
      const fixture = { ...manifest, assets: { 'vocab.txt': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } }
      const download = new ParakeetDownloads(join(root, manifest.cacheKey), status => statuses.push(status), async url => { urls.push(url); return new Response(bytes) }, undefined, fixture)
      await download.ensure()
      await download.ensure()
      expect(await readFile(join(download.root, 'vocab.txt'), 'utf8')).toBe(manifest.cacheKey)
      expect(urls.at(-1)).toBe(`https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/vocab.txt?download=true`)
    }
    expect(urls.length).toBe(2)
    expect(statuses.some(status => status.modelId === 'moondream/parakeet-redux' && status.label.includes('Redux'))).toBe(true)
    expect(statuses.some(status => status.modelId === 'nvidia/parakeet-tdt-0.6b-v2')).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
