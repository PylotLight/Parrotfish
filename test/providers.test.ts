import { describe, expect, test } from 'bun:test'
import { decodeWav, encodeWav, Pcm16Stream, float32ToPcm16, resample } from '../src/core/audio'
import { chatDelta, sseData } from '../src/core/http'
import { openaiChat } from '../src/core/providers/brain/openai-chat'
import { ProgressThrottle, claudeToolLine, parseClaudeLine, parseCodexLine } from '../src/core/providers/escalation/progress'
import { claudeCode } from '../src/core/providers/escalation/cli-agent'
import { llmRouter, parseLlmRouter, routerSchema } from '../src/core/providers/router/llm-router'
import { parseSystemOne, systemOneRequest, systemOneRouter } from '../src/core/providers/router/systemone'
import { parakeetStt } from '../src/core/providers/stt/parakeet'
import { whisperCppStt } from '../src/core/providers/stt/whisper-cpp'
import { openaiTools, parseToolCalls } from '../src/core/providers/tools/openai-tools'
import { pttsOpenai } from '../src/core/providers/tts/ptts-openai'
import type { Host } from '../src/core/providers/types'
import { shellRefusal } from '../src/core/tools'
import { fakeHost } from './helpers'

type Call = { url: string; init: RequestInit }
function hostWith(respond: (call: Call) => Response): { host: Host; calls: Call[] } {
  const calls: Call[] = []
  const host = fakeHost({
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url: String(url), init }
      calls.push(call)
      return respond(call)
    }) as unknown as typeof fetch
  })
  return { host, calls }
}
const ctx = (host: Host) => ({ signal: new AbortController().signal, host })
const body = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>

describe('audio', () => {
  test('wav round trip keeps rate and samples (16-bit)', () => {
    const samples = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.5)
    const back = decodeWav(encodeWav({ samples, sampleRate: 16000 }))
    expect(back.sampleRate).toBe(16000)
    expect(back.samples.length).toBe(1600)
    expect(Math.abs(back.samples[100]! - samples[100]!)).toBeLessThan(1e-3)
  })
  test('pcm16 stream carries an odd byte across chunks', () => {
    const bytes = float32ToPcm16(Float32Array.from([0.5, -0.5, 0.25]))
    const s = new Pcm16Stream()
    const a = s.push(bytes.subarray(0, 3))
    const b = s.push(bytes.subarray(3))
    expect(a.length + b.length).toBe(3)
    expect(b[1]).toBeCloseTo(0.25, 3)
  })
  test('resample 48k -> 16k', () => {
    expect(resample(new Float32Array(4800), 48000, 16000).length).toBe(1600)
  })
})

describe('http', () => {
  test('sse data lines, split across chunks, stop at [DONE]', async () => {
    async function* chunks() {
      yield 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\nda'
      yield 'ta: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\ndata: {"ignored":1}\n'
    }
    const out: string[] = []
    for await (const d of sseData(chunks())) out.push(chatDelta(JSON.parse(d)))
    expect(out).toEqual(['Hel', 'lo'])
  })
})

