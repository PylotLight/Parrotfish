import { describe, expect, test } from 'bun:test'
import { runBench } from '../src/core/bench'
import { createProvider, describeProviders } from '../src/core/registry'
import { BUILTIN_PROFILES, STAGES, defaultProfile, parseProfile } from '../src/shared/profile'
import { fastMock, setup } from './helpers'

describe('profiles', () => {
  test('every built-in profile names registered providers', () => {
    const providers = describeProviders()
    for (const make of BUILTIN_PROFILES) {
      const p = make()
      for (const s of STAGES) expect(providers[s].map((x) => x.id)).toContain(p[s].provider)
    }
  })
  test('parse fills gaps from the fallback and reports bad fields', () => {
    const { profile, issues } = parseProfile({ name: 'mine', router: { threshold: 7, fallback: 'nope' }, stt: { provider: 'whisper-cpp' }, sidecars: [{ label: 'x' }] })
    expect(profile.name).toBe('mine')
    expect(profile.router.threshold).toBe(1)
    expect(profile.router.fallback).toBe('reply_local')
    expect(profile.stt).toEqual({ provider: 'whisper-cpp', options: {} })
    expect(profile.brain).toEqual(defaultProfile().brain)
    expect(issues.map((i) => i.path)).toEqual(['router.fallback', 'sidecars[0].command'])
  })
  test('an unknown provider is a clear error', () => {
    const p = defaultProfile()
    p.tts.provider = 'nope'
    expect(() => createProvider('tts', p)).toThrow('unknown tts provider "nope"')
  })
  test('Phonon 40m is never referenced', () => {
    expect(JSON.stringify(describeProviders())).not.toContain('40m')
  })
})

describe('bench', () => {
  test('A/B over text cases produces rows and per-profile summaries without touching history', async () => {
    const { orchestrator, sink } = setup()
    const slow = fastMock((p) => {
      p.name = 'slow'
      p.brain.options = { delayMs: 40, tokenMs: 1 }
    })
    const fast = fastMock((p) => (p.name = 'fast'))
    const rows: string[] = []
    const report = await runBench(orchestrator, [{ name: 'a', text: 'hello there' }, { name: 'b', text: 'open safari' }], [fast, slow], { repeats: 2, onRow: (r) => rows.push(`${r.case}/${r.profile}`) })
    expect(report.rows.length).toBe(8)
    expect(rows.slice(0, 4)).toEqual(['a/fast', 'a/slow', 'b/fast', 'b/slow'])
    const [f, s] = report.summary
    expect(f!.profile).toBe('fast')
    expect(f!.voiceToVoice.n).toBe(4)
    expect(s!.firstToken.median!).toBeGreaterThan(f!.firstToken.median!)
    // destructive tool auto-denied in bench
    expect(report.rows.find((r) => r.case === 'b')!.reply).toBe('Okay, I left it.')
    expect(orchestrator.history.length).toBe(0)
    expect(sink.began.length).toBe(0)
  })
})
