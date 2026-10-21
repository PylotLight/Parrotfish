// Sidecar manager: start/stop the local servers a profile needs (llama-server, parakeet-api, ...)
// through the login shell, keep their logs, and poll their health URL while they run.
import { spawn, type ChildProcess } from 'node:child_process'
import type { SidecarConfig } from '../shared/profile'
import type { SidecarState } from '../shared/api'
import { expandHome, loginPath } from './host'

interface Running {
  config: SidecarConfig
  child: ChildProcess | null
  state: SidecarState
  logs: string[]
  timer: ReturnType<typeof setInterval> | null
}

const MAX_LOG_LINES = 800

export class SidecarManager {
  private readonly items = new Map<string, Running>()

  constructor(
    private readonly onState: (state: SidecarState) => void,
    private readonly onLog: (id: string, line: string) => void
  ) {}

  /** The active profile's sidecar list; running ones keep running across profile switches. */
  sync(configs: SidecarConfig[]): void {
    for (const c of configs) {
      const existing = this.items.get(c.id)
      if (existing) {
        existing.config = c
        existing.state = { ...existing.state, label: c.label, command: c.command, healthUrl: c.healthUrl }
      } else {
        this.items.set(c.id, { config: c, child: null, logs: [], timer: null, state: { id: c.id, label: c.label, command: c.command, healthUrl: c.healthUrl, status: 'stopped', detail: '' } })
      }
    }
    for (const [id, r] of this.items) if (!configs.some((c) => c.id === id) && !r.child) this.items.delete(id)
    for (const c of configs) if (c.autoStart) this.start(c.id)
  }

  list(): SidecarState[] {
    return [...this.items.values()].map((r) => r.state)
  }

  logs(id: string): string[] {
    return this.items.get(id)?.logs ?? []
  }

  private update(r: Running, patch: Partial<SidecarState>): void {
    r.state = { ...r.state, ...patch }
    this.onState(r.state)
  }

  private log(r: Running, line: string): void {
    r.logs.push(line)
    if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES)
    this.onLog(r.config.id, line)
  }

  start(id: string): void {
    const r = this.items.get(id)
    if (!r || r.child) return
    const shell = process.env.SHELL || '/bin/zsh'
    this.log(r, `$ ${r.config.command}`)
    const child = spawn(shell, ['-lc', r.config.command], {
      cwd: r.config.cwd ? expandHome(r.config.cwd) : expandHome('~'),
      env: { ...process.env, PATH: loginPath() },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    r.child = child
    this.update(r, { status: 'starting', pid: child.pid, exitCode: undefined, detail: '' })
    const onData = (d: Buffer): void => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.log(r, line)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => this.log(r, `spawn failed: ${e.message}`))
    child.on('close', (code) => {
      r.child = null
      if (r.timer) clearInterval(r.timer)
      r.timer = null
      this.log(r, `exited with ${code}`)
      this.update(r, { status: r.state.status === 'stopped' ? 'stopped' : 'exited', exitCode: code, pid: undefined })
    })
    if (r.config.healthUrl) {
      r.timer = setInterval(() => void this.probe(r), 2000)
      void this.probe(r)
    } else {
      this.update(r, { status: 'healthy', detail: 'no health URL; assumed up while running' })
    }
  }

  private async probe(r: Running): Promise<void> {
    if (!r.child || !r.config.healthUrl) return
    try {
      const res = await fetch(r.config.healthUrl, { signal: AbortSignal.timeout(1500) })
      const ok = res.status < 500
      if (!r.child) return
      this.update(r, { status: ok ? 'healthy' : r.state.status === 'healthy' ? 'unhealthy' : 'starting', detail: `HTTP ${res.status}` })
    } catch (e) {
      if (!r.child) return
      this.update(r, { status: r.state.status === 'healthy' ? 'unhealthy' : 'starting', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  stop(id: string): void {
    const r = this.items.get(id)
    if (!r?.child) return
    const pid = r.child.pid
    this.update(r, { status: 'stopped' })
    try {
      // the whole process group: the login shell and the server it started
      if (pid) process.kill(-pid, 'SIGTERM')
    } catch {
      r.child.kill('SIGTERM')
    }
  }

  stopAll(): void {
    for (const id of this.items.keys()) this.stop(id)
  }
}
