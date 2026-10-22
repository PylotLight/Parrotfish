// Mic capture: getUserMedia (echo cancellation on, so the agent's own voice doesn't barge in on
// itself) into a 16 kHz AudioContext, an AudioWorklet cuts 512-sample frames (32 ms, Silero's frame)
// and posts them to main, where the VAD runs.
const WORKLET = `
class PfTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === 512) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
    }
    return true
  }
}
registerProcessor('pf-tap', PfTap)
`;

export interface MicHandle {
  stop(): void;
  sampleRate: number;
}

export async function openMic(
  onFrame: (frame: Float32Array) => void,
): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext({
    sampleRate: 16000,
    latencyHint: "interactive",
  });
  const url = URL.createObjectURL(
    new Blob([WORKLET], { type: "application/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "pf-tap");
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
  // keep the worklet pulled by the graph without making any sound
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(tap);
  tap.connect(mute);
  mute.connect(ctx.destination);
  return {
    sampleRate: ctx.sampleRate,
    stop() {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}
