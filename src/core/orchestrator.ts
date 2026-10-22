// The pipeline: utterance (or typed text) -> STT -> router -> {brain | tools | escalation} ->
// sentence splitter -> TTS queue -> sink. Every stage comes from the active profile, every stage is
// timed, and a new turn or a barge-in cancels everything in flight through one AbortController.
import type { Profile } from "../shared/profile";
import type {
  ApprovalRequest,
  LiveState,
  RouterDecision,
  ToolCallRecord,
  TurnEvent,
  TurnRecord,
  TurnSource,
} from "../shared/types";
import { createProvider, isDisabled } from "./registry";
import { ProgressThrottle } from "./providers/escalation/progress";
import {
  isAbort,
  type ChatMessage,
  type Host,
  type ProviderContext,
  type RawRouterDecision,
  type SttAudio,
} from "./providers/types";
import { SentenceSplitter, splitAll } from "./splitter";
import { SpeechQueue, type AudioSink } from "./speech-queue";
import { TurnClock, type Now } from "./timing";
import { TOOL_SPECS, describeCall, runTool } from "./tools";

export interface OrchestratorDeps {
  host: Host;
  sink: AudioSink;
  getProfile(): Profile;
  emit(event: TurnEvent): void;
  /** Destructive tool calls wait on this (the UI dialog). */
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
  onState?(state: LiveState): void;
  now?: Now;
  approvalTimeoutMs?: number;
  /** Gap between spoken escalation progress lines. */
  progressGapMs?: number;
}

export interface TurnInput {
  source: TurnSource;
  /** Mic/Bench audio (16 kHz mono). Ignored when `text` is given. */
  audio?: SttAudio;
  text?: string;
  vadHangMs?: number;
  /** Bench runs a specific profile instead of the active one. */
  profile?: Profile;
  /** Bench: don't touch the shared conversation history or cancel the live turn. */
  isolated?: boolean;
  /** Bench: its own sink (no speakers) instead of the app's. */
  sink?: AudioSink;
  /** Bench: answer destructive-tool approvals without asking (default: ask the UI). */
  autoApprove?: boolean;
}

/** Applies the confidence threshold: a low-confidence pick becomes the profile's fallback. */
export function applyThreshold(
  raw: RawRouterDecision,
  threshold: number,
  fallback: RouterDecision["action"],
  provider: string,
): RouterDecision {
  const below = raw.confidence < threshold;
  return {
    choice: raw.choice,
    action: below ? fallback : raw.choice,
    probabilities: raw.probabilities,
    confidence: raw.confidence,
    belowThreshold: below,
    ...(raw.endOfTurn !== undefined ? { endOfTurn: raw.endOfTurn } : {}),
    ...(raw.bargeIn !== undefined ? { bargeIn: raw.bargeIn } : {}),
    provider,
    raw: raw.raw,
  };
}

