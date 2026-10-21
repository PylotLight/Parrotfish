import type { SttCommand, SttEvent } from '../../shared/stt-engine'
interface Bridge { onCommand(cb: (c: SttCommand) => void): void; send(e: SttEvent): void }
const bridge = (window as unknown as { parrotfishSttEngine?: Bridge }).parrotfishSttEngine
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
worker.onmessage = (e: MessageEvent<SttEvent>) => bridge?.send(e.data)
worker.onerror = (e) => { e.preventDefault(); bridge?.send({ type: 'error', message: `Inference worker crashed: ${e.message || 'unknown error'}` }) }
worker.onmessageerror = () => bridge?.send({ type: 'error', message: 'Inference worker returned an unreadable message; retry the local STT engine.' })
bridge?.onCommand((command) => worker.postMessage(command))
bridge?.send({ type: 'ready' })
