// After `bun run build`: bun build scripts/ci/check-local-stt-ui.ts --target=node --format=cjs --external electron --outfile=/tmp/parrotfish-stt-ui.cjs
// Then: electron /tmp/parrotfish-stt-ui.cjs (use xvfb-run -a on headless Linux).
import { app, BrowserWindow } from "electron";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localLoopProfile } from "../../src/shared/profile";

const root = mkdtempSync(join(tmpdir(), "parrotfish-stt-ui-"));
app.setPath("userData", join(root, "userData"));
const profile = localLoopProfile();
// Deliberately simulate an older saved profile with no backend option.
delete profile.stt.options.backend;
const preload = join(root, "preload.cjs");
writeFileSync(
  preload,
  `
const { contextBridge } = require('electron')
let profile = ${JSON.stringify(profile)}
let warmCalls = []
const listeners = new Map()
const emit = (channel, value) => (listeners.get(channel) || []).forEach(fn => fn(value))
contextBridge.exposeInMainWorld('parrotfish', {
  platform: process.platform,
  profiles: {
    list: async () => ({ names: [profile.name], active: profile.name, builtins: [profile.name] }),
    get: async () => profile,
    save: async value => { profile = value; emit('profiles:changed', { active: profile.name }); return { profile, issues: [] } },
    providers: async () => Object.fromEntries(['vad','stt','router','tools','brain','escalation','tts'].map(stage => [stage, [{ id: profile[stage].provider, label: profile[stage].provider, options: profile[stage].options }]]))
  },
  turns: { history: async () => [] },
  phonon: { voices: async () => [] },
  local: { status: async () => [], warm: async () => { warmCalls.push({ ...profile.stt.options }); return { ok: true } } },
  on: (channel, listener) => { const list = listeners.get(channel) || []; list.push(listener); listeners.set(channel, list); return () => { listeners.set(channel, list.filter(fn => fn !== listener)) } }
})
contextBridge.exposeInMainWorld('sttUiTest', { state: () => ({ profile, warmCalls }) })
`,
);

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true },
    });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(event.message);
    });
    const js = (code: string) => win.webContents.executeJavaScript(code);
    const waitFor = async (code: string) => {
      for (let i = 0; i < 100; i++) {
        if (await js(`Boolean(${code})`)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`UI assertion timed out: ${code}`);
    };
    const select = async (label: string, value: string) => {
      await js(
        `(() => { const el = document.querySelector('select[aria-label="${label}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
    };
    try {
      await win.loadFile(resolve("out/renderer/index.html"));
      await waitFor(`document.querySelector('select[aria-label="STT model"]')`);
      await waitFor(
        `document.querySelector('select[aria-label="STT backend"]').value === 'wasm'`,
      );
      await waitFor(
        `[...document.querySelector('select[aria-label="STT model"]').options].some(o => o.textContent === 'Parakeet Redux' && !o.disabled)`,
      );
      await select("STT model", "moondream/parakeet-redux");
      await waitFor(
        `window.sttUiTest.state().profile.stt.options.model === 'moondream/parakeet-redux' && !document.querySelector('select[aria-label="STT model"]').disabled`,
      );
      await waitFor(`window.sttUiTest.state().warmCalls.length === 0`);
      await js(
        `[...document.querySelectorAll('button')].find(b => b.textContent === 'Prepare models').click()`,
      );
      await waitFor(
        `window.sttUiTest.state().warmCalls.length === 1 && window.sttUiTest.state().warmCalls[0].model === 'moondream/parakeet-redux'`,
      );
      await waitFor(
        `!document.querySelector('select[aria-label="STT backend"]').disabled`,
      );
      await select("STT model", "nvidia/parakeet-tdt-0.6b-v2");
      await waitFor(
        `window.sttUiTest.state().profile.stt.options.model === 'nvidia/parakeet-tdt-0.6b-v2' && !document.querySelector('select[aria-label="STT backend"]').disabled`,
      );
      await select("STT backend", "webgpu");
      await waitFor(
        `window.sttUiTest.state().profile.stt.options.backend === 'webgpu' && document.body.textContent.includes('additional 2.48 GB')`,
      );
      await waitFor(
        `window.sttUiTest.state().warmCalls.length === 1 && !document.querySelector('select[aria-label="STT backend"]').disabled`,
      );
      await select("STT backend", "wasm");
      await waitFor(
        `window.sttUiTest.state().profile.stt.options.backend === 'wasm' && !document.querySelector('select[aria-label="STT backend"]').disabled`,
      );
      await js(
        `[...document.querySelectorAll('button')].find(b => b.textContent === 'Profiles').click()`,
      );
      await waitFor(
        `document.querySelector('.profile-editor select[aria-label="STT model"]')`,
      );
      await waitFor(
        `document.querySelector('select[aria-label="STT backend"]').value === 'wasm'`,
      );
      await select("STT model", "moondream/parakeet-redux");
      await js(
        `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()`,
      );
      await waitFor(
        `window.sttUiTest.state().profile.stt.options.model === 'moondream/parakeet-redux'`,
      );
      await js(
        `[...document.querySelectorAll('button')].find(b => b.textContent === 'Live').click()`,
      );
      await waitFor(
        `document.querySelector('select[aria-label="STT model"]').value === 'moondream/parakeet-redux'`,
      );
      console.log(
        "STT_UI_SMOKE PASS: Live Redux selection/save/prepare, legacy CPU default, opt-in GPU warning, no warm on selection, Profiles save and reopen",
      );
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
