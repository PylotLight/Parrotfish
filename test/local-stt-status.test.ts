import { expect, test } from 'bun:test'
import { DEFAULT_LOCAL_STT_MODEL } from '../src/shared/local-stt-models'
import { localSttStatus } from '../src/shared/local-stt-status'
import type { LocalInferenceStatus } from '../src/shared/local-inference'

const V2 = DEFAULT_LOCAL_STT_MODEL
const REDUX = 'moondream/parakeet-redux'
const readyV2: LocalInferenceStatus = { stage: 'stt', state: 'ready', modelId: V2, label: 'Parakeet TDT 0.6B v2', backend: 'WebGPU encoder + WASM decoder' }
const readyRedux: LocalInferenceStatus = { stage: 'stt', state: 'ready', modelId: REDUX, label: 'Parakeet Redux', backend: 'WASM' }

test('selected Redux never inherits v2 cache, progress, or backend', () => {
  for (const state of ['downloading', 'loading', 'benchmarking', 'ready'] as const) {
    const otherModelStatus = { ...readyV2, state, received: 42 }
    const selected = localSttStatus(REDUX, otherModelStatus)
    expect(selected.modelId).toBe(REDUX)
    expect(selected.label).toBe('Parakeet Redux')
    expect(selected.state).toBe('idle')
    expect(selected.backend).toBeUndefined()
    expect(selected.received).toBeUndefined()
  }
})

test('matching model cache is restored; absent or other-model cache begins idle', () => {
  expect(localSttStatus(V2, readyV2)).toEqual(readyV2)
  expect(localSttStatus(REDUX, readyRedux)).toEqual(readyRedux)
  const reduxWithoutCache = localSttStatus(REDUX)
  expect(reduxWithoutCache.state).toBe('idle')
  expect(reduxWithoutCache.modelId).toBe(REDUX)
  expect(reduxWithoutCache.backend).toBeUndefined()
  const v2FromReduxCache = localSttStatus(V2, readyRedux)
  expect(v2FromReduxCache.state).toBe('idle')
  expect(v2FromReduxCache.backend).toBeUndefined()
})

test('rapid v2 → Redux → v2 selection never cross-contaminates cached status', () => {
  const selectedV2 = localSttStatus(V2, readyV2)
  const selectedRedux = localSttStatus(REDUX, selectedV2)
  const selectedReduxReady = localSttStatus(REDUX, readyRedux)
  const selectedV2Again = localSttStatus(V2, selectedV2)
  expect(selectedRedux.state).toBe('idle')
  expect(selectedRedux.backend).toBeUndefined()
  expect(selectedReduxReady).toEqual(readyRedux)
  expect(selectedV2Again).toEqual(readyV2)
})

test('unknown model never becomes v2 or inherits an engine backend', () => {
  const selected = localSttStatus('wrong/model', readyV2)
  expect(selected.state).toBe('error')
  expect(selected.modelId).toBeUndefined()
  expect(selected.backend).toBeUndefined()
  expect(selected.detail).toContain('No model substitution')
})
