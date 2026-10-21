// Turns coding-agent stream events into short spoken progress lines.
// Claude Code: `claude -p --output-format stream-json --verbose` writes one JSON object per line:
//   {type:'system',subtype:'init'}, {type:'assistant',message:{content:[{type:'text'|'tool_use',...}]}},
//   {type:'user',message:{content:[{type:'tool_result'}]}}, {type:'result',result:'...'}
// Codex: `codex exec --json` writes JSONL events: thread.started, turn.started,
//   item.started / item.completed with item.type agent_message | reasoning | command_execution |
//   file_change | mcp_tool_call | web_search | todo_list, turn.completed, error.
// Both formats are parsed defensively: unknown events are skipped, never fatal.
import type { EscalationEvent } from '../types'

function base(path: unknown): string {
  return typeof path === 'string' ? (path.split('/').filter(Boolean).pop() ?? path) : ''
}

/** Spoken line for a Claude Code tool_use block, or null to stay quiet. */
export function claudeToolLine(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case 'Read':
      return `Reading ${base(input.file_path) || 'a file'}.`
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `Editing ${base(input.file_path) || 'a file'}.`
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command.trim().split(/\s+/).slice(0, 2).join(' ') : ''
      return cmd ? `Running ${cmd}.` : 'Running a command.'
    }
    case 'Grep':
    case 'Glob':
      return 'Searching the code.'
    case 'WebSearch':
    case 'WebFetch':
      return 'Looking it up online.'
    case 'Task':
      return 'Handing part of it to a sub-agent.'
    case 'TodoWrite':
      return 'Making a plan.'
    default:
      return name.startsWith('mcp__') ? `Using ${name.split('__')[1] ?? 'a tool'}.` : null
  }
}

export function parseClaudeLine(line: string): EscalationEvent[] {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(line) as Record<string, unknown>
  } catch {
    return []
  }
  if (json.type === 'result') {
    const text = typeof json.result === 'string' ? json.result : json.is_error ? 'The agent stopped with an error.' : ''
    return text ? [{ kind: 'result', text }] : []
  }
  if (json.type !== 'assistant') return []
  const content = ((json.message as { content?: unknown })?.content ?? []) as Array<Record<string, unknown>>
  const out: EscalationEvent[] = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const line = claudeToolLine(block.name, (block.input ?? {}) as Record<string, unknown>)
      if (line) out.push({ kind: 'progress', text: line })
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ kind: 'text', text: block.text.trim() })
    }
  }
  return out
}

export function parseCodexLine(line: string): EscalationEvent[] {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(line) as Record<string, unknown>
  } catch {
    return []
  }
  const item = (json.item ?? {}) as Record<string, unknown>
  if (json.type === 'item.started') {
    if (item.type === 'command_execution') {
      const cmd = typeof item.command === 'string' ? item.command.replace(/^(?:bash|zsh|sh) -lc\s+/, '').replace(/^['"]|['"]$/g, '').trim().split(/\s+/).slice(0, 2).join(' ') : ''
      return [{ kind: 'progress', text: cmd ? `Running ${cmd}.` : 'Running a command.' }]
    }
    if (item.type === 'web_search') return [{ kind: 'progress', text: 'Looking it up online.' }]
    if (item.type === 'mcp_tool_call') return [{ kind: 'progress', text: `Using ${typeof item.tool === 'string' ? item.tool : 'a tool'}.` }]
    return []
  }
  if (json.type === 'item.completed') {
    if (item.type === 'file_change') {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown }>) : []
      return [{ kind: 'progress', text: changes.length === 1 ? `Edited ${base(changes[0]?.path)}.` : `Edited ${changes.length || 'some'} files.` }]
    }
    if (item.type === 'agent_message' && typeof item.text === 'string') return [{ kind: 'text', text: item.text.trim() }]
    return []
  }
  if (json.type === 'error' && typeof json.message === 'string') return [{ kind: 'result', text: `Codex hit an error: ${json.message}` }]
  return []
}

/**
 * Rate-limits progress lines so the agent doesn't narrate every file read: at most one every
 * `minGapMs`, and never the same line twice in a row.
 */
export class ProgressThrottle {
  private lastAt = -Infinity
  private last = ''
  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}
  accept(text: string): boolean {
    const t = this.now()
    if (text === this.last || t - this.lastAt < this.minGapMs) return false
    this.lastAt = t
    this.last = text
    return true
  }
}
