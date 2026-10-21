import { mkdirSync, copyFileSync } from 'node:fs'
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
          'tts-engine': resolve('src/preload/tts-engine.ts'),
          'stt-engine': resolve('src/preload/stt-engine.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: [{ find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/webgpu' }] },
    plugins: [react(), {
      name: 'local-ort-runtime',
      closeBundle() {
        const destination = resolve('out/renderer/ort')
        mkdirSync(destination, { recursive: true })
        for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
          copyFileSync(resolve('node_modules/onnxruntime-web/dist', file), resolve(destination, file))
        }
      }
    }],
    worker: { format: 'es' },
    build: {
      minify: !process.env.PF_NO_MINIFY,
      cssMinify: true,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'tts-engine': resolve('src/renderer/tts-engine.html'),
          'stt-engine': resolve('src/renderer/stt-engine.html')
        }
      }
    }
  }
})
