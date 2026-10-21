import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ParakeetDownloads } from '../src/main/parakeet/downloads'

const payload = new TextEncoder().encode('small test model bytes')
const sha256 = createHash('sha256').update(payload).digest('hex')
const fixture = { 'tiny.onnx': { bytes: payload.byteLength, sha256 } }
const dirs: string[] = []
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'parakeet-download-'))
  dirs.push(path)
  return path
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function response(bytes: Uint8Array): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.slice(0, 5)); controller.enqueue(bytes.slice(5)); controller.close() },
  }), { status: 200 })
}

describe('ParakeetDownloads', () => {
  test('streams, verifies, renames and reports progress', async () => {
    const root = await tempDir()
    let calls = 0
    const progress: unknown[] = []
    const downloads = new ParakeetDownloads(root, status => progress.push(status), async () => { calls++; return response(payload) }, fixture)
    await downloads.ensure()
    expect(await readFile(join(root, 'tiny.onnx'))).toEqual(Buffer.from(payload))
    expect(calls).toBe(1)
    expect(progress.length).toBeGreaterThan(0)
  })

  test('valid cache avoids fetching; bad cache is replaced', async () => {
    const root = await tempDir()
    const target = join(root, 'tiny.onnx')
    await writeFile(target, payload)
    let calls = 0
    const make = () => new ParakeetDownloads(root, () => {}, async () => { calls++; return response(payload) }, fixture)
    await make().ensure()
    expect(calls).toBe(0)
    await writeFile(target, 'corrupt')
    await make().ensure()
    expect(calls).toBe(1)
    expect(await readFile(target)).toEqual(Buffer.from(payload))
  })

  test('deduplicates concurrent ensures and removes partial files on verification failure', async () => {
    const root = await tempDir()
    let calls = 0
    const downloads = new ParakeetDownloads(root, () => {}, async () => { calls++; return response(new TextEncoder().encode('wrong')) }, fixture)
    const results = await Promise.allSettled([downloads.ensure(), downloads.ensure()])
    expect(calls).toBe(1)
    expect(results.every(r => r.status === 'rejected')).toBe(true)
    await expect(readFile(join(root, 'tiny.onnx.part'))).rejects.toThrow()
  })
})
