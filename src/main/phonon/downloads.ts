// Phonon first-use download: runtime tarball (sha512 integrity, unpacked), model files and voices
// (sha256), into <userData>/phonon. A file already on disk is hashed once per run and kept if it
// matches. Concurrent callers share one download. Progress goes to `onProgress`.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PHONON_MODEL,
  PHONON_RUNTIME,
  PHONON_VOICE_CATALOG,
  isPhononRuntimeFile,
  voiceAsset,
  type PinnedAsset,
} from "./assets";
import { matchesIntegrity, readTarGz } from "./tar";

export interface DownloadProgress {
  label: string;
  received: number;
  total: number;
  done: boolean;
  error?: string;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path, { highWaterMark: 1 << 20 })
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

export class PhononDownloads {
  private verified = new Set<string>();
  private inflight = new Map<string, Promise<void>>();

  constructor(
    readonly root: string,
    private readonly onProgress: (p: DownloadProgress) => void,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  runtimeDir(): string {
    return join(this.root, "runtime");
  }

  modelDir(): string {
    return join(this.root, "model");
  }

  async ensureModel(): Promise<void> {
    await this.ensureRuntime();
    for (const asset of PHONON_MODEL) await this.ensureFile(asset);
  }

  async ensureVoice(id: string): Promise<string> {
    if (id === "default") return "default-voice.safetensors";
    const asset = voiceAsset(id);
    if (!asset) throw new Error(`unknown Phonon voice "${id}"`);
    await this.ensureFile(asset);
    return asset.file.replace(/^model\//, "");
  }

  async catalog(): Promise<string> {
    await this.ensureFile(PHONON_VOICE_CATALOG);
    return readFile(join(this.root, PHONON_VOICE_CATALOG.file), "utf8");
  }

  private once(key: string, run: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchBytes(asset: PinnedAsset): Promise<Uint8Array> {
    const response = await this.fetcher(asset.url);
    if (!response.ok || !response.body)
      throw new Error(`${asset.label}: HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length")) || asset.bytes;
    const chunks: Uint8Array[] = [];
    let received = 0;
    let last = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (Date.now() - last > 150) {
        last = Date.now();
        this.onProgress({ label: asset.label, received, total, done: false });
      }
    }
    const out = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.onProgress({ label: asset.label, received, total, done: true });
    return out;
  }

  private ensureFile(asset: PinnedAsset): Promise<void> {
    const path = join(this.root, asset.file);
    return this.once(asset.file, async () => {
      if (this.verified.has(asset.file)) return;
      if (existsSync(path) && (await sha256File(path)) === asset.sha256) {
        this.verified.add(asset.file);
        return;
      }
      const bytes = await this.fetchBytes(asset);
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== asset.sha256)
        throw new Error(
          `${asset.label}: checksum mismatch (got ${got.slice(0, 12)}...)`,
        );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.part`, bytes);
      await rename(`${path}.part`, path);
      this.verified.add(asset.file);
    });
  }

  private ensureRuntime(): Promise<void> {
    const marker = join(this.runtimeDir(), ".integrity");
    return this.once("runtime", async () => {
      if (this.verified.has("runtime")) return;
      if (
        existsSync(marker) &&
        (await readFile(marker, "utf8")) === PHONON_RUNTIME.integrity &&
        existsSync(join(this.runtimeDir(), "index.js"))
      ) {
        this.verified.add("runtime");
        return;
      }
      const tgz = await this.fetchBytes(PHONON_RUNTIME);
      if (!matchesIntegrity(tgz, PHONON_RUNTIME.integrity!))
        throw new Error("Phonon runtime: integrity mismatch");
      const files = readTarGz(tgz, isPhononRuntimeFile);
      if (!files.some((f) => f.path === "index.js"))
        throw new Error("Phonon runtime: index.js missing from the package");
      await rm(this.runtimeDir(), { recursive: true, force: true });
      for (const f of files) {
        const target = join(this.runtimeDir(), f.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.data);
      }
      await writeFile(marker, PHONON_RUNTIME.integrity!);
      this.verified.add("runtime");
    });
  }
}
