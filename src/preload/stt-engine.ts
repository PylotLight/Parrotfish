import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('parrotfishSttEngine', {
  onCommand(callback: (command: unknown) => void): void { ipcRenderer.on('stt-engine:command', (_event, command: unknown) => callback(command)) },
  send(event: unknown): void { ipcRenderer.send('stt-engine:event', event) }
})
