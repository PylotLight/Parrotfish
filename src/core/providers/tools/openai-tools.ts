// Tool caller over an OpenAI-compatible chat endpoint with `tools` (llama-server --jinja parses the
// model's native tool-call format: LFM2-1.2B-Tool, FunctionGemma 270M...). Non-streaming: we need
// the whole call before running it.
import { optNumber, optString } from "../../../shared/profile";
import { authHeaders, expectOk, joinUrl } from "../../http";
import type {
  PlannedToolCall,
  ProviderFactory,
  ToolCallerProvider,
} from "../types";

export function parseToolCalls(message: unknown): {
  calls: PlannedToolCall[];
  text: string;
} {
  const m = (message ?? {}) as {
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
  };
  const calls: PlannedToolCall[] = [];
  for (const tc of m.tool_calls ?? []) {
    const name = tc.function?.name;
    if (typeof name !== "string") continue;
    let args: Record<string, unknown> = {};
    const raw = tc.function?.arguments;
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          args = parsed as Record<string, unknown>;
      } catch {
        args = { _unparsed: raw };
      }
    } else if (raw && typeof raw === "object")
      args = raw as Record<string, unknown>;
    calls.push({ name, args });
  }
  return { calls, text: typeof m.content === "string" ? m.content.trim() : "" };
}

export const openaiTools: ProviderFactory<ToolCallerProvider> = (options) => {
  const baseUrl = optString(options, "baseUrl", "http://127.0.0.1:8083/v1");
  const model = optString(options, "model", "local");
  return {
    id: "openai-tools",
    async plan(transcript, tools, ctx) {
      const response = await ctx.host.fetch(
        joinUrl(baseUrl, "chat/completions"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders(options.apiKey),
          },
          body: JSON.stringify({
            model,
            temperature: optNumber(options, "temperature", 0),
            messages: [
              {
                role: "system",
                content: optString(
                  options,
                  "systemPrompt",
                  "You control this Mac through the tools. Call the one tool that does what the user asks. If none fits, answer in one short sentence.",
                ),
              },
              { role: "user", content: transcript },
            ],
            tools: tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: "auto",
          }),
          signal: ctx.signal,
        },
      );
      await expectOk(response, "tool caller");
      const json = (await response.json()) as {
        choices?: Array<{ message?: unknown }>;
      };
      return parseToolCalls(json.choices?.[0]?.message);
    },
  };
};
