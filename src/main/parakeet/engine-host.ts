import { app, BrowserWindow, net, session, type Session } from "electron";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { abortError, throwIfAborted } from "../../core/providers/types";
import type { LocalInferenceStatus } from "../../shared/local-inference";
import {
  STT_ORIGIN,
  STT_PAGE,
  STT_PARTITION,
  STT_SCHEME,
  type SttBackend,
  type SttCommand,
  type SttEvent,
} from "../../shared/stt-engine";
import { PARAKEET_GPU_ASSETS, PARAKEET_MANIFESTS } from "./assets";
import { ParakeetDownloads } from "./downloads";
import { requireLocalSttModel } from "../../shared/local-stt-models";

const mainDir = dirname(fileURLToPath(import.meta.url));
export const STT_SCHEME_REGISTRATION = {
  scheme: STT_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    codeCache: true,
  },
};
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
const csp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'";
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".json": "application/json",
};
export interface ParakeetOptions {
  userData: string;
  onStatus(status: LocalInferenceStatus): void;
  log(line: string): void;
}
interface Pending {
  resolve(value: { text: string }): void;
  reject(error: Error): void;
}

/** Pinned-model capability host. Its renderer cannot access app IPC, local paths or the network. */
export class ParakeetEngine {
  private window: BrowserWindow | null = null;
  private booting: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private engineSession: Session | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private warmReady = false;
  private warmWaiter: {
    id: number;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly downloads: ParakeetDownloads;
  private readonly gpuDownloads: ParakeetDownloads;
  private activeModel: string | null = null;
  private activeBackend: SttBackend = "wasm";
  private readonly modelDownloads = new Map<string, ParakeetDownloads>();

  constructor(private readonly options: ParakeetOptions) {
    const report = (status: LocalInferenceStatus): void =>
      options.onStatus({ ...status, requestedBackend: this.activeBackend });
    this.downloads = new ParakeetDownloads(
      join(options.userData, "models", "parakeet-tdt-0.6b-v2"),
      report,
      (input, init) => net.fetch(input, init),
    );
    this.gpuDownloads = new ParakeetDownloads(
      this.downloads.root,
      report,
      (input, init) => net.fetch(input, init),
      PARAKEET_GPU_ASSETS,
    );
    for (const [id, manifest] of Object.entries(PARAKEET_MANIFESTS)) {
      const root =
        id === "nvidia/parakeet-tdt-0.6b-v2"
          ? this.downloads.root
          : join(options.userData, "models", manifest.cacheKey);
      this.modelDownloads.set(
        id,
        new ParakeetDownloads(
          root,
          report,
          (input, init) => net.fetch(input, init),
          undefined,
          manifest,
        ),
      );
    }
  }

  private downloadsFor(id: string): ParakeetDownloads {
    const value = this.modelDownloads.get(id);
    if (!value)
      throw new Error(`No pinned Parakeet asset manifest exists for ${id}.`);
    return value;
  }

  private devUrl(): string | null {
    return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : null;
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== `${STT_SCHEME}:` || url.hostname !== "engine")
        return new Response("Invalid origin", { status: 403 });
      const rawPath = url.pathname;
      const path = decodeURIComponent(rawPath);
      let target: string;
      if (path.startsWith("/model/")) {
        const [, route, encodedId, encodedName, ...rest] = rawPath.split("/");
        if (route !== "model" || !encodedId || !encodedName || rest.length)
          return new Response("Not found", { status: 404 });
        let id: string;
        let name: string;
        try {
          id = decodeURIComponent(encodedId);
          name = decodeURIComponent(encodedName);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        const downloader = this.modelDownloads.get(id);
        const allowed =
          downloader &&
          (Object.hasOwn(downloader.manifest.assets, name) ||
            (id === "nvidia/parakeet-tdt-0.6b-v2" &&
              Object.hasOwn(PARAKEET_GPU_ASSETS, name)));
        if (!allowed) return new Response("Not found", { status: 404 });
        target = join(downloader.root, name);
      } else if (path.startsWith("/ort/")) {
        const name = path.slice("/ort/".length);
        if (
          !/^ort-wasm-simd-threaded(?:\.(?:jsep|asyncify))?\.(?:mjs|wasm)$/.test(
            name,
          )
        )
          return new Response("Not found", { status: 404 });
        target = this.devUrl()
          ? resolve(mainDir, "../../node_modules/onnxruntime-web/dist", name)
          : join(mainDir, "../renderer/ort", name);
      } else {
        const dev = this.devUrl();
        if (dev) {
          const response = await net.fetch(
            new URL(`${path}${url.search}`, dev).toString(),
          );
          const out = new Headers(response.headers);
          for (const [key, value] of Object.entries(headers))
            out.set(key, value);
          if ((out.get("content-type") || "").includes("text/html"))
            out.set(
              "Content-Security-Policy",
              csp
                .replace(
                  "script-src 'self'",
                  "script-src 'self' 'unsafe-inline'",
                )
                .replace("connect-src 'self'", "connect-src 'self' ws:"),
            );
          return new Response(response.body, {
            status: response.status,
            headers: out,
          });
        }
        const root = resolve(mainDir, "../renderer");
        target = resolve(root, path.replace(/^\/+/, ""));
        if (!target.startsWith(root + sep))
          return new Response("Not found", { status: 404 });
      }
      // Stream large ONNX files instead of making an extra main-process copy.
      const response = await net.fetch(pathToFileURL(target).href);
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...headers,
          "Content-Type": mime[extname(target)] || "application/octet-stream",
          ...(target.endsWith(".html")
            ? { "Content-Security-Policy": csp }
            : {}),
        },
      });
    } catch (error) {
      this.options.log(
        `Engine asset unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Response("Asset unavailable. Retry Prepare models.", {
        status: 404,
      });
    }
  }

  private getSession(): Session {
    if (this.engineSession) return this.engineSession;
    const engineSession = session.fromPartition(STT_PARTITION);
    engineSession.protocol.handle(STT_SCHEME, (request) =>
      this.handle(request),
    );
    engineSession.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      callback({
        cancel: !(
          url.startsWith(`${STT_ORIGIN}/`) ||
          url.startsWith("blob:") ||
          url.startsWith("devtools:") ||
          (!!this.devUrl() && url.startsWith("ws:"))
        ),
      });
    });
    engineSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    engineSession.setPermissionCheckHandler(() => false);
    this.engineSession = engineSession;
    return engineSession;
  }

  private ensureWindow(modelId: string): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Parakeet engine has been disposed"));
    if (this.booting) return this.booting;
    this.booting = (async () => {
      await this.downloadsFor(modelId).ensure();
      this.options.onStatus({
        stage: "stt",
        state: "loading",
        modelId,
        requestedBackend: this.activeBackend,
        label: PARAKEET_MANIFESTS[modelId]?.label ?? modelId,
        detail: "Starting isolated inference worker…",
      });
      const win = new BrowserWindow({
        show: false,
        width: 100,
        height: 80,
        skipTaskbar: true,
        webPreferences: {
          preload: join(mainDir, "../preload/stt-engine.cjs"),
          session: this.getSession(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          spellcheck: false,
        },
      });
      this.window = win;
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.ipc.on("stt-engine:event", (event, value: SttEvent) => {
        if (
          this.window === win &&
          event.senderFrame === win.webContents.mainFrame
        )
          this.onEvent(value);
      });
      win.webContents.on("render-process-gone", () => {
        if (this.window === win)
          this.reset(
            new Error("Parakeet worker process stopped. Retry Prepare models."),
          );
      });
      win.webContents.on("console-message", (event) =>
        this.options.log(
          `STT renderer console [${event.level}] ${event.sourceId}:${event.lineNumber} ${event.message}`,
        ),
      );
      win.webContents.on(
        "did-fail-load",
        (_event, code, description, validatedURL, isMainFrame) =>
          this.options.log(
            `STT renderer load failed (${code}, main=${isMainFrame}): ${description} ${validatedURL}`,
          ),
      );
      win.on("closed", () => {
        if (this.window === win)
          this.reset(
            new Error("Parakeet engine closed. Retry Prepare models."),
          );
      });
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(
          () =>
            rejectReady(
              new Error(
                "Parakeet page startup timed out. Retry Prepare models.",
              ),
            ),
          20_000,
        );
        this.markReady = () => {
          clearTimeout(timer);
          resolveReady();
        };
        win.webContents.once("did-fail-load", (_event, _code, description) => {
          clearTimeout(timer);
          rejectReady(new Error(`Parakeet page failed: ${description}`));
        });
        void win.loadURL(`${STT_ORIGIN}/${STT_PAGE}`).catch((error) => {
          clearTimeout(timer);
          rejectReady(error);
        });
      });
    })().catch((error) => {
      this.reset(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return this.booting;
  }

  private onEvent(event: SttEvent): void {
    if (event.type === "ready") {
      this.markReady?.();
      return;
    }
    if (event.type === "gpu-assets") {
      if (this.activeBackend !== "webgpu") {
        this.options.log(
          "Rejected unsolicited GPU asset request while WASM backend is active.",
        );
        return;
      }
      const engine = this.window;
      void this.gpuDownloads
        .ensure()
        .then(
          () => {
            if (engine === this.window && engine && !engine.isDestroyed())
              this.send({ type: "gpu-assets-ready", id: event.id });
          },
          (error) => {
            if (engine === this.window && engine && !engine.isDestroyed())
              this.send({
                type: "gpu-assets-ready",
                id: event.id,
                error: error instanceof Error ? error.message : String(error),
              });
          },
        )
        .catch((error) =>
          this.options.log(`GPU preparation: ${String(error)}`),
        );
      return;
    }
    if (event.type === "status") {
      if (event.modelId !== this.activeModel) return;
      this.options.onStatus({
        stage: "stt",
        state: event.state,
        modelId: event.modelId,
        requestedBackend: this.activeBackend,
        label: PARAKEET_MANIFESTS[event.modelId]?.label ?? event.modelId,
        backend: event.backend,
        detail: event.detail,
      });
      return;
    }
    if (event.type === "warmed") {
      if (
        event.modelId === this.activeModel &&
        this.warmWaiter?.id === event.id
      ) {
        this.warmReady = true;
        this.warmWaiter.resolve();
      }
      return;
    }
    if (event.type === "error") {
      const error = new Error(event.message);
      // Worker startup/message errors have no checkpoint ID. They originate
      // from this engine's trusted frame and must reject waiters immediately.
      if (event.modelId !== undefined && event.modelId !== this.activeModel)
        return;
      if (
        this.warmWaiter &&
        (event.id === undefined || event.id === this.warmWaiter.id)
      )
        this.warmWaiter.reject(error);
      if (event.id !== undefined) this.pending.get(event.id)?.reject(error);
      this.reset(error);
      return;
    }
    if (event.type === "result" && event.modelId === this.activeModel)
      this.pending.get(event.id)?.resolve({ text: event.text });
  }

  private send(command: SttCommand): void {
    if (!this.window || this.window.isDestroyed())
      throw new Error("Parakeet engine is not running. Retry Prepare models.");
    this.window.webContents.send("stt-engine:command", command);
  }

  private reset(error: Error, report = true): void {
    const win = this.window;
    this.window = null;
    this.booting = null;
    this.warmReady = false;
    if (report && this.activeModel)
      this.options.onStatus({
        stage: "stt",
        state: "error",
        modelId: this.activeModel,
        requestedBackend: this.activeBackend,
        label: PARAKEET_MANIFESTS[this.activeModel]?.label ?? this.activeModel,
        detail: `${error.message} Retry Prepare models.`,
      });
    this.warmWaiter?.reject(error);
    this.warmWaiter = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (win && !win.isDestroyed()) win.destroy();
  }

  warm(modelId?: unknown, backend: SttBackend = "wasm"): Promise<void> {
    backend = backend === "webgpu" ? "webgpu" : "wasm";
    const selected = requireLocalSttModel(modelId);
    const task = async (): Promise<void> => {
      if (this.activeModel !== selected.id || this.activeBackend !== backend) {
        if (this.activeModel)
          this.options.onStatus({
            stage: "stt",
            state: "idle",
            modelId: this.activeModel,
            requestedBackend: this.activeBackend,
            label:
              PARAKEET_MANIFESTS[this.activeModel]?.label ?? this.activeModel,
            detail: "Worker context released while switching models.",
          });
        this.reset(
          new Error(`Switching active Parakeet model to ${selected.id}.`),
          false,
        );
        this.activeModel = selected.id;
        this.activeBackend = backend;
      }
      if (this.warmReady) return;
      await this.ensureWindow(selected.id);
      await new Promise<void>((resolveWarm, rejectWarm) => {
        const id = ++this.nextId;
        const timer = setTimeout(() => {
          this.reset(
            new Error(
              "Parakeet model loading exceeded 10 minutes. Retry Prepare models.",
            ),
          );
        }, 600_000);
        this.warmWaiter = {
          id,
          resolve: () => {
            clearTimeout(timer);
            this.warmWaiter = null;
            resolveWarm();
          },
          reject: (error) => {
            clearTimeout(timer);
            this.warmWaiter = null;
            rejectWarm(error);
          },
        };
        this.send({ type: "warm", id, modelId: selected.id, backend });
      });
    };
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  transcribe(
    audio: { samples: Float32Array; sampleRate: number },
    signal: AbortSignal,
    modelId?: unknown,
    backend: SttBackend = "wasm",
  ): Promise<{ text: string }> {
    backend = backend === "webgpu" ? "webgpu" : "wasm";
    const selected = requireLocalSttModel(modelId);
    const task = async (): Promise<{ text: string }> => {
      throwIfAborted(signal);
      if (
        audio.sampleRate !== 16000 ||
        !(audio.samples instanceof Float32Array) ||
        audio.samples.length > 16000 * 30 ||
        !audio.samples.every(Number.isFinite)
      )
        throw new Error(
          "Parakeet expects finite mono 16 kHz audio of at most 30 seconds. Use a shorter utterance.",
        );
      if (this.activeModel !== selected.id || this.activeBackend !== backend) {
        if (this.activeModel)
          this.options.onStatus({
            stage: "stt",
            state: "idle",
            modelId: this.activeModel,
            requestedBackend: this.activeBackend,
            label:
              PARAKEET_MANIFESTS[this.activeModel]?.label ?? this.activeModel,
            detail: "Worker context released while switching models.",
          });
        this.reset(
          new Error(`Switching active Parakeet model to ${selected.id}.`),
          false,
        );
        this.activeModel = selected.id;
        this.activeBackend = backend;
      }
      if (!this.warmReady) {
        await this.ensureWindow(selected.id);
        await new Promise<void>((resolveWarm, rejectWarm) => {
          const warmId = ++this.nextId;
          const timer = setTimeout(
            () =>
              this.reset(
                new Error(
                  "Parakeet model loading exceeded 10 minutes. Retry Prepare models.",
                ),
              ),
            600_000,
          );
          this.warmWaiter = {
            id: warmId,
            resolve: () => {
              clearTimeout(timer);
              this.warmWaiter = null;
              resolveWarm();
            },
            reject: (error) => {
              clearTimeout(timer);
              this.warmWaiter = null;
              rejectWarm(error);
            },
          };
          this.send({
            type: "warm",
            id: warmId,
            modelId: selected.id,
            backend,
          });
        });
      }
      throwIfAborted(signal);
      const id = ++this.nextId;
      return new Promise<{ text: string }>((resolveResult, rejectResult) => {
        const finish = (error?: Error, value?: { text: string }): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          this.pending.delete(id);
          if (error) rejectResult(error);
          else resolveResult(value!);
        };
        const cancel = (): void => {
          try {
            this.send({ type: "cancel", id });
          } catch {
            /* already gone */
          }
          finish(abortError());
        };
        const timer = setTimeout(() => {
          this.reset(
            new Error(
              "Parakeet transcription timed out. Retry Prepare models or use a shorter utterance.",
            ),
          );
        }, 120_000);
        this.pending.set(id, {
          resolve: (value) => finish(undefined, value),
          reject: (error) => finish(error),
        });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
          cancel();
          return;
        }
        try {
          this.send({
            type: "transcribe",
            id,
            samples: audio.samples,
            sampleRate: audio.sampleRate,
            modelId: selected.id,
            backend,
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.reset(new Error("Parakeet engine disposed"), false);
  }
}
