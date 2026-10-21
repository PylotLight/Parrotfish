// Parrotfish main process: wires profiles, the orchestrator, mic VAD, sidecars, Phonon and Bench
// to the renderer over IPC.
import { BrowserWindow, app, dialog, ipcMain, session, systemPreferences, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron'
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
import { localLoopProfile } from '../shared/profile'
import type { LocalInferenceStatus } from '../shared/local-inference'
import { ParakeetEngine } from './parakeet/engine-host'
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
  const localStatus = new Map<LocalInferenceStatus['stage'], LocalInferenceStatus>([
    ['stt', { stage: 'stt', state: 'idle', label: 'Parakeet TDT 0.6B v2', detail: 'Prepare models to download and select the fastest available backend.' }],
    ['tts', { stage: 'tts', state: 'idle', label: 'Phonon 31m', backend: 'CPU / WASM', detail: 'Validated CPU path; downloaded assets are cached locally.' }]
  ])
  const updateLocal = (status: LocalInferenceStatus): void => {
    localStatus.set(status.stage, status)
    send('local:status', status)
  }
  const downloads = new PhononDownloads(join(userData, 'phonon'), (p) => {
    send('phonon:progress', p)
    updateLocal({ stage: 'tts', state: p.error ? 'error' : p.done ? 'loading' : 'downloading', label: 'Phonon 31m', backend: 'CPU / WASM', detail: p.error || p.label, received: p.received, total: p.total })
  })
  const phonon = new PhononEngine(downloads, (l) => log('phonon', l), (info) => {
    updateLocal({ stage: 'tts', state: 'ready', label: 'Phonon 31m', backend: 'CPU / WASM', detail: `Loaded in ${info.loadMs} ms · ${info.threads} threads. Validated CPU runtime retained; no unverified GPU substitution.` })
  }, (message) => updateLocal({ stage: 'tts', state: 'error', label: 'Phonon 31m', backend: 'CPU / WASM', detail: `${message} Try Prepare models again; check Logs if it persists.` }))
  const parakeet = new ParakeetEngine({ userData, onStatus: updateLocal, log: (line: string) => log('parakeet', line) })
  const host = createHost({ userData, log, phonon, parakeet })
  let warming: Promise<{ ok: boolean; error?: string }> | null = null
  function warmLocal(): Promise<{ ok: boolean; error?: string }> {
    if (warming) return warming
    updateLocal({ stage: 'tts', state: 'loading', label: 'Phonon 31m', backend: 'CPU / WASM', detail: 'Checking local assets and starting inference worker…' })
    warming = Promise.allSettled([parakeet.warm(), phonon.warm()]).then((results) => {
      const errors = results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return []
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        const stage = index === 0 ? 'stt' : 'tts'
        updateLocal({ stage, state: 'error', label: index === 0 ? 'Parakeet TDT 0.6B v2' : 'Phonon 31m', detail: `${message} Retry Prepare models; check network, free disk space and Logs.` })
        return [message]
      })
      return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true }
    }).finally(() => { warming = null })
    return warming
  }
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
  let micEpoch = 0

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
    const epoch = micEpoch
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      if (!ok) return (mic = { on: false, vad: '', error: 'Microphone access was denied (System Settings > Privacy & Security > Microphone).' })
    }
    if (store.active.stt.provider === 'parakeet-local') {
      const ready = await warmLocal()
      if (!ready.ok) return { on: false, vad: '', error: ready.error }
    }
    if (epoch !== micEpoch) return mic
    const { vad, name, error } = await openVad()
    if (epoch !== micEpoch) { vad.release(); return mic }
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
    micEpoch += 1
    listener?.close()
    listener = null
    mic = { on: false, vad: '' }
    send('mic', mic)
    return mic
  }

  function profileChanged(): void {
    micEpoch += 1
    sidecars.sync(store.active.sidecars)
    send('profiles:changed', { active: store.activeProfileName })
    if (listener) void startMic()
  }

  // ---- mic permission for the app window only (audio, never video)
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    callback(contents === win?.webContents && permission === 'media' && types.every((t) => t === 'audio'))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === win?.webContents && permission === 'media')

  // ---- IPC: only the app's top-level frame can invoke the public app bridge.
  // Engine workers have separate, capability-limited preload bridges.
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent): boolean =>
    !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('Untrusted IPC sender')
      return listener(event, ...args)
    })
  }
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (trusted(event)) listener(event, ...args)
    })
  }
  handle('profiles:list', () => ({ names: store.names(), active: store.activeProfileName, builtins: store.builtins }))
  handle('profiles:get', (_e, name: string) => store.get(name))
  handle('profiles:save', (_e, raw: unknown, previousName?: string) => {
    const result = store.save(raw, previousName)
    if (result.profile.name === store.activeProfileName || previousName === store.activeProfileName) profileChanged()
    return result
  })
  handle('profiles:remove', (_e, name: string) => {
    store.remove(name)
    profileChanged()
  })
  handle('profiles:setActive', (_e, name: string) => {
    store.setActive(name)
    profileChanged()
  })
  handle('profiles:providers', () => describeProviders())

  handle('turns:text', (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length > 16_000) throw new Error('Text must be a string under 16,000 characters')
    return orchestrator.runTurn({ source: 'text', text })
  })
  handle('turns:cancel', () => void orchestrator.cancel())
  handle('turns:history', () => orchestrator.history)
  handle('turns:approval', (_e, id: string, ok: boolean) => {
    approvals.get(id)?.(!!ok)
    approvals.delete(id)
  })

  handle('mic:start', () => startMic())
  handle('mic:stop', () => stopMic())
  on('mic:frames', (_e, samples: unknown) => {
    if (!(samples instanceof Float32Array) || samples.length > 16_000 || !samples.every(Number.isFinite)) return
    listener?.push(samples)
  })
  on('audio:started', (_e, turnId: string) => sink.started(turnId))
  on('audio:idle', () => orchestrator.audioIdle())

  let benchAbort: AbortController | null = null
  handle('bench:pickWavs', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Bench WAV files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'WAV audio', extensions: ['wav'] }] })
    return r.canceled ? [] : r.filePaths
  })
  handle('bench:run', async (_e, req: BenchRequest) => {
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
  handle('bench:cancel', () => benchAbort?.abort())
  handle('bench:export', async (_e, report: unknown) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export bench results', defaultPath: `parrotfish-bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, `${JSON.stringify(report, null, 2)}\n`)
    return r.filePath
  })

  handle('sidecars:list', () => sidecars.list())
  handle('sidecars:start', (_e, id: string) => sidecars.start(id))
  handle('sidecars:stop', (_e, id: string) => sidecars.stop(id))
  handle('sidecars:logs', (_e, id: string) => sidecars.logs(id))

  handle('local:status', () => [...localStatus.values()])
  handle('local:warm', () => warmLocal())

  handle('phonon:warm', async () => {
    try {
      await phonon.warm()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send('phonon:progress', { label: 'Phonon', received: 0, total: 0, done: true, error: message })
      return { ok: false, error: message }
    }
  })
  handle('phonon:voices', async () => {
    try {
      const jsonl = await downloads.catalog()
      return [MODEL_VOICE, ...parseVoiceCatalog(jsonl, { base: VOICES_REPO, hashes: ENGLISH_VOICE_SHA256 }).map(publicVoice)]
    } catch (error) {
      log('phonon', `voice catalog: ${error instanceof Error ? error.message : String(error)}`)
      return [MODEL_VOICE]
    }
  })
  handle('logs:get', () => logs)
  handle('speak', async (_e, text: string) => {
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
    parakeet.dispose()
  })
  log('app', `Parrotfish ${app.getVersion()} on Electron ${process.versions.electron}, profile "${store.activeProfileName}"`)

  // Smoke test (unpackaged only): `PARROTFISH_SMOKE=1 electron .` boots the window, runs one typed
  // turn on the Mock profile through the real IPC/audio path, prints the record and quits.
  if (!app.isPackaged && process.env.PARROTFISH_SMOKE) {
    win.webContents.on('console-message', (event) => console.log(`[renderer] ${(event as unknown as { message: string; lineNumber: number; sourceId: string }).message} @${(event as unknown as { sourceId: string }).sourceId}:${(event as unknown as { lineNumber: number }).lineNumber}`))
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
        // Silero VAD through onnxruntime-node inside Electron main (downloads the 2.3 MB model)
        const vad = await createProvider('vad', store.get('default')).open(host)
        const tone = Float32Array.from({ length: 512 }, (_, i) => 0.4 * Math.sin(i / 3))
        const silero = { silence: await vad.process(new Float32Array(512)), tone: await vad.process(tone) }
        vad.release()
        if (process.env.PARROTFISH_SMOKE_SHOT) await writeFile(process.env.PARROTFISH_SMOKE_SHOT, (await win!.webContents.capturePage()).toPNG())
        if (process.env.PARROTFISH_SMOKE_PHONON) {
          // the real default TTS: downloads Phonon 31m (~71 MB) on first run, then speaks through the engine window
          const mock = store.get('Mock')
          const phononProfile = { ...mock, name: 'smoke-phonon', tts: { provider: 'phonon-wasm', options: { voice: 'default', speed: 1.5 } } }
          store.save(phononProfile)
          const third = await orchestrator.runTurn({ source: 'text', text: 'say hello', profile: store.get('smoke-phonon'), isolated: true, sink: { begin: (_id, onStart) => onStart(), write: () => undefined, end: () => undefined, stop: () => undefined } })
          console.log(`PARROTFISH_SMOKE_PHONON ${JSON.stringify({ status: third.status, error: third.error, marks: third.timings.marks, load: phonon.lastLoad })}`)
          store.remove('smoke-phonon')
        }
        if (process.env.PARROTFISH_SMOKE_LOCAL) {
          const started = Date.now()
          const readiness = await warmLocal()
          if (!readiness.ok) throw new Error(readiness.error)
          const wavPath = process.env.PARROTFISH_SMOKE_WAV
          if (!wavPath) throw new Error('Set PARROTFISH_SMOKE_WAV to a short mono speech WAV')
          const wav = decodeWav(new Uint8Array(await readFile(wavPath)))
          let samples = 0
          const local = await orchestrator.runTurn({ source: 'mic', audio: { samples: resample(wav.samples, wav.sampleRate, 16000), sampleRate: 16000 }, profile: localLoopProfile(), isolated: true, sink: { begin: (_id, onStart) => onStart(), write: (chunkId, chunk) => { samples += chunk.samples.length }, end: () => undefined, stop: () => undefined } })
          await win!.webContents.executeJavaScript('window.parrotfish.profiles.setActive("Local loop")')
          await new Promise((resolve) => setTimeout(resolve, 250))
          const localUi = await win!.webContents.executeJavaScript('window.parrotfish.local.status().then(models => ({ hasModelPanel: !!document.querySelector(".local-readiness"), models }))')
          if (!localUi.hasModelPanel || !localUi.models.every((model: LocalInferenceStatus) => model.state === 'ready')) throw new Error('Local model readiness UI did not become ready')
          console.log(`PARROTFISH_SMOKE_LOCAL ${JSON.stringify({ localUi, status: local.status, transcript: local.transcript, reply: local.reply, samples, error: local.error, elapsedMs: Date.now() - started, models: [...localStatus.values()] })}`)
          if (local.status !== 'done' || !local.transcript.trim() || samples === 0) throw new Error('Local loop real-inference smoke failed')
        }
        exit(hasApi && record.status === 'done' && second.status === 'done' ? 0 : 1, { hasApi, silero, first: { status: record.status, route: record.decision?.action, reply: record.reply, timings: record.timings }, second: { status: second.status, v2v: second.timings.voiceToVoiceMs, marks: second.timings.marks, error: second.error } })
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
