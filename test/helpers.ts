// Test doubles: a host with no network, a sink that records, a fake clock-friendly orchestrator.
import { mockProfile, type Profile } from '../src/shared/profile'
import type { ApprovalRequest, TurnEvent } from '../src/shared/types'
import { Orchestrator } from '../src/core/orchestrator'
import type { Host, SpawnedProcess } from '../src/core/providers/types'
import type { AudioSink } from '../src/core/speech-queue'

export function fakeHost(overrides: Partial<Host> = {}): Host & { logs: string[]; written: Record<string, string>; spawned: string[][] } {
  const logs: string[] = []
  const written: Record<string, string> = {}
  const spawned: string[][] = []
  return {
    logs,
    written,
    spawned,
    fetch: (async () => {
      throw new Error('network disabled in tests')
    }) as unknown as typeof fetch,
    spawn(command, args): SpawnedProcess {
      spawned.push([command, ...args])
      const out = command === 'uptime' ? ['10:00  up 3 days, 2 users'] : []
      return {
        lines: (async function* () {
          yield* out
        })(),
        stderr: () => '',
        exit: Promise.resolve(0),
        kill() {}
      }
    },
    modelsDir: '/tmp/models',
    notesDir: '/tmp/notes',
    files: {
      async read() {
        return new Uint8Array()
      },
      async write(path, data) {
        written[path] = typeof data === 'string' ? data : new TextDecoder().decode(data)
      },
      temp: (ext) => `/tmp/x.${ext}`,
      async remove() {}
    },
    log(scope, line) {
      logs.push(`${scope}: ${line}`)
    },
    ...overrides
  }
}

export class RecordingSink implements AudioSink {
  began: string[] = []
  ended: string[] = []
  stops = 0
  samples = 0
  begin(turnId: string, onStart: () => void): void {
    this.began.push(turnId)
    onStart()
  }
  write(_turnId: string, chunk: { samples: Float32Array }): void {
    this.samples += chunk.samples.length
  }
  end(turnId: string): void {
    this.ended.push(turnId)
  }
  stop(): void {
    this.stops++
  }
}

/** Mock profile with every delay shrunk so tests run fast. */
export function fastMock(patch: (p: Profile) => void = () => {}): Profile {
  const p = mockProfile()
  p.stt.options = { delayMs: 5, text: 'tell me a joke' }
  p.router.options = { delayMs: 2 }
  p.tools.options = { delayMs: 2 }
  p.brain.options = { delayMs: 5, tokenMs: 1 }
  p.escalation.options = { delayMs: 5 }
  p.tts.options = { delayMs: 2, msPerChar: 2, chunkDelayMs: 0, audible: false }
  patch(p)
  return p
}

export function setup(profile: Profile = fastMock(), opts: { approve?: (r: ApprovalRequest) => Promise<boolean>; host?: Host } = {}) {
  const events: TurnEvent[] = []
  const sink = new RecordingSink()
  const host = opts.host ?? fakeHost()
  let current = profile
  const orchestrator = new Orchestrator({
    host,
    sink,
    getProfile: () => current,
    emit: (e) => events.push(e),
    approve: opts.approve ?? (async () => true),
    approvalTimeoutMs: 200,
    progressGapMs: 0
  })
  return { orchestrator, events, sink, host, setProfile: (p: Profile) => (current = p) }
}

export const silence = (ms: number) => ({ samples: new Float32Array(Math.round(16 * ms)), sampleRate: 16000 })
