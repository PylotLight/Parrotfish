// macOS `say`: writes a 16-bit WAV per sentence, then plays it. Not streaming, so first audio
// waits for the whole sentence: the honest baseline. options.voice ("" = system voice), options.rate (wpm).
import { optNumber, optString } from '../../../shared/profile'
import { decodeWav } from '../../audio'
import type { ProviderFactory, TtsProvider } from '../types'

export const macosSay: ProviderFactory<TtsProvider> = (options) => ({
  id: 'macos-say',
  async *synthesize(text, ctx) {
    const out = ctx.host.files.temp('wav')
    const voice = optString(options, 'voice', '')
    const args = ['--data-format=LEI16@22050', '--file-format=WAVE', '-o', out, '-r', String(optNumber(options, 'rate', 200)), ...(voice ? ['-v', voice] : []), '--', text]
    const proc = ctx.host.spawn('say', args, { signal: ctx.signal })
    for await (const _ of proc.lines) {
      // say prints nothing on success
    }
    const code = await proc.exit
    try {
      if (code !== 0) throw new Error(`say exited with ${code}: ${proc.stderr().trim()}`)
      yield decodeWav(await ctx.host.files.read(out))
    } finally {
      await ctx.host.files.remove(out).catch(() => undefined)
    }
  }
})
