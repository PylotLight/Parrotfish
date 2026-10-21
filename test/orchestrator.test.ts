import { describe, expect, test } from 'bun:test'
import { applyThreshold } from '../src/core/orchestrator'
import { sleep } from '../src/core/providers/types'
import { fastMock, setup, silence } from './helpers'

describe('orchestrator', () => {
  test('mic turn runs stt -> router -> brain -> tts and marks every stage in order', async () => {
    const { orchestrator, sink, events } = setup()
    const record = await orchestrator.runTurn({ source: 'mic', audio: silence(500), vadHangMs: 450 })
    expect(record.status).toBe('done')
    expect(record.transcript).toBe('tell me a joke')
    expect(record.decision?.action).toBe('reply_local')
    expect(record.reply).toContain('mock brain')
    const m = record.timings.marks
    for (const k of ['endOfSpeech', 'sttFinal', 'routerDecision', 'firstToken', 'firstSentence', 'firstAudio', 'done'] as const) expect(m[k]).toBeNumber()
    expect(m.endOfSpeech).toBe(0)
    expect(m.sttFinal!).toBeLessThanOrEqual(m.routerDecision!)
    expect(m.routerDecision!).toBeLessThanOrEqual(m.firstToken!)
    expect(m.firstToken!).toBeLessThanOrEqual(m.firstSentence!)
    expect(m.firstSentence!).toBeLessThanOrEqual(m.firstAudio!)
    expect(m.firstAudio!).toBeLessThanOrEqual(m.done!)
    expect(record.timings.voiceToVoiceMs).toBeCloseTo(m.firstAudio! - m.endOfSpeech!, 1)
    expect(record.timings.vadHangMs).toBe(450)
    expect(sink.began).toEqual([record.id])
    expect(sink.ended).toEqual([record.id])
    expect(sink.samples).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ type: 'turn-start', source: 'mic' })
    expect(events.at(-1)).toMatchObject({ type: 'turn-end' })
    expect(orchestrator.history[0]?.id).toBe(record.id)
  })

  test('text mode skips STT and has no endOfSpeech', async () => {
    const { orchestrator } = setup()
    const record = await orchestrator.runTurn({ source: 'text', text: 'hello there' })
    expect(record.transcript).toBe('hello there')
    expect(record.timings.marks.endOfSpeech).toBeUndefined()
    expect(record.timings.marks.sttFinal).toBeLessThan(5)
  })

  test('barge-in cancels the running turn and stops the sink', async () => {
    const profile = fastMock((p) => (p.brain.options = { delayMs: 5, tokenMs: 15 }))
    const { orchestrator, sink } = setup(profile)
    const running = orchestrator.runTurn({ source: 'text', text: 'talk for a while' })
    await sleep(60)
    expect(orchestrator.liveState).not.toBe('idle')
    expect(orchestrator.onSpeechStart()).toBe(true)
    const record = await running
    expect(record.status).toBe('cancelled')
    expect(sink.stops).toBeGreaterThan(0)
    expect(orchestrator.liveState).toBe('idle')
    expect(orchestrator.activeTurnId).toBeNull()
  })

  test('a new turn supersedes the one in flight', async () => {
    const profile = fastMock((p) => (p.brain.options = { delayMs: 5, tokenMs: 15 }))
    const { orchestrator } = setup(profile)
    const first = orchestrator.runTurn({ source: 'text', text: 'first' })
    await sleep(30)
    const second = await orchestrator.runTurn({ source: 'text', text: 'second' })
    expect((await first).status).toBe('cancelled')
    expect(second.status).toBe('done')
  })

  test('askBargeIn: a backchannel is ignored, a real interruption cancels', async () => {
    const profile = fastMock((p) => {
      p.router.askBargeIn = true
      p.brain.options = { delayMs: 5, tokenMs: 20 }
    })
    const { orchestrator, setProfile } = setup(profile)
    const running = orchestrator.runTurn({ source: 'text', text: 'tell me a story' })
    await sleep(40)
    expect(orchestrator.onSpeechStart()).toBe(false)
    setProfile(fastMock((p) => {
      p.router.askBargeIn = true
      p.stt.options = { delayMs: 1, text: 'mhm' }
      p.brain.options = { delayMs: 5, tokenMs: 20 }
    }))
    expect(await orchestrator.onUtterance(silence(300))).toBeNull()
    expect(orchestrator.activeTurnId).not.toBeNull()
    setProfile(fastMock((p) => {
      p.router.askBargeIn = true
      p.stt.options = { delayMs: 1, text: 'stop, tell me about cats instead' }
    }))
    const next = await orchestrator.onUtterance(silence(300))
    expect((await running).status).toBe('cancelled')
    expect(next?.status).toBe('done')
    expect(next?.transcript).toBe('stop, tell me about cats instead')
  })

  test('end-of-turn: a trailing fragment waits and is joined to the next utterance', async () => {
    const profile = fastMock((p) => {
      p.router.askEndOfTurn = true
      p.stt.options = { delayMs: 1, text: 'remind me about the meeting and' }
    })
    const { orchestrator, setProfile } = setup(profile)
    const held = await orchestrator.runTurn({ source: 'mic', audio: silence(400) })
    expect(held.reply).toBe('')
    expect(held.decision?.endOfTurn).toBeLessThan(0.5)
    setProfile(fastMock((p) => {
      p.router.askEndOfTurn = true
      p.stt.options = { delayMs: 1, text: 'the dentist tomorrow' }
    }))
    const joined = await orchestrator.runTurn({ source: 'mic', audio: silence(400) })
    expect(joined.transcript).toBe('remind me about the meeting and the dentist tomorrow')
    expect(joined.reply).not.toBe('')
  })

  test('device_action runs the tool and speaks its line; destructive tools ask first', async () => {
    const asked: string[] = []
    const { orchestrator, host } = setup(fastMock(), {
      approve: async (r) => {
        asked.push(r.tool)
        return r.tool !== 'open_app'
      }
    })
    const uptime = await orchestrator.runTurn({ source: 'text', text: 'what is the uptime' })
    expect(uptime.decision?.action).toBe('device_action')
    expect(uptime.tools[0]).toMatchObject({ name: 'run_shell', approval: 'not-needed' })
    expect(uptime.reply).toContain('uptime says')
    expect(uptime.timings.marks.toolCall).toBeNumber()

    const open = await orchestrator.runTurn({ source: 'text', text: 'open safari please' })
    expect(open.tools[0]).toMatchObject({ name: 'open_app', approval: 'denied' })
    expect(open.reply).toBe('Okay, I left it.')

    const note = await orchestrator.runTurn({ source: 'text', text: 'make a note that the build is green' })
    expect(note.tools[0]).toMatchObject({ name: 'create_note', approval: 'approved' })
    expect(Object.values((host as unknown as { written: Record<string, string> }).written)[0]).toContain('the build is green')
    expect(asked).toEqual(['open_app', 'create_note'])
  })

  test('approval times out to "not run"', async () => {
    const { orchestrator } = setup(fastMock(), { approve: () => new Promise(() => {}) })
    const r = await orchestrator.runTurn({ source: 'text', text: 'open notes' })
    expect(r.tools[0]?.approval).toBe('timeout')
  })

  test('escalation speaks an ack, progress lines and the result', async () => {
    const { orchestrator, events } = setup()
    const r = await orchestrator.runTurn({ source: 'text', text: 'refactor the repo please' })
    expect(r.decision?.action).toBe('escalate')
    expect(r.escalation).toContain('Reading the repo.')
    expect(r.reply).toContain('On it')
    expect(r.reply).toContain('Running the tests.')
    expect(r.reply).toContain('All tests pass.')
    expect(events.some((e) => e.type === 'progress')).toBe(true)
  })

  test('ignore produces no audio', async () => {
    const { orchestrator, sink } = setup(fastMock((p) => (p.stt.options = { delayMs: 1, text: 'umm' })))
    const r = await orchestrator.runTurn({ source: 'mic', audio: silence(200) })
    expect(r.decision?.action).toBe('ignore')
    expect(r.reply).toBe('')
    expect(sink.began).toEqual([])
  })

  test('a failing stage ends the turn as error with the message', async () => {
    const { orchestrator } = setup(fastMock((p) => (p.brain.provider = 'openai-chat')))
    const r = await orchestrator.runTurn({ source: 'text', text: 'hello' })
    expect(r.status).toBe('error')
    expect(r.error).toContain('network disabled')
  })
})

describe('router threshold', () => {
  const raw = { choice: 'escalate' as const, probabilities: { escalate: 0.5, reply_local: 0.3 }, confidence: 0.5 }
  test('below threshold falls back', () => {
    const d = applyThreshold(raw, 0.6, 'reply_local', 'mock')
    expect(d).toMatchObject({ choice: 'escalate', action: 'reply_local', belowThreshold: true })
  })
  test('at or above threshold keeps the pick', () => {
    expect(applyThreshold(raw, 0.5, 'clarify', 'mock')).toMatchObject({ action: 'escalate', belowThreshold: false })
  })
  test('orchestrator uses the threshold from the profile', async () => {
    const { orchestrator } = setup(fastMock((p) => {
      p.router.options = { delayMs: 1, choice: 'escalate', confidence: 0.4 }
      p.router.threshold = 0.6
      p.router.fallback = 'clarify'
    }))
    const r = await orchestrator.runTurn({ source: 'text', text: 'do the big thing' })
    expect(r.decision).toMatchObject({ choice: 'escalate', action: 'clarify', belowThreshold: true })
    expect(r.escalation).toEqual([])
  })
})
