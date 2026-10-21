// The Node/Electron implementation of core's Host: fetch, process spawning with the user's login
// PATH (a Finder-launched app gets a bare PATH), files, onnxruntime-node and model downloads.
import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Host, OnnxHost, OnnxSession, PhononHost, SpawnedProcess } from '../core/providers/types'

export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

let cachedPath: string | null = null

/** PATH from the login shell (bash, zsh and fish all take -ilc), plus the usual tool folders. */
export function loginPath(): string {
  if (cachedPath) return cachedPath
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.bun/bin'), join(homedir(), '.cargo/bin')]
  let fromShell = ''
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      const r = spawnSync(shell, ['-ilc', 'printf "__PF__%s" "$PATH"'], { encoding: 'utf8', timeout: 4000 })
      fromShell = /__PF__(.*)$/s.exec(r.stdout ?? '')?.[1]?.trim() ?? ''
    } catch {
      // fall through
    }
  }
  const parts = [...(fromShell || process.env.PATH || '').split(':'), ...extra].filter(Boolean)
  cachedPath = [...new Set(parts)].join(':')
  return cachedPath
}

export function spawnProcess(command: string, args: string[], options: { cwd?: string; signal: AbortSignal; stdin?: string; env?: Record<string, string> }): SpawnedProcess {
  const child = spawnChild(command, args, {
    cwd: options.cwd ? expandHome(options.cwd) : undefined,
    env: { ...process.env, PATH: loginPath(), ...options.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-8192)
  })
  const exit = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      stderr += `\n${e.message}`
      resolve(-1)
    })
    child.on('close', (code) => resolve(code))
  })
  const kill = (): void => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  options.signal.addEventListener('abort', kill, { once: true })
  if (options.stdin !== undefined) child.stdin?.end(options.stdin)
  else child.stdin?.end()
  const rl = createInterface({ input: child.stdout! })
  return { lines: rl, stderr: () => stderr, exit, kill }
}

function onnxHost(modelsDir: string, log: (l: string) => void): OnnxHost {
  return {
    async load(path) {
      const ort = await import('onnxruntime-node')
      const session = await ort.InferenceSession.create(path, { intraOpNumThreads: 1, interOpNumThreads: 1 })
      const wrapped: OnnxSession = {
        async run(feeds) {
          const input: Record<string, InstanceType<typeof ort.Tensor>> = {}
          for (const [k, v] of Object.entries(feeds)) input[k] = new ort.Tensor(v.type, v.data, v.dims)
          const out = await session.run(input)
          const result: Record<string, { data: Float32Array; dims: number[] }> = {}
          for (const [k, v] of Object.entries(out)) result[k] = { data: v.data as Float32Array, dims: [...v.dims] }
          return result
        },
        release() {
          void session.release()
        }
      }
      return wrapped
    },
    async ensureModel(name, url, sha256, bytes) {
      const path = join(modelsDir, name)
      if (existsSync(path)) {
        const got = createHash('sha256').update(await readFile(path)).digest('hex')
        if (got === sha256) return path
        log(`${name}: checksum changed on disk, downloading again`)
      }
      log(`downloading ${name} (${Math.round(bytes / 1024)} KB)`)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
      const data = new Uint8Array(await response.arrayBuffer())
      const got = createHash('sha256').update(data).digest('hex')
      if (got !== sha256) throw new Error(`${name}: checksum mismatch`)
      await mkdir(modelsDir, { recursive: true })
      await writeFile(`${path}.part`, data)
      await rename(`${path}.part`, path)
      return path
    }
  }
}

export function createHost(options: { userData: string; log: (scope: string, line: string) => void; phonon?: PhononHost }): Host {
  const modelsDir = join(options.userData, 'models')
  const notesDir = join(options.userData, 'notes')
  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch,
    spawn: (command, args, opts) => spawnProcess(command, args, opts),
    phonon: options.phonon,
    onnx: onnxHost(modelsDir, (l) => options.log('models', l)),
    modelsDir,
    notesDir,
    files: {
      read: async (path) => new Uint8Array(await readFile(expandHome(path))),
      async write(path, data) {
        const p = expandHome(path)
        await mkdir(dirname(p), { recursive: true })
        await writeFile(p, data)
      },
      temp: (ext) => join(tmpdir(), `parrotfish-${randomUUID()}.${ext}`),
      remove: (path) => rm(expandHome(path), { force: true })
    },
    log: options.log
  }
}
