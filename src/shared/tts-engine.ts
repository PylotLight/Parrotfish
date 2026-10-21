// Messages between main and the hidden Phonon engine page (parrotfish-tts://engine/tts-engine.html).
export const TTS_SCHEME = 'parrotfish-tts'
export const TTS_ORIGIN = `${TTS_SCHEME}://engine`
export const TTS_PAGE = 'tts-engine.html'
export const TTS_PARTITION = 'parrotfish-tts'

export type EngineCommand =
  | {
      type: 'speak'
      id: number
      text: string
      voice: { id: string; file: string }
      durationDelta: number
      stretch: number
      temperature?: number
      seed?: number
    }
  | { type: 'cancel'; id: number }

export type EngineEvent =
  | { type: 'ready' }
  | { type: 'loaded'; loadMs: number; threads: number; device: string; isolated: boolean }
  | { type: 'chunk'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'done'; id: number; firstAudioMs: number | null }
  | { type: 'error'; id: number; message: string }
