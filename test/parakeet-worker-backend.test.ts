import { expect, mock, test } from 'bun:test'

const calls: Array<Record<string, unknown>> = []
mock.module('onnxruntime-web', () => ({ env: { wasm: {} } }))
mock.module('parakeet.js', () => ({ fromUrls: async (options: Record<string, unknown>) => {
  calls.push(options)
  return { transcribe: async () => ({ utterance_text: 'ok' }), encoderSession: { release() {} }, joinerSession: { release() {} } }
} }))
const events: Array<Record<string, unknown>> = []
let adapterCalls = 0
Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { origin: 'https://engine' }, postMessage: (event: Record<string, unknown>) => events.push(event), onmessage: null } })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 4, get gpu() { return { requestAdapter: async () => { adapterCalls++; return {} } } } } })
await import('../src/renderer/stt-engine/worker')
const runtime = globalThis as unknown as { self: { onmessage: (event: { data: Record<string, unknown> }) => void } }
async function warm(id: number, backend?: string) {
  const command: Record<string, unknown> = { type: 'warm', id, modelId: 'nvidia/parakeet-tdt-0.6b-v2' }
  if (backend) command.backend = backend
  runtime.self.onmessage({ data: command })
  for (let i = 0; i < 50 && !events.some(e => e.type === 'warmed' && e.id === id); i++) {
    const request = events.find(e => e.type === 'gpu-assets')
    if (request) runtime.self.onmessage({ data: { type: 'gpu-assets-ready', id: request.id } })
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}
test('absent and legacy backend select CPU without probing navigator.gpu', async () => {
  await warm(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.backend).toBe('wasm')
  expect(events.some(e => e.type === 'gpu-assets')).toBe(false)
  expect(adapterCalls).toBe(0)
})
test('explicit backend change reloads model, while absent backend means WASM again', async () => {
  await warm(2, 'webgpu')
  expect(events.some(e => e.type === 'gpu-assets')).toBe(true)
  const before = calls.length
  await warm(3)
  expect(calls.length).toBeGreaterThan(before)
  expect(calls.at(-1)?.backend).toBe('wasm')
})
