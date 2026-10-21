import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider } from '../src/core/registry'
import type { SttAudio } from '../src/core/providers/types'
import { ProfileStore } from '../src/main/profiles'
import { DEFAULT_LOCAL_STT_MODEL, LOCAL_STT_MODELS, localSttModel, requireLocalSttModel } from '../src/shared/local-stt-models'
import { localLoopProfile } from '../src/shared/profile'
import { fakeHost } from './helpers'

const V2 = 'nvidia/parakeet-tdt-0.6b-v2'
const REDUX = 'moondream/parakeet-redux'

describe('local STT models', () => {
  test('preserves v2 as the backwards-compatible default', () => {
    expect(DEFAULT_LOCAL_STT_MODEL).toBe(V2)
    expect(localSttModel(undefined)?.id).toBe(V2)
    expect(localSttModel(null)?.id).toBe(V2)
    expect(localSttModel('')?.id).toBe(V2)
    expect(localLoopProfile().stt.options.model).toBe(V2)
    expect(createProvider('stt', localLoopProfile()).id).toBe('parakeet-local')
  })

  test('catalog contains exactly v2 and the pinned Redux conversion, both selectable', () => {
    expect(LOCAL_STT_MODELS.map(model => model.id)).toEqual([V2, REDUX])
    expect(localSttModel(V2)?.available).toBe(true)
    expect(localSttModel(REDUX)?.available).toBe(true)
    expect(requireLocalSttModel(V2).id).toBe(V2)
    expect(requireLocalSttModel(REDUX).id).toBe(REDUX)
  })

  test('rejects unknown models rather than substituting', () => {
    expect(() => localSttModel('some/unknown-model')).toThrow('No model substitution is allowed')
    expect(() => requireLocalSttModel('some/unknown-model')).toThrow('Unknown local STT model')
  })

  test('forwards each selected model ID to host and rejects unknown IDs before host access', async () => {
    let calls = 0
    const forwarded: string[] = []
    const host = fakeHost({
      fetch: (async () => { calls++; throw new Error('unexpected fetch') }) as unknown as typeof fetch,
      spawn(command, args) { calls++; return fakeHost().spawn(command, args, { signal: new AbortController().signal }) },
      parakeet: { async transcribe(_audio, _signal, modelId) { calls++; forwarded.push(modelId); return { text: 'heard it' } } }
    })
    const audio = { samples: new Float32Array([0]), sampleRate: 16000 } as SttAudio
    const redux = createProvider('stt', { ...localLoopProfile(), stt: { provider: 'parakeet-local', options: { model: REDUX } } })
    const reduxResult = await redux.transcribe(audio, { host, signal: new AbortController().signal })
    expect(reduxResult.raw).toEqual({ model: REDUX, backend: 'local' })

    const v2 = createProvider('stt', { ...localLoopProfile(), stt: { provider: 'parakeet-local', options: { model: V2 } } })
    const result = await v2.transcribe(audio, { host, signal: new AbortController().signal })
    expect(result.text).toBe('heard it')
    expect(result.raw).toEqual({ model: V2, backend: 'local' })
    expect(forwarded).toEqual([REDUX, V2])
    expect(calls).toBe(2)

    const unknown = createProvider('stt', { ...localLoopProfile(), stt: { provider: 'parakeet-local', options: { model: 'some/unknown-model' } } })
    await expect(unknown.transcribe(audio, { host, signal: new AbortController().signal })).rejects.toThrow('Unknown local STT model')
    expect(calls).toBe(2)
  })

  test('provider options without a model retain the v2 default', async () => {
    let forwarded = ''
    const host = fakeHost({ parakeet: { async transcribe(_audio, _signal, modelId) { forwarded = modelId; return { text: 'heard it' } } } })
    const provider = createProvider('stt', { ...localLoopProfile(), stt: { provider: 'parakeet-local', options: {} } })
    await provider.transcribe({ samples: new Float32Array([0]), sampleRate: 16000 } as SttAudio, { host, signal: new AbortController().signal })
    expect(forwarded).toBe(V2)
  })

  test('ProfileStore keeps selected model through reload and reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parrotfish-stt-model-'))
    try {
      const store = new ProfileStore(dir)
      const profile = store.get('Local loop')
      profile.stt.options.model = REDUX
      store.save(profile, 'Local loop')
      store.reload()
      expect(store.get('Local loop').stt.options.model).toBe(REDUX)
      expect(new ProfileStore(dir).get('Local loop').stt.options.model).toBe(REDUX)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
