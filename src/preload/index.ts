// Preload for the app window: exposes window.parrotfish (typed in src/shared/api.ts).
import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, type EventMap, type ParrotfishApi } from '../shared/api'

const api: ParrotfishApi = {
  platform: process.platform,
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    get: (name) => ipcRenderer.invoke('profiles:get', name),
    save: (raw, previousName) => ipcRenderer.invoke('profiles:save', raw, previousName),
    remove: (name) => ipcRenderer.invoke('profiles:remove', name),
    setActive: (name) => ipcRenderer.invoke('profiles:setActive', name),
    providers: () => ipcRenderer.invoke('profiles:providers')
  },
  turns: {
    text: (text) => ipcRenderer.invoke('turns:text', text),
    cancel: () => ipcRenderer.invoke('turns:cancel'),
    history: () => ipcRenderer.invoke('turns:history'),
    answerApproval: (id, ok) => ipcRenderer.invoke('turns:approval', id, ok)
  },
  mic: {
    start: () => ipcRenderer.invoke('mic:start'),
    stop: () => ipcRenderer.invoke('mic:stop'),
    frames: (samples) => ipcRenderer.send('mic:frames', samples)
  },
  audio: {
    started: (turnId) => ipcRenderer.send('audio:started', turnId),
    idle: () => ipcRenderer.send('audio:idle')
  },
  bench: {
    pickWavs: () => ipcRenderer.invoke('bench:pickWavs'),
    run: (request) => ipcRenderer.invoke('bench:run', request),
    cancel: () => ipcRenderer.invoke('bench:cancel'),
    exportJson: (report) => ipcRenderer.invoke('bench:export', report)
  },
  sidecars: {
    list: () => ipcRenderer.invoke('sidecars:list'),
    start: (id) => ipcRenderer.invoke('sidecars:start', id),
    stop: (id) => ipcRenderer.invoke('sidecars:stop', id),
    logs: (id) => ipcRenderer.invoke('sidecars:logs', id)
  },
  phonon: {
    warm: () => ipcRenderer.invoke('phonon:warm'),
    voices: () => ipcRenderer.invoke('phonon:voices')
  },
  logs: () => ipcRenderer.invoke('logs:get'),
  speak: (text) => ipcRenderer.invoke('speak', text),
  on(channel, listener) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`unknown channel ${String(channel)}`)
    const wrapped = (_e: unknown, payload: EventMap[typeof channel]): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('parrotfish', api)