describe('router providers', () => {
  test('systemone request carries the five choices, optional noul questions', () => {
    const r = systemOneRequest({ transcript: 'open safari', history: [], askEndOfTurn: true, bargeInOver: 'it is sunny' })
    const q = r.questions as Record<string, { type: string; criteria?: Record<string, string> }>
    expect(Object.keys(q.route!.criteria!)).toEqual(['reply_local', 'device_action', 'escalate', 'clarify', 'ignore'])
    expect(q.end_of_turn!.type).toBe('noul')
    expect(q.barge_in!.type).toBe('noul')
    expect((r.state as Record<string, unknown>).assistant_was_saying).toBe('it is sunny')
  })
  test('systemone answer parsing (shape from the llama.cpp decision-models post)', () => {
    const d = parseSystemOne({ answers: { route: { type: 'choice', choice: 'device_action', probabilities: { device_action: 0.9, reply_local: 0.06, escalate: 0.04 }, confidence: 0.85 }, end_of_turn: { type: 'noul', noul: 0.97 } } })
    expect(d).toMatchObject({ choice: 'device_action', confidence: 0.85, endOfTurn: 0.97 })
    expect(d.probabilities.reply_local).toBe(0.06)
  })
  test('systemone provider posts to /v1/systemone', async () => {
    const { host, calls } = hostWith(() => Response.json({ answers: { route: { choice: 'escalate', probabilities: { escalate: 0.7 }, confidence: 0.7 } } }))
    const d = await systemOneRouter({ baseUrl: 'http://127.0.0.1:8082' }).decide({ transcript: 'fix the bug in my repo', history: [], askEndOfTurn: false }, ctx(host))
    expect(calls[0]!.url).toBe('http://127.0.0.1:8082/v1/systemone')
    expect(d.choice).toBe('escalate')
  })
  test('llm router normalises scores into probabilities and sends a json_schema', async () => {
    expect(parseLlmRouter('{"scores":{"reply_local":0.2,"device_action":0.6,"escalate":0.2,"clarify":0,"ignore":0}}')).toMatchObject({ choice: 'device_action', confidence: 0.6 })
    const { host, calls } = hostWith(() => Response.json({ choices: [{ message: { content: '{"scores":{"reply_local":1,"device_action":0,"escalate":0,"clarify":0,"ignore":0}}' } }] }))
    const d = await llmRouter({}).decide({ transcript: 'hi', history: [], askEndOfTurn: false }, ctx(host))
    expect(d.choice).toBe('reply_local')
    expect((body(calls[0]!).response_format as { type: string }).type).toBe('json_schema')
    expect((routerSchema({ transcript: '', history: [], askEndOfTurn: true }).required as string[]).includes('end_of_turn')).toBe(true)
  })
})

describe('stt providers', () => {
  test('parakeet posts multipart to :8816/v1/audio/transcriptions', async () => {
    const { host, calls } = hostWith(() => Response.json({ text: ' hello world ' }))
    const r = await parakeetStt({}).transcribe({ samples: new Float32Array(1600), sampleRate: 16000 }, ctx(host))
    expect(r.text).toBe('hello world')
    expect(calls[0]!.url).toBe('http://127.0.0.1:8816/v1/audio/transcriptions')
    const form = calls[0]!.init.body as FormData
    expect(form.get('model')).toBe('mlx-community/parakeet-tdt-0.6b-v2')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })
  test('whisper.cpp posts to /inference', async () => {
    const { host, calls } = hostWith(() => Response.json({ text: 'hi' }))
    await whisperCppStt({}).transcribe({ samples: new Float32Array(160), sampleRate: 16000 }, ctx(host))
    expect(calls[0]!.url).toBe('http://127.0.0.1:8090/inference')
  })
})

describe('brain + tools + tts providers', () => {
  test('openai chat streams deltas and turns thinking off', async () => {
    const sse = ['Hi', ' there', '.'].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n'
    const { host, calls } = hostWith(() => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }))
    const out: string[] = []
    for await (const t of openaiChat({ baseUrl: 'http://x/v1' }).stream([{ role: 'user', content: 'hi' }], ctx(host))) out.push(t)
    expect(out.join('')).toBe('Hi there.')
    expect(body(calls[0]!)).toMatchObject({ stream: true, chat_template_kwargs: { enable_thinking: false } })
  })
  test('tool calls are parsed (string or object arguments)', async () => {
    expect(parseToolCalls({ tool_calls: [{ function: { name: 'open_app', arguments: '{"name":"Safari"}' } }, { function: { name: 'get_time', arguments: {} } }] }).calls).toEqual([
      { name: 'open_app', args: { name: 'Safari' } },
      { name: 'get_time', args: {} }
    ])
    const { host, calls } = hostWith(() => Response.json({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] }))
    const plan = await openaiTools({}).plan('what time is it', [{ name: 'get_time', description: '', parameters: {}, destructive: false }], ctx(host))
    expect(plan.calls[0]!.name).toBe('get_time')
    expect((body(calls[0]!).tools as unknown[]).length).toBe(1)
  })
  test('ptts-openai asks for pcm and decodes s16le 24 kHz', async () => {
    const pcm = float32ToPcm16(Float32Array.from({ length: 2400 }, () => 0.1))
    const { host, calls } = hostWith(() => new Response(pcm))
    let n = 0
    for await (const c of pttsOpenai({}).synthesize('Hello.', ctx(host))) {
      expect(c.sampleRate).toBe(24000)
      n += c.samples.length
    }
    expect(n).toBe(2400)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8880/v1/audio/speech')
    expect(body(calls[0]!)).toMatchObject({ input: 'Hello.', response_format: 'pcm' })
    expect(body(calls[0]!).speed).toBeUndefined()
  })
})