let counter = 0;
function turnId(): string {
  counter = (counter + 1) % 1e6;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

interface ActiveTurn {
  id: string;
  controller: AbortController;
  record: TurnRecord;
}

export class Orchestrator {
  private active: ActiveTurn | null = null;
  private playing = false;
  private carry = "";
  private state: LiveState = "idle";
  readonly history: TurnRecord[] = [];

  constructor(private readonly deps: OrchestratorDeps) {}

  get liveState(): LiveState {
    return this.state;
  }

  get activeTurnId(): string | null {
    return this.active?.id ?? null;
  }

  private setState(state: LiveState): void {
    if (state === this.state) return;
    this.state = state;
    this.deps.onState?.(state);
  }

  /** Stops the current turn and any audio (barge-in, Stop button, new turn). */
  cancel(): boolean {
    const had = !!this.active || this.playing;
    this.active?.controller.abort();
    this.active = null;
    this.deps.sink.stop();
    this.playing = false;
    this.setState("idle");
    return had;
  }

  /** The sink finished playing everything it had. */
  audioIdle(): void {
    this.playing = false;
    if (!this.active) this.setState("idle");
  }

  /** VAD heard speech start. Without the barge-in question, talking over the agent cancels it. */
  onSpeechStart(): boolean {
    const profile = this.deps.getProfile();
    if (profile.router.askBargeIn) return false;
    if (this.active || this.playing) return this.cancel();
    return false;
  }

  /** A finished utterance from the mic. */
  async onUtterance(
    audio: SttAudio,
    vadHangMs?: number,
  ): Promise<TurnRecord | null> {
    const profile = this.deps.getProfile();
    const busy = this.active || this.playing;
    if (!busy || !profile.router.askBargeIn)
      return this.runTurn({ source: "mic", audio, vadHangMs });
    // Ask the router whether this is a real interruption before cancelling what's playing.
    const controller = new AbortController();
    const ctx: ProviderContext = {
      signal: controller.signal,
      host: this.deps.host,
    };
    try {
      const { text } = await createProvider("stt", profile).transcribe(
        audio,
        ctx,
      );
      if (!text.trim()) return null;
      const over = this.active?.record.reply ?? this.history[0]?.reply ?? "";
      const raw = await createProvider("router", profile).decide(
        {
          transcript: text,
          history: [],
          askEndOfTurn: false,
          bargeInOver: over,
        },
        ctx,
      );
      if ((raw.bargeIn ?? 1) < 0.5) {
        this.deps.host.log(
          "router",
          `backchannel ignored (barge_in ${raw.bargeIn?.toFixed(2)}): "${text}"`,
        );
        return null;
      }
      return this.runTurn({ source: "mic", text, vadHangMs });
    } catch (error) {
      this.deps.host.log(
        "router",
        `barge-in check failed, interrupting anyway: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.runTurn({ source: "mic", audio, vadHangMs });
    }
  }

  async runTurn(input: TurnInput): Promise<TurnRecord> {
    const profile = input.profile ?? this.deps.getProfile();
    if (!input.isolated) this.cancel();
    const id = turnId();
    const controller = new AbortController();
    const signal = controller.signal;
    const ctx: ProviderContext = { signal, host: this.deps.host };
    const clock = new TurnClock(this.deps.now, Date.now(), input.vadHangMs);
    if (input.text === undefined) clock.mark("endOfSpeech");
    const emit = this.deps.emit;
    const mark = (name: Parameters<TurnClock["mark"]>[0]): void => {
      if (clock.has(name)) return;
      emit({ type: "mark", id, mark: name, ms: clock.mark(name) });
    };
    const record: TurnRecord = {
      id,
      profile: profile.name,
      source: input.source,
      status: "running",
      transcript: "",
      reply: "",
      decision: null,
      tools: [],
      escalation: [],
      timings: clock.snapshot(),
    };
    const turn: ActiveTurn = { id, controller, record };
    if (!input.isolated) {
      this.active = turn;
      this.setState("thinking");
    }
    emit({
      type: "turn-start",
      id,
      source: input.source,
      profile: profile.name,
    });
    if (input.text === undefined)
      emit({ type: "mark", id, mark: "endOfSpeech", ms: 0 });

    const queue = new SpeechQueue(
      createProvider("tts", profile),
      input.sink ?? this.deps.sink,
      id,
      this.deps.host,
      signal,
      () => {
        mark("firstAudio");
        if (this.active === turn) {
          this.playing = true;
          this.setState("speaking");
        }
      },
    );
    const speak = (text: string): void => {
      record.reply = record.reply ? `${record.reply} ${text}` : text;
      queue.say(text);
    };

    try {
      // 1. STT (skipped for text turns)
      let transcript = input.text ?? "";
      if (input.text === undefined) {
        if (!input.audio) throw new Error("turn has neither audio nor text");
        transcript = (
          await createProvider("stt", profile).transcribe(input.audio, ctx)
        ).text;
      }
      mark("sttFinal");
      if (this.carry && !input.isolated) {
        transcript = `${this.carry} ${transcript}`.trim();
        this.carry = "";
      }
      record.transcript = transcript;
      emit({ type: "transcript", id, text: transcript, final: true });
      if (!transcript.trim()) return this.finish(turn, clock, "done");

      // 2. Router
      const history = this.history
        .slice(0, 3)
        .reverse()
        .map((t) => ({ user: t.transcript, assistant: t.reply }));
      const raw = await createProvider("router", profile).decide(
        { transcript, history, askEndOfTurn: profile.router.askEndOfTurn },
        ctx,
      );
      const decision = applyThreshold(
        raw,
        profile.router.threshold,
        profile.router.fallback,
        profile.router.provider,
      );
      record.decision = decision;
      mark("routerDecision");
      emit({ type: "decision", id, decision });
      if (
        profile.router.askEndOfTurn &&
        decision.endOfTurn !== undefined &&
        decision.endOfTurn < 0.5 &&
        !input.isolated
      ) {
        this.carry = transcript;
        emit({
          type: "progress",
          id,
          text: `waiting for the rest (end of turn ${decision.endOfTurn.toFixed(2)})`,
        });
        return this.finish(turn, clock, "done");
      }

      // 3. Act
      let action = decision.action;
      if (action === "device_action" && isDisabled(profile, "tools"))
        action = "reply_local";
      if (action === "escalate" && isDisabled(profile, "escalation"))
        action = "reply_local";
      if (action === "ignore") return this.finish(turn, clock, "done");
      if (action === "device_action") {
        const handled = await this.deviceAction(
          turn,
          profile,
          transcript,
          ctx,
          speak,
          () => mark("toolCall"),
          input.autoApprove,
        );
        if (!handled)
          await this.brain(
            id,
            profile,
            transcript,
            ctx,
            speak,
            mark,
            input.isolated ? [] : this.history,
          );
      } else if (action === "escalate") {
        await this.escalate(turn, profile, transcript, ctx, speak);
      } else {
        await this.brain(
          id,
          profile,
          transcript,
          ctx,
          speak,
          mark,
          input.isolated ? [] : this.history,
          action === "clarify",
        );
      }
      await queue.drain();
      return this.finish(turn, clock, "done");
    } catch (error) {
      if (isAbort(error) || signal.aborted)
        return this.finish(turn, clock, "cancelled");
      record.error = error instanceof Error ? error.message : String(error);
      this.deps.host.log("turn", `${id} failed: ${record.error}`);
      return this.finish(turn, clock, "error");
    } finally {
      if (!signal.aborted) await queue.drain().catch(() => undefined);
    }
  }

  private finish(
    turn: ActiveTurn,
    clock: TurnClock,
    status: TurnRecord["status"],
  ): TurnRecord {
    if (!clock.has("done")) {
      const ms = clock.mark("done");
      this.deps.emit({ type: "mark", id: turn.id, mark: "done", ms });
    }
    turn.record.status = status;
    turn.record.timings = clock.snapshot();
    if (status === "cancelled") turn.controller.abort();
    if (turn.record.source !== "bench") {
      this.history.unshift(turn.record);
      this.history.length = Math.min(this.history.length, 100);
    }
    if (this.active === turn) {
      this.active = null;
      if (!this.playing) this.setState("idle");
    }
    this.deps.emit({ type: "turn-end", id: turn.id, record: turn.record });
    return turn.record;
  }

  private async brain(
    id: string,
    profile: Profile,
    transcript: string,
    ctx: ProviderContext,
    speak: (text: string) => void,
    mark: (name: "firstToken" | "firstSentence") => void,
    history: TurnRecord[],
    clarify = false,
  ): Promise<void> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: clarify
          ? `${profile.brain.systemPrompt}\nThe request is unclear: ask one short clarifying question instead of answering.`
          : profile.brain.systemPrompt,
      },
    ];
    for (const past of history
      .slice(0, profile.brain.maxHistoryTurns)
      .reverse()) {
      if (past.status !== "done" || !past.reply) continue;
      messages.push(
        { role: "user", content: past.transcript },
        { role: "assistant", content: past.reply },
      );
    }
    messages.push({ role: "user", content: transcript });
    const splitter = new SentenceSplitter(profile.splitter);
    const brain = createProvider("brain", profile);
    let index = 0;
    const out = (sentences: string[]): void => {
      for (const sentence of sentences) {
        mark("firstSentence");
        this.deps.emit({
          type: "sentence",
          id,
          text: sentence,
          index: index++,
        });
        speak(sentence);
      }
    };
    for await (const token of brain.stream(messages, ctx)) {
      mark("firstToken");
      this.deps.emit({ type: "token", id, text: token });
      out(splitter.push(token));
    }
    out(splitter.flush());
  }

  /** Runs the tool caller. Returns false when it planned nothing and said nothing (brain takes over). */
  private async deviceAction(
    turn: ActiveTurn,
    profile: Profile,
    transcript: string,
    ctx: ProviderContext,
    speak: (text: string) => void,
    markTool: () => void,
    autoApprove?: boolean,
  ): Promise<boolean> {
    const tools = profile.tools.enabled
      .map((n) => TOOL_SPECS[n])
      .filter((t) => !!t);
    const plan = await createProvider("tools", profile).plan(
      transcript,
      tools,
      ctx,
    );
    if (plan.calls.length === 0) {
      markTool();
      if (!plan.text) return false;
      speak(plan.text);
      return true;
    }
    const lines: string[] = [];
    for (const call of plan.calls.slice(0, 4)) {
      const started = Date.now();
      const spec = TOOL_SPECS[call.name];
      let approval: ToolCallRecord["approval"] = "not-needed";
      let output: string;
      let spoken: string;
      if (!spec || !profile.tools.enabled.includes(call.name)) {
        output = `refused: ${call.name} is not enabled`;
        spoken = "I can't do that one.";
      } else {
        if (spec.destructive)
          approval =
            autoApprove === undefined
              ? await this.askApproval(turn, call, ctx.signal)
              : autoApprove
                ? "approved"
                : "denied";
        if (approval === "denied" || approval === "timeout") {
          output = `not run: ${approval}`;
          spoken =
            approval === "denied"
              ? "Okay, I left it."
              : "No answer, so I left it.";
        } else {
          const outcome = await runTool(call, {
            host: this.deps.host,
            shellAllowlist: profile.tools.shellAllowlist,
            signal: ctx.signal,
          });
          output = outcome.output;
          spoken = outcome.spoken;
        }
      }
      const record: ToolCallRecord = {
        name: call.name,
        args: call.args,
        result: output,
        approval,
        ms: Date.now() - started,
      };
      turn.record.tools.push(record);
      this.deps.emit({ type: "tool", id: turn.id, call: record });
      lines.push(spoken);
    }
    markTool();
    for (const line of lines) speak(line);
    return true;
  }

  private async askApproval(
    turn: ActiveTurn,
    call: { name: string; args: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ToolCallRecord["approval"]> {
    const request: ApprovalRequest = {
      id: `${turn.id}-${turn.record.tools.length}`,
      turnId: turn.id,
      tool: call.name,
      args: call.args,
      summary: describeCall(call),
    };
    const timeoutMs = this.deps.approvalTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">(
      (resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)),
    );
    try {
      const asked: Promise<"approved" | "denied"> = this.deps
        .approve(request, signal)
        .then((ok) => (ok ? "approved" : "denied"));
      const answer = await Promise.race([asked, timeout]);
      if (signal.aborted)
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }

  private async escalate(
    turn: ActiveTurn,
    profile: Profile,
    transcript: string,
    ctx: ProviderContext,
    speak: (text: string) => void,
  ): Promise<void> {
    const agent = createProvider("escalation", profile);
    const ack =
      typeof profile.escalation.options.ack === "string"
        ? profile.escalation.options.ack
        : "On it, handing that to the coding agent.";
    speak(ack);
    const throttle = new ProgressThrottle(this.deps.progressGapMs ?? 4000);
    let result = "";
    for await (const event of agent.run(transcript, ctx)) {
      if (event.kind === "progress") {
        turn.record.escalation.push(event.text);
        this.deps.emit({ type: "progress", id: turn.id, text: event.text });
        if (throttle.accept(event.text)) speak(event.text);
      } else if (event.kind === "text") {
        this.deps.emit({
          type: "progress",
          id: turn.id,
          text: event.text.slice(0, 300),
        });
      } else {
        result = event.text;
      }
    }
    turn.record.escalation.push(`result: ${result.slice(0, 2000)}`);
    const summary = splitAll(result, profile.splitter).slice(0, 3);
    for (const line of summary.length
      ? summary
      : ["The agent finished without saying anything."])
      speak(line);
  }
}
