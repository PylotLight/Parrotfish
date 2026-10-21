// Device actions are validated at this boundary before any host-side effect.
import type { Host, PlannedToolCall, ToolSpec } from './providers/types'
import { notePath, safeCurrentTime, validateAppName, validateNote, parseDeviceAction } from '../shared/device-actions'

export interface ToolOutcome {
  output: string
  /** One short line to speak. */
  spoken: string
}

export const TOOL_SPECS: Record<string, ToolSpec> = {
  get_time: {
    name: 'get_time',
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    destructive: false
  },
  open_app: {
    name: 'open_app',
    description: 'Open an allowlisted macOS application by name.',
    parameters: { type: 'object', properties: { name: { type: 'string', enum: ['Safari', 'Notes', 'Calendar', 'Reminders', 'Mail', 'Messages', 'Maps', 'Photos', 'Music', 'System Settings'] } }, required: ['name'], additionalProperties: false },
    destructive: true
  },
  create_note: {
    name: 'create_note',
    description: 'Save a short text note to the Parrotfish notes folder.',
    parameters: { type: 'object', properties: { title: { type: 'string', maxLength: 120 }, body: { type: 'string', maxLength: 10000 } }, required: ['body'], additionalProperties: false },
    destructive: true
  }
}

export function enabledTools(names: string[]): ToolSpec[] {
  return names.map((n) => TOOL_SPECS[n]).filter((t): t is ToolSpec => !!t)
}

export interface ToolRunDeps {
  host: Host
  /** Retained for compatibility with existing settings; never grants shell execution. */
  shellAllowlist?: string[]
  signal: AbortSignal
  now?: () => Date
}

async function collect(host: Host, argv: string[], signal: AbortSignal): Promise<{ code: number | null; out: string; err: string }> {
  const proc = host.spawn(argv[0]!, argv.slice(1), { signal })
  const lines: string[] = []
  for await (const line of proc.lines) {
    if (lines.length < 200) lines.push(line)
  }
  const code = await proc.exit
  return { code, out: lines.join('\n'), err: proc.stderr() }
}

export async function runTool(call: PlannedToolCall, deps: ToolRunDeps): Promise<ToolOutcome> {
  const parsed = parseDeviceAction(call)
  if (!parsed.ok) return { output: `refused: ${parsed.reason}`, spoken: "I couldn't run that action because its details were invalid." }
  if (deps.signal.aborted) return { output: 'not run: cancelled', spoken: '' }
  const action = parsed.value
  switch (action.name) {
    case 'get_time': {
      const result = safeCurrentTime(deps.now?.() ?? new Date())
      if (!result.ok) return { output: 'refused: invalid clock value', spoken: "I couldn't read the time." }
      const { date, time } = result.value
      return { output: `${date} ${time}`, spoken: `It's ${time}, ${date}.` }
    }
    case 'open_app': {
      const validated = validateAppName(action.args.name)
      if (!validated.ok) return { output: `refused: ${validated.reason}`, spoken: "I couldn't tell which allowed app to open." }
      const name = validated.value
      const r = await collect(deps.host, ['open', '-a', name], deps.signal)
      return r.code === 0 ? { output: `opened ${name}`, spoken: `Opening ${name}.` } : { output: `open failed: ${r.err.trim()}`, spoken: `I couldn't open ${name}.` }
    }
    case 'create_note': {
      const validated = validateNote(action.args.title, action.args.body)
      if (!validated.ok) return { output: `refused: ${validated.reason}`, spoken: 'I skipped that note because its details were invalid.' }
      const { title, body, slug } = validated.value
      let now: Date
      try { now = deps.now?.() ?? new Date() } catch { return { output: 'refused: invalid clock value', spoken: 'I could not save the note.' } }
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { output: 'refused: invalid clock value', spoken: 'I could not save the note.' }
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = notePath(deps.host.notesDir, stamp, slug)
      if (!path.ok) return { output: `refused: ${path.reason}`, spoken: 'I could not save the note in the notes folder.' }
      await deps.host.files.write(path.value, `# ${title}\n\n${body}\n`)
      return { output: `saved ${path.value}`, spoken: `Saved a note called ${title}.` }
    }
    default:
      return { output: `refused: unknown tool ${call.name}`, spoken: "I don't have a tool for that." }
  }
}

/** One line for the approval dialog. */
export function describeCall(call: PlannedToolCall): string {
  if (call.name === 'open_app') return `Open the app "${String(call.args.name ?? '').slice(0, 80)}"`
  if (call.name === 'create_note') return `Save a note: "${String(call.args.title ?? call.args.body ?? '').slice(0, 80)}"`
  return `${call.name}(${JSON.stringify(call.args).slice(0, 120)})`
}
