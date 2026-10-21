import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // Hidden Phonon TTS engine window (cross-origin isolated, see src/main/phonon/engine-host.ts).
          'tts-engine': resolve('src/preload/tts-engine.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      minify: true,
      cssMinify: true,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'tts-engine': resolve('src/renderer/tts-engine.html')
        }
      }
    }
  }
})
