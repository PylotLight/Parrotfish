import { parseDeviceAction } from '../src/shared/device-actions'
import { describe, expect, test } from 'bun:test'
import { notePath, safeCurrentTime, validateAppName, validateNote } from '../src/shared/device-actions'
import { enabledTools, runTool } from '../src/core/tools'
import type { Host, PlannedToolCall } from '../src/core/providers/types'

const host = {
  notesDir: '/tmp/parrotfish-notes',
  spawn: () => { throw new Error('unexpected process spawn') },
  files: { write: async (path: string, text: string) => { writes.push([path, text]) } },
  log: () => undefined
} as unknown as Host
const writes: Array<[string, string]> = []
const call = (name: string, args: Record<string, unknown>): PlannedToolCall => ({ name, args })

describe('typed device actions', () => {
  test('arbitrary shell tool is never enabled or executable', async () => {
    expect(enabledTools(['run_shell']).map((tool) => tool.name)).toEqual([])
    const result = await runTool(call('run_shell', { command: 'uptime' }), { host, signal: new AbortController().signal })
    expect(result.output).toContain('unknown tool')
  })

  test('app validation only accepts exact allowlisted typed names', () => {
    expect(validateAppName('Safari')).toEqual({ ok: true, value: 'Safari' })
    for (const bad of ['safari', '../Safari', '/Applications/Notes.app', 'Terminal', '', null]) expect(validateAppName(bad).ok).toBe(false)
  })

  test('note validation rejects malformed and oversized input and safe paths', () => {
    expect(validateNote('ok', '   ').ok).toBe(false)
    expect(validateNote('x'.repeat(121), 'body').ok).toBe(false)
    expect(validateNote(undefined, 'x'.repeat(10_001)).ok).toBe(false)
    expect(validateNote('../escape', 'body').ok).toBe(true) // path comes from normalized title, not raw title
    expect(notePath('/tmp/notes/../outside', '2025-01-02T03-04-05', 'note').ok).toBe(false)
    expect(notePath('/tmp/notes', 'bad', 'note').ok).toBe(false)
  })

  test('note writes within notes directory and refuses invalid clock', async () => {
    writes.length = 0
    const result = await runTool(call('create_note', { title: 'Build green', body: 'All tests pass' }), {
      host, signal: new AbortController().signal, now: () => new Date('2025-01-02T03:04:05Z')
    })
    expect(result.output).toContain('/tmp/parrotfish-notes/2025-01-02T03-04-05-build-green.md')
    expect(writes[0]?.[1]).toContain('All tests pass')
    const invalid = await runTool(call('create_note', { body: 'body' }), { host, signal: new AbortController().signal, now: () => new Date('invalid') })
    expect(invalid.output).toContain('refused')
    expect(writes).toHaveLength(1)
  })

  test('time validator fails closed on invalid Date', () => {
    expect(safeCurrentTime(new Date('invalid')).ok).toBe(false)
    expect(safeCurrentTime(new Date('2025-01-02T03:04:05Z')).ok).toBe(true)
  })
})

test('typed action boundary rejects malformed and extra fields', () => {
  for (const payload of [null, [], { name: 'open_app', args: null }, { name: 'open_app', args: { name: 'Safari', command: 'rm' } }, { name: 'get_time', args: { command: 'uptime' } }]) expect(parseDeviceAction(payload).ok).toBe(false)
  expect(parseDeviceAction({ name: 'open_app', args: { name: 'Safari' } })).toEqual({ ok: true, value: { name: 'open_app', args: { name: 'Safari' } } })
})
