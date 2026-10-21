import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PARAKEET_ASSETS, PARAKEET_REPO, PARAKEET_REVISION, type ParakeetAsset } from './assets'
import type { LocalInferenceStatus } from '../../shared/local-inference'

export type ParakeetAssetManifest = Record<string, ParakeetAsset>
export type ParakeetFetcher = (input: string, init?: any) => Promise<Response>

async function fileMatches(path: string, asset: ParakeetAsset): Promise<boolean> {
  try {
    if ((await stat(path)).size !== asset.bytes) return false
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { highWaterMark: 1 << 20 })
      stream.on('data', chunk => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
    return hash.digest('hex') === asset.sha256
  } catch {
    return false
  }
}

export class ParakeetDownloads {
  readonly root: string
  private inflight: Promise<void> | null = null

  constructor(
    root: string,
    private readonly onProgress: (status: LocalInferenceStatus) => void,
    private readonly fetcher: ParakeetFetcher = fetch,
    private readonly assets: ParakeetAssetManifest = PARAKEET_ASSETS,
  ) {
    this.root = root
  }

  ensure(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.ensureAll().finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  private async ensureAll(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const [file, asset] of Object.entries(this.assets)) await this.ensureFile(file, asset)
  }

  private async ensureFile(file: string, asset: ParakeetAsset): Promise<void> {
    const target = join(this.root, file)
    if (await fileMatches(target, asset)) {
      return
    }

    const label = `Downloading Parakeet v2 ${file}`
    const url = `https://huggingface.co/${PARAKEET_REPO}/resolve/${PARAKEET_REVISION}/${encodeURIComponent(file)}?download=true`
    const part = `${target}.part`
    let writer: ReturnType<typeof createWriteStream> | undefined
    try {
      this.onProgress({ stage: 'stt', state: 'downloading', label, received: 0, total: asset.bytes })
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(180_000) })
      if (!response.ok || !response.body) {
        throw new Error(`${label}: download failed (HTTP ${response.status}). Check network access and retry.`)
      }
      const hash = createHash('sha256')
      let received = 0
      let lastProgress = 0
      writer = createWriteStream(part, { flags: 'w' })
      const writeError = new Promise<never>((_, reject) => writer!.once('error', reject))
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await Promise.race([reader.read(), writeError])
        if (done) break
        hash.update(value)
        received += value.byteLength
        if (!writer.write(value)) await Promise.race([new Promise<void>(resolve => writer!.once('drain', resolve)), writeError])
        if (Date.now() - lastProgress >= 150) {
          lastProgress = Date.now()
          this.onProgress({ stage: 'stt', state: 'downloading', label, received, total: asset.bytes })
        }
      }
      writer.end()
      await Promise.race([new Promise<void>((resolve, reject) => { writer!.once('finish', resolve); writer!.once('error', reject) }), writeError])
      const digest = hash.digest('hex')
      if (received !== asset.bytes) throw new Error(`${label}: unexpected size (${received} bytes; expected ${asset.bytes}). Check network access and retry.`)
      if (digest !== asset.sha256) throw new Error(`${label}: pinned SHA-256 verification failed. Download refused; check network access and retry.`)
      await rename(part, target)
    } catch (error) {
      writer?.destroy()
      await rm(part, { force: true }).catch(() => {})
      if (error instanceof Error && (error.message.startsWith(label))) throw error
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}. Check network access and retry.`)
    }
  }
}
