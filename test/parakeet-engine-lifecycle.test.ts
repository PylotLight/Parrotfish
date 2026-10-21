import { expect, mock, test } from 'bun:test'
import { DEFAULT_LOCAL_STT_MODEL } from '../src/shared/local-stt-models'
import type { LocalInferenceStatus } from '../src/shared/local-inference'
import type { SttEvent } from '../src/shared/stt-engine'

// No Electron process, worker, downloads or network is needed for lifecycle tests.
mock.module('electron', () => ({ app: {}, BrowserWindow: class {}, net: { fetch: () => { throw new Error('unexpected network') } }, session: {} }))
const { ParakeetEngine } = await import('../src/main/parakeet/engine-host')

type Internals = {
  activeModel: string | null
  activeBackend: 'wasm' | 'webgpu'
  warmReady: boolean
  warmWaiter: { id: number; reject(error: Error): void } | null
  pending: Map<number, { reject(error: Error): void }>
  onEvent(event: SttEvent): void
  reset(error: Error, report?: boolean): void
}
function fixture() {
  const statuses: LocalInferenceStatus[] = []
  const engine = new ParakeetEngine({ userData: '/unused-test-cache', onStatus: status => statuses.push(status), log: () => {} })
  const state = engine as unknown as Internals
  state.activeModel = DEFAULT_LOCAL_STT_MODEL
  state.warmReady = true
  return { state, statuses }
}

test('untagged worker errors immediately reject warm/transcribe work and clear ready backend', () => {
  const { state, statuses } = fixture()
  let warmRejected = false, transcriptionRejected = false
  state.warmWaiter = { id: 1, reject: () => { warmRejected = true } }
  state.pending.set(2, { reject: () => { transcriptionRejected = true } })
  state.onEvent({ type: 'error', message: 'worker startup failed' })
  expect(warmRejected).toBe(true)
  expect(transcriptionRejected).toBe(true)
  expect(state.warmReady).toBe(false)
  expect(state.pending.size).toBe(0)
  expect(statuses.at(-1)).toMatchObject({ state: 'error', modelId: DEFAULT_LOCAL_STT_MODEL })
  expect(statuses.at(-1)?.backend).toBeUndefined()
})

test('stale other-checkpoint errors cannot reset the current worker', () => {
  const { state, statuses } = fixture()
  state.onEvent({ type: 'error', modelId: 'moondream/parakeet-redux', message: 'stale error' })
  expect(state.warmReady).toBe(true)
  expect(statuses).toEqual([])
})

test('crash/timeout resets invalidate model status; intentional switches do not report errors', () => {
  const { state, statuses } = fixture()
  state.reset(new Error('worker stopped'))
  expect(statuses.at(-1)).toMatchObject({ state: 'error', modelId: DEFAULT_LOCAL_STT_MODEL })
  statuses.length = 0
  state.reset(new Error('intentional switch'), false)
  expect(statuses).toEqual([])
})


test('unsolicited GPU asset requests are rejected while WASM is active', () => {
  const { state, statuses } = fixture()
  const engine = state as unknown as { onEvent(event: SttEvent): void }
  engine.onEvent({ type: 'gpu-assets', id: 99 })
  expect(statuses).toEqual([])
})

test('worker lifecycle status carries the currently requested backend across backend switches', () => {
  const { state, statuses } = fixture()
  state.activeBackend = 'wasm'
  state.onEvent({ type: 'status', modelId: DEFAULT_LOCAL_STT_MODEL, state: 'ready', backend: 'WASM', detail: 'ready' })
  expect(statuses.at(-1)?.requestedBackend).toBe('wasm')
  state.activeBackend = 'webgpu'
  state.onEvent({ type: 'status', modelId: DEFAULT_LOCAL_STT_MODEL, state: 'ready', backend: 'WebGPU', detail: 'ready' })
  expect(statuses.at(-1)).toMatchObject({ requestedBackend: 'webgpu', backend: 'WebGPU' })
})
