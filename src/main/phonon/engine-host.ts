// Hidden Phonon engine window + the PhononHost the phonon-wasm TTS provider uses. The page runs on
// a privileged custom scheme with COOP/COEP/CORP headers (crossOriginIsolated -> threaded wasm),
// in its own in-memory session that can reach nothing but that scheme. Pattern from Surffish's
// Read Aloud (PR #290), which proved phonon-tts 0.4.0 this way in Electron.
import {
  BrowserWindow,
  app,
  net,
  protocol,
  session,
  type Session,
} from "electron";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PhononHost,
  PhononSpeakOptions,
} from "../../core/providers/types";
import { STT_SCHEME } from "../../shared/stt-engine";
import { splitSpeed } from "../../shared/phonon-speed";
import {
  TTS_ORIGIN,
  TTS_PAGE,
  TTS_PARTITION,
  TTS_SCHEME,
  type EngineCommand,
  type EngineEvent,
} from "../../shared/tts-engine";
import type { PcmChunk } from "../../shared/types";
import type { PhononDownloads } from "./downloads";

const mainDir = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".gguf": "application/octet-stream",
  ".safetensors": "application/octet-stream",
};

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
].join("; ");

/** Must run before app ready (Electron takes one registerSchemesAsPrivileged call). */
export function registerTtsScheme(): void {
  protocol.registerSchemesAsPrivileged(
    [TTS_SCHEME, STT_SCHEME].map((scheme) => ({
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    })),
  );
}

function devServerUrl(): string | null {
  return !app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
    ? process.env["ELECTRON_RENDERER_URL"]
    : null;
}

async function serveFile(
  root: string,
  relative: string,
  html: boolean,
): Promise<Response> {
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep))
    return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(target);
    const headers: Record<string, string> = {
      ...ISOLATION_HEADERS,
      "Content-Type":
        CONTENT_TYPES[extname(target).toLowerCase()] ??
        "application/octet-stream",
      "Cache-Control": "no-cache",
    };
    if (html) headers["Content-Security-Policy"] = PAGE_CSP;
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

interface Pending {
  push(chunk: PcmChunk): void;
  end(): void;
  fail(error: Error): void;
}
interface PendingWarm {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PhononEngine implements PhononHost {
  private window: BrowserWindow | null = null;
  private ready: Promise<BrowserWindow> | null = null;
  private markReady: (() => void) | null = null;
  private engineSession: Session | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly warming = new Map<number, PendingWarm>();
  private nextWarmId = 1;
  lastLoad: Extract<EngineEvent, { type: "loaded" }> | null = null;

  constructor(
    private readonly downloads: PhononDownloads,
    private readonly log: (line: string) => void,
    private readonly onLoaded?: (
      info: Extract<EngineEvent, { type: "loaded" }>,
    ) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {}

  private getSession(): Session {
    if (this.engineSession) return this.engineSession;
    const s = session.fromPartition(TTS_PARTITION, { cache: false });
    s.protocol.handle(TTS_SCHEME, (request) => this.handle(request));
    s.webRequest.onBeforeRequest((details, callback) => {
      const ok =
        details.url.startsWith(`${TTS_SCHEME}:`) ||
        details.url.startsWith("blob:") ||
        details.url.startsWith("data:") ||
        details.url.startsWith("devtools:") ||
        (devServerUrl() !== null && details.url.startsWith("ws://"));
      callback({ cancel: !ok });
    });
    s.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    this.engineSession = s;
    return s;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/runtime/"))
      return serveFile(
        this.downloads.runtimeDir(),
        path.slice("/runtime/".length),
        false,
      );
    if (path.startsWith("/model/"))
      return serveFile(
        this.downloads.modelDir(),
        path.slice("/model/".length),
        false,
      );
    const dev = devServerUrl();
    if (dev) {
      const response = await net.fetch(
        new URL(`${url.pathname}${url.search}`, dev).toString(),
      );
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
      if ((headers.get("content-type") ?? "").includes("text/html"))
        headers.set(
          "Content-Security-Policy",
          PAGE_CSP.replace(
            "script-src 'self'",
            "script-src 'self' 'unsafe-inline'",
          ).replace("connect-src 'self'", "connect-src 'self' ws:"),
        );
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers,
      });
    }
    const relative = path.replace(/^\/+/, "");
    if (!relative || relative.includes(".."))
      return new Response("Not found", { status: 404 });
    return serveFile(
      resolve(mainDir, "../renderer"),
      relative,
      relative.endsWith(".html"),
    );
  }

  private preloadPath(): string {
    const candidates = [
      join(mainDir, "../preload/tts-engine.cjs"),
      join(app.getAppPath(), "out/preload/tts-engine.cjs"),
    ];
    const found = candidates.find((c) => existsSync(c));
    if (!found) throw new Error("Phonon engine preload is missing");
    return found;
  }

