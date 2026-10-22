// Escalation to a coding agent CLI: Claude Code or Codex, one process per escalated turn.
// Runs in options.cwd (default ~). Permissions are whatever the CLI's own config says: pass flags
// like ["--permission-mode", "acceptEdits"] (claude) or ["--full-auto"] (codex) in options.extraArgs.
import { optString, optStrings } from "../../../shared/profile";
import type {
  EscalationEvent,
  EscalationProvider,
  ProviderFactory,
} from "../types";
import { parseClaudeLine, parseCodexLine } from "./progress";

function agent(
  id: string,
  defaults: {
    command: string;
    args: (prompt: string) => string[];
    parse: (line: string) => EscalationEvent[];
  },
): ProviderFactory<EscalationProvider> {
  return (options) => ({
    id,
    async *run(prompt, ctx) {
      const command = optString(options, "command", defaults.command);
      const cwd = optString(options, "cwd", "~");
      const proc = ctx.host.spawn(
        command,
        [...defaults.args(prompt), ...optStrings(options, "extraArgs")],
        { cwd, signal: ctx.signal },
      );
      let sawResult = false;
      let lastText = "";
      for await (const line of proc.lines) {
        for (const event of defaults.parse(line)) {
          if (event.kind === "result") sawResult = true;
          if (event.kind === "text") lastText = event.text;
          yield event;
        }
      }
      const code = await proc.exit;
      if (!sawResult) {
        if (lastText) yield { kind: "result", text: lastText };
        else if (code !== 0)
          throw new Error(
            `${command} exited with ${code}: ${proc.stderr().trim().slice(0, 300)}`,
          );
      }
    },
  });
}

export const claudeCode = agent("claude-code", {
  command: "claude",
  args: (prompt) => [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ],
  parse: parseClaudeLine,
});

export const codexExec = agent("codex", {
  command: "codex",
  args: (prompt) => ["exec", "--json", prompt],
  parse: parseCodexLine,
});
