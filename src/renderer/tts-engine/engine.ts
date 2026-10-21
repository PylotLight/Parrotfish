// Hidden Phonon engine page: an IPC bridge only. CPU inference runs in its dedicated module worker.
import type { EngineCommand, EngineEvent } from '../../shared/tts-engine'

interface Bridge {
  onCommand(cb: (c: EngineCommand) => void): void
  send(e: EngineEvent): void
}
const bridge = (window as unknown as { parrotfishEngine?: Bridge }).parrotfishEngine
const worker = new Worker(new URL('./phonon-worker.ts', import.meta.url), { type: 'module' })
const active = new Set<number>()

worker.onmessage = (event: MessageEvent<EngineEvent>) => {
  const message = event.data
  if (message.type === 'done' || message.type === 'error') active.delete(message.id)
  bridge?.send(message)
}
let failed = false
function failWorker(message: string): void {
  if (failed) return
  failed = true
  for (const id of active) bridge?.send({ type: 'error', id, message: `${message}. Retry the request to restart the local speech engine.` })
  active.clear()
  bridge?.send({ type: 'worker-error', message })
}
worker.onerror = (event) => {
  event.preventDefault()
  console.error('Phonon inference worker failed', event.message)
  failWorker(event.message || 'Phonon inference worker failed')
}
worker.onmessageerror = () => {
  failWorker('Could not read a message from the Phonon inference worker')
}
bridge?.onCommand((command) => {
  if (failed) return
  if (command.type === 'speak') active.add(command.id)
  worker.postMessage(command)
})
bridge?.send({ type: 'ready' })