  private ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed() && this.ready)
      return this.ready;
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      title: "Parrotfish Phonon engine",
      webPreferences: {
        preload: this.preloadPath(),
        session: this.getSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.window = win;
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (e) => e.preventDefault());
    contents.ipc.on("tts-engine:event", (event, value: EngineEvent) => {
      if (event.senderFrame === contents.mainFrame) this.onEvent(value);
    });
    contents.on("render-process-gone", () =>
      this.reset("The Phonon engine stopped unexpectedly"),
    );
    win.on("closed", () => {
      if (this.window === win) this.reset("The Phonon engine window closed");
    });
    this.ready = new Promise<BrowserWindow>((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error("The Phonon engine did not start")),
        20_000,
      );
      this.markReady = () => {
        clearTimeout(timer);
        resolveReady(win);
      };
      contents.once("did-fail-load", (_e, code, description) => {
        clearTimeout(timer);
        rejectReady(
          new Error(
            `The Phonon engine page failed to load (${description || code})`,
          ),
        );
      });
    });
    void win.loadURL(`${TTS_ORIGIN}/${TTS_PAGE}`).catch(() => undefined);
    return this.ready.catch((error) => {
      this.reset(error instanceof Error ? error.message : String(error));
      throw error;
    });
  }

  private reset(reason: string): void {
    const previous = this.window;
    this.window = null;
    this.ready = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
    for (const p of this.pending.values()) p.fail(new Error(reason));
    this.pending.clear();
    for (const warm of this.warming.values()) {
      clearTimeout(warm.timer);
      warm.reject(
        new Error(`${reason}. Retry to restart the local speech engine.`),
      );
    }
    this.warming.clear();
    this.onFailure?.(new Error(reason));
  }

  private onEvent(event: EngineEvent): void {
    if (event.type === "ready") {
      this.markReady?.();
      return;
    }
    if (event.type === "loaded") {
      this.lastLoad = event;
      this.log(
        `phonon loaded in ${event.loadMs} ms (threads ${event.threads}, ${event.device}, isolated ${event.isolated})`,
      );
      this.onLoaded?.(event);
      if (event.requestId !== undefined) this.finishWarm(event.requestId);
      return;
    }
    if (event.type === "warm-error") {
      this.log(`phonon ${event.type}: ${event.message}`);
      if (event.requestId !== undefined)
        this.failWarm(
          event.requestId,
          new Error(
            `Phonon failed to load: ${event.message}. Check the downloaded model/runtime and retry.`,
          ),
        );
      return;
    }
    if (event.type === "worker-error") {
      const error = new Error(
        `Phonon worker failed: ${event.message}. Retry to restart the local speech engine.`,
      );
      this.log(error.message);
      this.reset(error.message);
      return;
    }
    const p = this.pending.get(event.id);
    if (!p) return;
    if (event.type === "chunk")
      p.push({
        samples:
          event.samples instanceof Float32Array
            ? event.samples
            : new Float32Array(event.samples),
        sampleRate: event.sampleRate,
      });
    else if (event.type === "done") p.end();
    else if (event.type === "error") {
      const error = new Error(`phonon: ${event.message}`);
      p.fail(error);
      this.onFailure?.(error);
    }
  }

  private finishWarm(id: number): void {
    const warm = this.warming.get(id);
    if (!warm) return;
    clearTimeout(warm.timer);
    this.warming.delete(id);
    warm.resolve();
  }
  private failWarm(id: number, error: Error): void {
    const warm = this.warming.get(id);
    if (!warm) return;
    clearTimeout(warm.timer);
    this.warming.delete(id);
    warm.reject(error);
  }

  private send(command: EngineCommand): void {
    const c =
      this.window && !this.window.isDestroyed()
        ? this.window.webContents
        : null;
    if (c && !c.isDestroyed()) c.send("tts-engine:command", command);
  }

  /** Downloads (first use) and starts the engine ahead of the first sentence. */
  async warm(): Promise<void> {
    await this.downloads.ensureModel();
    await this.ensureWindow();
    const requestId = this.nextWarmId++;
    return new Promise<void>((resolveWarm, rejectWarm) => {
      const timer = setTimeout(
        () =>
          this.reset(
            "Phonon engine load timed out after 120 seconds. Retry Prepare models.",
          ),
        120_000,
      );
      this.warming.set(requestId, {
        resolve: resolveWarm,
        reject: rejectWarm,
        timer,
      });
      this.send({ type: "warm", durationDelta: 0, requestId });
    });
  }

  async *stream(
    text: string,
    options: PhononSpeakOptions,
    signal: AbortSignal,
  ): AsyncGenerator<PcmChunk> {
    if (signal.aborted) return;
    await this.downloads.ensureModel();
    if (signal.aborted) return;
    const voiceFile = await this.downloads.ensureVoice(
      options.voice || "default",
    );
    if (signal.aborted) return;
    await this.ensureWindow();
    if (signal.aborted) return;
    const split = splitSpeed(options.speed);
    const id = this.nextId++;
    const queue: PcmChunk[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    this.pending.set(id, {
      push: (c) => {
        queue.push(c);
        wake?.();
      },
      end: () => {
        done = true;
        wake?.();
      },
      fail: (e) => {
        failure = e;
        wake?.();
      },
    });
    const onAbort = (): void => {
      this.send({ type: "cancel", id });
      done = true;
      wake?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      this.pending.delete(id);
      signal.removeEventListener("abort", onAbort);
      return;
    }
    try {
      this.send({
        type: "speak",
        id,
        text,
        voice: { id: options.voice || "default", file: voiceFile },
        durationDelta: split.durationDelta,
        stretch: split.stretch,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      });
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (failure) throw failure;
        if (done || signal.aborted) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ready = null;
  }
}
