/** Typed, fail-closed validation for actions that cross into the host device. */
export const DEVICE_APP_NAMES = ['Safari', 'Notes', 'Calendar', 'Reminders', 'Mail', 'Messages', 'Maps', 'Photos', 'Music', 'System Settings'] as const
export type DeviceAppName = (typeof DEVICE_APP_NAMES)[number]

export type DeviceActionResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export function validateAppName(value: unknown): DeviceActionResult<DeviceAppName> {
  if (typeof value !== 'string' || !DEVICE_APP_NAMES.includes(value as DeviceAppName)) {
    return { ok: false, reason: 'app name is not allowlisted' }
  }
  return { ok: true, value: value as DeviceAppName }
}

export interface ValidatedNote { title: string; body: string; slug: string }
export function validateNote(titleValue: unknown, bodyValue: unknown): DeviceActionResult<ValidatedNote> {
  if (typeof bodyValue !== 'string' || !bodyValue.trim()) return { ok: false, reason: 'empty note' }
  if (bodyValue.length > 10_000) return { ok: false, reason: 'note body is too long' }
  if (titleValue !== undefined && typeof titleValue !== 'string') return { ok: false, reason: 'note title must be text' }
  let title = (typeof titleValue === 'string' ? titleValue.trim() : '') || bodyValue.trim().split(/\s+/).slice(0, 6).join(' ')
  if (title.length > 120) return { ok: false, reason: 'note title is too long' }
  if ([...title].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return { ok: false, reason: 'note title contains control characters' }
  if (!title) title = 'Note'
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'note'
  return { ok: true, value: { title, body: bodyValue, slug } }
}

/** Build a note path only within a valid absolute notes directory. */
export function notePath(notesDir: unknown, stamp: unknown, slug: unknown): DeviceActionResult<string> {
  if (typeof notesDir !== 'string' || !notesDir.startsWith('/') || [...notesDir].some((character) => character.charCodeAt(0) < 32)) return { ok: false, reason: 'invalid notes directory' }
  if (notesDir.split('/').includes('..')) return { ok: false, reason: 'invalid notes directory' }
  if (typeof stamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/.test(stamp)) return { ok: false, reason: 'invalid timestamp' }
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, reason: 'invalid note name' }
  return { ok: true, value: `${notesDir.replace(/\/+$/, '')}/${stamp}-${slug}.md` }
}

export function safeCurrentTime(now: Date): DeviceActionResult<{ date: string; time: string }> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { ok: false, reason: 'invalid clock value' }
  return { ok: true, value: {
    time: now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }),
    date: now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
  } }
}

export type DeviceAction =
  | { name: 'get_time'; args: Record<string, never> }
  | { name: 'open_app'; args: { name: DeviceAppName } }
  | { name: 'create_note'; args: { title: string; body: string; slug: string } }

/** Model output is untrusted even when it came from a tool-call JSON schema. */
export function parseDeviceAction(value: unknown): DeviceActionResult<DeviceAction> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'action must be an object' }
  const call = value as Record<string, unknown>
  if (call.name !== 'get_time' && call.name !== 'open_app' && call.name !== 'create_note') return { ok: false, reason: `unknown tool ${String(call.name).slice(0, 80)}` }
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return { ok: false, reason: 'action args must be an object' }
  const args = call.args as Record<string, unknown>
  const allowed = call.name === 'get_time' ? [] : call.name === 'open_app' ? ['name'] : ['title', 'body']
  if (Object.keys(args).some((key) => !allowed.includes(key))) return { ok: false, reason: 'unexpected action argument' }
  if (call.name === 'get_time') return { ok: true, value: { name: 'get_time', args: {} } }
  if (call.name === 'open_app') {
    const app = validateAppName(args.name)
    return app.ok ? { ok: true, value: { name: 'open_app', args: { name: app.value } } } : app
  }
  const note = validateNote(args.title, args.body)
  return note.ok ? { ok: true, value: { name: 'create_note', args: note.value } } : note
}
