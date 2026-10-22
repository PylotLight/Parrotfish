// Phonon over ptts-ws-server's WebSocket (/speech/tts, default :8080). One connection is kept for
// the session (the server keeps the primed voice and KV cache between messages); each sentence is
// text + flush, answered by audio frames then "flushed". Protocol from ptts-ws-server/README.md:
//   -> {type:'setup', output_format:'pcm', voice}   <- {type:'ready', sample_rate, ...}
//   -> {type:'text', text}  -> {type:'flush', flush_id}   <- {type:'audio', audio:<b64>}... {type:'flushed', flush_id}
// The server takes one session at a time by default; a cancelled sentence closes the socket.
import { optString } from "../../../shared/profile";
import type { PcmChunk } from "../../../shared/types";
import { pcm16ToFloat32 } from "../../audio";
import type { ProviderFactory, TtsProvider } from "../types";

interface Session {
  ws: WebSocket;
  sampleRate: number;
  listeners: Set<(msg: Record<string, unknown>) => void>;
}

function b64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const pttsWs: ProviderFactory<TtsProvider> = (options) => {
  const url = optString(options, "url", "ws://127.0.0.1:8080/speech/tts");
  const voice = optString(options, "voice", "");
  let session: Promise<Session> | null = null;
  let flushId = 0;

  const open = (): Promise<Session> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const listeners = new Set<(msg: Record<string, unknown>) => void>();
      let ready = false;
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            type: "setup",
            output_format: "pcm",
            ...(voice ? { voice } : {}),
          }),
        );
      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!ready) {
          if (msg.type === "ready") {
            ready = true;
            resolve({
              ws,
              sampleRate:
                typeof msg.sample_rate === "number" ? msg.sample_rate : 24000,
              listeners,
            });
          } else if (msg.type === "error")
            reject(new Error(`ptts-ws: ${String(msg.message)}`));
          return;
        }
        for (const l of listeners) l(msg);
      };
      ws.onerror = () => {
        if (!ready) reject(new Error(`ptts-ws: could not connect to ${url}`));
      };
      ws.onclose = () => {
        session = null;
        for (const l of listeners)
          l({ type: "error", message: "connection closed" });
      };
    });

  return {
    id: "ptts-ws",
    async *synthesize(text, ctx) {
      session ??= open().catch((e) => {
        session = null;
        throw e;
      });
      const s = await session;
      const id = ++flushId;
      const queue: PcmChunk[] = [];
      let done = false;
      let failure: Error | null = null;
      let wake: (() => void) | null = null;
      const listener = (msg: Record<string, unknown>): void => {
        if (msg.type === "audio" && typeof msg.audio === "string")
          queue.push({
            samples: pcm16ToFloat32(b64(msg.audio)),
            sampleRate: s.sampleRate,
          });
        else if (msg.type === "flushed" && msg.flush_id === id) done = true;
        else if (msg.type === "error")
          failure = new Error(`ptts-ws: ${String(msg.message)}`);
        wake?.();
      };
      const onAbort = (): void => {
        s.ws.close();
        wake?.();
      };
      s.listeners.add(listener);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        s.ws.send(JSON.stringify({ type: "text", text }));
        s.ws.send(JSON.stringify({ type: "flush", flush_id: id }));
        while (true) {
          while (queue.length) yield queue.shift()!;
          if (done || ctx.signal.aborted) return;
          if (failure) throw failure;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      } finally {
        s.listeners.delete(listener);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
};
