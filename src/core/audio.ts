// PCM helpers shared by STT uploads, TTS decoding and Bench (WAV files in, WAV out).
import type { PcmChunk } from '../shared/types'

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const samples = Math.floor(bytes.byteLength / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/** Turns a byte stream of s16le PCM into float chunks, carrying an odd trailing byte over. */
export class Pcm16Stream {
  private carry: Uint8Array | null = null
  push(bytes: Uint8Array): Float32Array {
    let data = bytes
    if (this.carry) {
      data = new Uint8Array(this.carry.length + bytes.length)
      data.set(this.carry)
      data.set(bytes, this.carry.length)
      this.carry = null
    }
    if (data.length % 2 === 1) {
      this.carry = data.slice(data.length - 1)
      data = data.subarray(0, data.length - 1)
    }
    return pcm16ToFloat32(data)
  }
}

/** 16-bit mono WAV. */
export function encodeWav(chunk: PcmChunk): Uint8Array {
  const data = float32ToPcm16(chunk.samples)
  const out = new Uint8Array(44 + data.byteLength)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + data.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, chunk.sampleRate, true)
  view.setUint32(28, chunk.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, data.byteLength, true)
  out.set(data, 44)
  return out
}

/** Reads PCM 8/16/24/32-bit int or 32-bit float WAVs, any channel count (mixed down to mono). */
export function decodeWav(bytes: Uint8Array): PcmChunk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let offset = 12
  let format = 1
  let channels = 1
  let sampleRate = 16000
  let bits = 16
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = Math.max(1, view.getUint16(body + 2, true))
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      // streamed writers can leave 0xFFFFFFFF sizes: clamp to the file
      const end = Math.min(bytes.byteLength, body + size)
      const step = (bits / 8) * channels
      const frames = Math.floor((end - body) / step)
      const out = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          const p = body + f * step + (c * bits) / 8
          if (format === 3 && bits === 32) sum += view.getFloat32(p, true)
          else if (bits === 16) sum += view.getInt16(p, true) / 32768
          else if (bits === 8) sum += (view.getUint8(p) - 128) / 128
          else if (bits === 24) sum += (((view.getUint8(p + 2) << 24) | (view.getUint8(p + 1) << 16) | (view.getUint8(p) << 8)) >> 8) / 8388608
          else if (bits === 32) sum += view.getInt32(p, true) / 2147483648
        }
        out[f] = sum / channels
      }
      return { samples: out, sampleRate }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

/** Linear resample (fine for speech into STT / VAD; not for music). */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples
  const ratio = from / to
  const length = Math.max(1, Math.round(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const t = pos - i0
    out[i] = (samples[i0] ?? 0) * (1 - t) + (samples[i1] ?? 0) * t
  }
  return out
}

export function concatPcm(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export function rms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += (frame[i] ?? 0) ** 2
  return Math.sqrt(sum / Math.max(1, frame.length))
}

export function durationMs(chunk: PcmChunk): number {
  return (chunk.samples.length / chunk.sampleRate) * 1000
}
