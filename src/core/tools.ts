// Demo toolset for the tool-caller stage. Anything that changes the machine asks first (UI confirm).
// run_shell is read-only: an allowlist of binaries, spawned without a shell, no metacharacters.
import type { Host, PlannedToolCall, ToolSpec } from './providers/types'

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
    description: 'Open a macOS application by name, e.g. "Safari" or "Notes".',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Application name' } }, required: ['name'], additionalProperties: false },
    destructive: true
  },
  run_shell: {
    name: 'run_shell',
    description: 'Run one read-only command from an allowlist (ls, pwd, date, uptime, df, ...) and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Binary name, e.g. "uptime"' }, args: { type: 'array', items: { type: 'string' } } },
      required: ['command'],
      additionalProperties: false
    },
    destructive: false
  },
  create_note: {
    name: 'create_note',
    description: 'Save a short text note to the Parrotfish notes folder.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['body'], additionalProperties: false },
    destructive: true
  }
}

export function enabledTools(names: string[]): ToolSpec[] {
  return names.map((n) => TOOL_SPECS[n]).filter((t): t is ToolSpec => !!t)
}

/** Why a run_shell call is refused, or null when it may run. */
export function shellRefusal(command: unknown, args: unknown, allowlist: string[]): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'no command'
  if (/[;&|`$<>(){}\\\n*?!~]/.test(command)) return 'command has shell metacharacters'
  const parts = command.trim().split(/\s+/)
  const bin = parts[0] ?? ''
  if (!allowlist.includes(bin)) return `${bin} is not on the allowlist (${allowlist.join(', ')})`
  if (args !== undefined && !Array.isArray(args)) return 'args must be a list'
  for (const a of [...parts.slice(1), ...((args as unknown[]) ?? [])]) {
    if (typeof a !== 'string') return 'arguments must be strings'
    if (/[;&|`$<>(){}\\\n*?!~]/.test(a)) return `argument "${a}" has shell metacharacters`
    if (/^-{1,2}(?:exec|delete|rm|output|o|write|w)(?:=|$)/.test(a)) return `flag ${a} is not allowed`
  }
  return null
}

export function shellArgv(command: string, args: unknown): string[] {
  return [...command.trim().split(/\s+/), ...(Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [])]
}

export interface ToolRunDeps {
  host: Host
  shellAllowlist: string[]
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
  const now = deps.now?.() ?? new Date()
  switch (call.name) {
    case 'get_time': {
      const time = now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
      const date = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
      return { output: `${date} ${time}`, spoken: `It's ${time}, ${date}.` }
    }
    case 'open_app': {
      const name = typeof call.args.name === 'string' ? call.args.name.trim() : ''
      if (!name || /[/\\]|\.\./.test(name)) return { output: 'refused: bad app name', spoken: "I couldn't tell which app to open." }
      const r = await collect(deps.host, ['open', '-a', name], deps.signal)
      return r.code === 0 ? { output: `opened ${name}`, spoken: `Opening ${name}.` } : { output: `open failed: ${r.err.trim()}`, spoken: `I couldn't open ${name}.` }
    }
    case 'run_shell': {
      const refusal = shellRefusal(call.args.command, call.args.args, deps.shellAllowlist)
      if (refusal) return { output: `refused: ${refusal}`, spoken: "That command isn't on my allowed list." }
      const argv = shellArgv(String(call.args.command), call.args.args)
      const r = await collect(deps.host, argv, deps.signal)
      const out = r.out.trim().slice(0, 2000)
      const first = out.split('\n')[0]?.slice(0, 140) ?? ''
      return { output: out || r.err.trim(), spoken: r.code === 0 ? (first ? `${argv[0]} says: ${first}` : `${argv[0]} printed nothing.`) : `${argv[0]} failed.` }
    }
    case 'create_note': {
      const body = typeof call.args.body === 'string' ? call.args.body : ''
      if (!body.trim()) return { output: 'refused: empty note', spoken: 'The note was empty, so I skipped it.' }
      const title = (typeof call.args.title === 'string' && call.args.title.trim()) || body.split(/\s+/).slice(0, 6).join(' ')
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'note'
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = `${deps.host.notesDir.replace(/\/+$/, '')}/${stamp}-${slug}.md`
      await deps.host.files.write(path, `# ${title}\n\n${body}\n`)
      return { output: `saved ${path}`, spoken: `Saved a note called ${title}.` }
    }
    default:
      return { output: `refused: unknown tool ${call.name}`, spoken: "I don't have a tool for that." }
  }
}

/** One line for the approval dialog. */
export function describeCall(call: PlannedToolCall): string {
  if (call.name === 'open_app') return `Open the app "${String(call.args.name ?? '')}"`
  if (call.name === 'create_note') return `Save a note: "${String(call.args.title ?? call.args.body ?? '').slice(0, 80)}"`
  return `${call.name}(${JSON.stringify(call.args).slice(0, 120)})`
}