describe('escalation parsing', () => {
  test('claude stream-json: tool_use -> progress, result -> result', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/index.ts' } }, { type: 'text', text: 'Looking.' }] } }))).toEqual([
      { kind: 'progress', text: 'Reading index.ts.' },
      { kind: 'text', text: 'Looking.' }
    ])
    expect(parseClaudeLine('{"type":"result","subtype":"success","result":"Done, 3 files changed."}')).toEqual([{ kind: 'result', text: 'Done, 3 files changed.' }])
    expect(parseClaudeLine('not json')).toEqual([])
    expect(claudeToolLine('Bash', { command: 'bun test --watch' })).toBe('Running bun test.')
  })
  test('codex exec --json items', () => {
    expect(parseCodexLine('{"type":"item.started","item":{"type":"command_execution","command":"bash -lc \'ls -la\'"}}')).toEqual([{ kind: 'progress', text: 'Running ls -la.' }])
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/x.ts","kind":"update"}]}}')).toEqual([{ kind: 'progress', text: 'Edited x.ts.' }])
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"All good."}}')).toEqual([{ kind: 'text', text: 'All good.' }])
  })
  test('claude-code provider spawns claude -p with stream-json and yields events', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: {} }] } }),
      JSON.stringify({ type: 'result', result: 'Fixed it.' })
    ]
    const spawned: string[][] = []
    const host = fakeHost({
      spawn(cmd, args) {
        spawned.push([cmd, ...args])
        return { lines: (async function* () { yield* lines })(), stderr: () => '', exit: Promise.resolve(0), kill() {} }
      }
    })
    const events = []
    for await (const e of claudeCode({}).run('fix the bug', ctx(host))) events.push(e)
    expect(spawned[0]).toEqual(['claude', '-p', 'fix the bug', '--output-format', 'stream-json', '--verbose'])
    expect(events).toEqual([{ kind: 'progress', text: 'Searching the code.' }, { kind: 'result', text: 'Fixed it.' }])
  })
  test('progress throttle', () => {
    let t = 0
    const th = new ProgressThrottle(1000, () => t)
    expect(th.accept('a')).toBe(true)
    t = 500
    expect(th.accept('b')).toBe(false)
    t = 1600
    expect(th.accept('a')).toBe(false)
    expect(th.accept('c')).toBe(true)
  })
})

describe('run_shell allowlist', () => {
  const allow = ['ls', 'uptime', 'df']
  test('allows plain allowlisted commands', () => {
    expect(shellRefusal('uptime', undefined, allow)).toBeNull()
    expect(shellRefusal('ls', ['-la', 'Documents'], allow)).toBeNull()
  })
  test('refuses anything else', () => {
    expect(shellRefusal('rm', ['-rf', '/'], allow)).toContain('not on the allowlist')
    expect(shellRefusal('ls; rm -rf ~', undefined, allow)).toContain('metacharacters')
    expect(shellRefusal('ls', ['$(whoami)'], allow)).toContain('metacharacters')
    expect(shellRefusal('ls', ['~'], allow)).toContain('metacharacters')
  })
})
