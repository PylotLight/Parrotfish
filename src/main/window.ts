// Main window: native macOS vibrancy under a transparent window (no CSS backdrop blur), inset
// traffic lights, dark everywhere else.
import { BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mainDir = dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'

function preloadPath(): string {
  const base = join(mainDir, '../preload/index')
  for (const ext of ['.cjs', '.js', '.mjs']) if (existsSync(base + ext)) return base + ext
  return `${base}.cjs`
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Parrotfish',
    autoHideMenuBar: true,
    ...(isMac
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const, transparent: true, backgroundColor: '#00000000', titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : { backgroundColor: '#14161b' }),
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // the mic worklet and the audio clock must keep running when the window is in the background
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(dev)
  else void win.loadFile(join(mainDir, '../renderer/index.html'))
  return win
}
