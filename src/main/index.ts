// Parrotfish main process: wires profiles, the orchestrator, mic VAD, sidecars, Phonon and Bench
// to the renderer over IPC.
import { BrowserWindow, app, dialog, ipcMain, session, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { decodeWav, resample } from '../core/audio'
import { runBench, type BenchCase } from '../core/bench'
import { Listener } from '../core/listener'
import { Orchestrator } from '../core/orchestrator'
import { createProvider, describeProviders } from '../core/registry'
import type { VadSession } from '../core/providers/types'
import type { AudioSink } from '../core/speech-queue'
import { splitAll } from '../core/splitter'
import type { BenchRequest, EventMap, LogLine, MicStatus } from '../shared/api'
import { parseVoiceCatalog, publicVoice, MODEL_VOICE, ENGLISH_VOICE_SHA256, VOICES_REPO } from '../shared/phonon-voices'
import type { ApprovalRequest } from '../shared/types'
import { createHost } from './host'
import { PhononDownloads } from './phonon/downloads'
import { PhononEngine, registerTtsScheme } from './phonon/engine-host'
import { ProfileStore } from './profiles'
import { SidecarManager } from './sidecars'
import { createMainWindow } from './window'

registerTtsScheme()
if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null

function send<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

const logs: LogLine[] = []
function log(scope: string, line: string): void {
  const entry = { at: Date.now(), scope, line }
  logs.push(entry)
  if (logs.length > 2000) logs.splice(0, logs.length - 2000)
  send('log', entry)
  if (!app.isPackaged) console.log(`[${scope}] ${line}`)
}

/** Forwards audio to the window's player; the player says when the first sample plays. */
class RendererSink implements AudioSink {
  private readonly starts = new Map<string, () => void>()
  begin(turnId: string, onStart: () => void): void {
    this.starts.set(turnId, onStart)
    send('audio:begin', turnId)
  }
  write(turnId: string, chunk: { samples: Float32Array; sampleRate: number }): void {
    send('audio:chunk', { turnId, samples: chunk.samples, sampleRate: chunk.sampleRate })
  }
  end(turnId: string): void {
    send('audio:end', turnId)
  }
  stop(): void {
    this.starts.clear()
    send('audio:stop', null)
  }
  started(turnId: string): void {
    this.starts.get(turnId)?.()
    this.starts.delete(turnId)
  }
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const store = new ProfileStore(userData)
  const downloads = new PhononDownloads(join(userData, 'phonon'), (p) => send('phonon:progress', p))
  const phonon = new PhononEngine(downloads, (l) => log('phonon', l))
  const host = createHost({ userData, log, phonon })
  const sink = new RendererSink()
  const approvals = new Map<string, (ok: boolean) => void>()

  const orchestrator = new Orchestrator({
    host,
    sink,
    getProfile: () => store.active,
    emit: (event) => send('turn:event', event),
    onState: (state) => send('state', state),
    approve: (request: ApprovalRequest, signal) =>
      new Promise<boolean>((resolve) => {
        approvals.set(request.id, resolve)
        signal.addEventListener('abort', () => resolve(false), { once: true })
        send('approval:request', request)
      })
  })

  const sidecars = new SidecarManager(
    (s) => send('sidecar', s),
    (id, line) => send('sidecar:log', { id, line })
  )
  sidecars.sync(store.active.sidecars)

  // ---- mic: renderer frames -> VAD -> segmenter -> orchestrator
  let listener: Listener | null = null
  let mic: MicStatus = { on: false, vad: '' }
  let lastLevel = 0

  async function openVad(): Promise<{ vad: VadSession; name: string; error?: string }> {
    const profile = store.active
    try {
      return { vad: await createProvider('vad', profile).open(host), name: profile.vad.provider }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('vad', `${profile.vad.provider} failed (${message}), using energy VAD`)
      const fallback = { ...profile, vad: { ...profile.vad, provider: 'energy' } }
      return { vad: await createProvider('vad', fallback).open(host), name: 'energy', error: `${profile.vad.provider}: ${message}` }
    }
  }

  async function startMic(): Promise<MicStatus> {
    stopMic()
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      if (!ok) return (mic = { on: false, vad: '', error: 'Microphone access was denied (System Settings > Privacy & Security > Microphone).' })
    }
    const { vad, name, error } = await openVad()
    const profile = store.active
    listener = new Listener(vad, profile.vad, {
      onSpeechStart: () => {
        if (orchestrator.onSpeechStart()) log('turn', 'barge-in: cancelled the agent')
      },
      onUtterance: (audio) => void orchestrator.onUtterance({ samples: audio, sampleRate: 16000 }, store.active.vad.minSilenceMs),
      onLevel: (p, speaking) => {
        const now = Date.now()
        if (now - lastLevel > 50) {
          lastLevel = now
          send('level', { p, speaking })
        }
      }
    })
    mic = { on: true, vad: name, ...(error ? { error } : {}) }
    send('mic', mic)
    return mic
  }

  function stopMic(): MicStatus {
    listener?.close()
    listener = null
    mic = { on: false, vad: '' }
    send('mic', mic)
    return mic
  }

  function profileChanged(): void {
    sidecars.sync(store.active.sidecars)
    send('profiles:changed', { active: store.activeProfileName })
    if (listener) void startMic()
  }

  // ---- mic permission for the app window only (audio, never video)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    callback(permission === 'media' && types.every((t) => t === 'audio'))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  // ---- IPC
  ipcMain.handle('profiles:list', () => ({ names: store.names(), active: store.activeProfileName, builtins: store.builtins }))
  ipcMain.handle('profiles:get', (_e, name: string) => store.get(name))
  ipcMain.handle('profiles:save', (_e, raw: unknown, previousName?: string) => {
    const result = store.save(raw, previousName)
    if (result.profile.name === store.activeProfileName || previousName === store.activeProfileName) profileChanged()
    return result
  })
  ipcMain.handle('profiles:remove', (_e, name: string) => {
    store.remove(name)
    profileChanged()
  })
  ipcMain.handle('profiles:setActive', (_e, name: string) => {
    store.setActive(name)
    profileChanged()
  })
  ipcMain.handle('profiles:providers', () => describeProviders())

  ipcMain.handle('turns:text', (_e, text: string) => orchestrator.runTurn({ source: 'text', text: String(text) }))
  ipcMain.handle('turns:cancel', () => void orchestrator.cancel())
  ipcMain.handle('turns:history', () => orchestrator.history)
  ipcMain.handle('turns:approval', (_e, id: string, ok: boolean) => {
    approvals.get(id)?.(!!ok)
    approvals.delete(id)
  })

  ipcMain.handle('mic:start', () => startMic())
  ipcMain.handle('mic:stop', () => stopMic())
  ipcMain.on('mic:frames', (_e, samples: Float32Array) => listener?.push(samples instanceof Float32Array ? samples : new Float32Array(samples)))
  ipcMain.on('audio:started', (_e, turnId: string) => sink.started(turnId))
  ipcMain.on('audio:idle', () => orchestrator.audioIdle())

  let benchAbort: AbortController | null = null
  ipcMain.handle('bench:pickWavs', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Bench WAV files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'WAV audio', extensions: ['wav'] }] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('bench:run', async (_e, req: BenchRequest) => {
    benchAbort?.abort()
    benchAbort = new AbortController()
    const cases: BenchCase[] = []
    for (const path of req.wavPaths) {
      const wav = decodeWav(new Uint8Array(await readFile(path)))
      const txt = path.replace(/\.wav$/i, '.txt')
      const hint = existsSync(txt) ? (await readFile(txt, 'utf8')).trim() : undefined
      cases.push({ name: basename(path), audio: { samples: resample(wav.samples, wav.sampleRate, 16000), sampleRate: 16000, ...(hint ? { hint } : {}) } })
    }
    for (const text of req.texts) if (text.trim()) cases.push({ name: `"${text.trim().slice(0, 40)}"`, text: text.trim() })
    const profiles = req.profiles.map((n) => store.get(n))
    return runBench(orchestrator, cases, profiles, { repeats: req.repeats, signal: benchAbort.signal, onRow: (row, done, total) => send('bench:row', { row, done, total }) })
  })
  ipcMain.handle('bench:cancel', () => benchAbort?.abort())
  ipcMain.handle('bench:export', async (_e, report: unknown) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export bench results', defaultPath: `parrotfish-bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, `${JSON.stringify(report, null, 2)}\n`)
    return r.filePath
  })

  ipcMain.handle('sidecars:list', () => sidecars.list())
  ipcMain.handle('sidecars:start', (_e, id: string) => sidecars.start(id))
  ipcMain.handle('sidecars:stop', (_e, id: string) => sidecars.stop(id))
  ipcMain.handle('sidecars:logs', (_e, id: string) => sidecars.logs(id))

  ipcMain.handle('phonon:warm', async () => {
    try {
      await phonon.warm()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send('phonon:progress', { label: 'Phonon', received: 0, total: 0, done: true, error: message })
      return { ok: false, error: message }
    }
  })
  ipcMain.handle('phonon:voices', async () => {
    try {
      const jsonl = await downloads.catalog()
      return [MODEL_VOICE, ...parseVoiceCatalog(jsonl, { base: VOICES_REPO, hashes: ENGLISH_VOICE_SHA256 }).map(publicVoice)]
    } catch (error) {
      log('phonon', `voice catalog: ${error instanceof Error ? error.message : String(error)}`)
      return [MODEL_VOICE]
    }
  })
  ipcMain.handle('logs:get', () => logs)
  ipcMain.handle('speak', async (_e, text: string) => {
    const profile = store.active
    const tts = createProvider('tts', profile)
    const controller = new AbortController()
    const turnId = `egg-${Date.now()}`
    let began = false
    for (const sentence of splitAll(String(text), profile.splitter)) {
      for await (const chunk of tts.synthesize(sentence, { signal: controller.signal, host })) {
        if (!began) {
          began = true
          sink.begin(turnId, () => undefined)
        }
        sink.write(turnId, chunk)
      }
    }
    if (began) sink.end(turnId)
  })

  win = createMainWindow()
  win.on('closed', () => (win = null))
  app.on('activate', () => {
    if (!win) win = createMainWindow()
  })
  app.on('before-quit', () => {
    stopMic()
    orchestrator.cancel()
    sidecars.stopAll()
    phonon.dispose()
  })
  log('app', `Parrotfish ${app.getVersion()} on Electron ${process.versions.electron}, profile "${store.activeProfileName}"`)

  // Smoke test (unpackaged only): `PARROTFISH_SMOKE=1 electron .` boots the window, runs one typed
  // turn on the Mock profile through the real IPC/audio path, prints the record and quits.
  if (!app.isPackaged && process.env.PARROTFISH_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const exit = (code: number, payload: unknown): void => {
        console.log(`PARROTFISH_SMOKE ${JSON.stringify(payload)}`)
        app.exit(code)
      }
      try {
        store.setActive('Mock')
        const hasApi = await win!.webContents.executeJavaScript('typeof window.parrotfish === "object" && !!document.querySelector(".titlebar")')
        const record = await orchestrator.runTurn({ source: 'text', text: 'what is the uptime' })
        const second = await orchestrator.runTurn({ source: 'text', text: 'tell me something nice' })
        exit(hasApi && record.status === 'done' && second.status === 'done' ? 0 : 1, { hasApi, first: { status: record.status, route: record.decision?.action, reply: record.reply, timings: record.timings }, second: { status: second.status, v2v: second.timings.voiceToVoiceMs, marks: second.timings.marks, error: second.error } })
      } catch (error) {
        exit(1, { error: error instanceof Error ? error.message : String(error) })
      }
    })
  }
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
