import { describe, expect, test } from "bun:test";
import { Listener } from "../src/core/listener";
import { energyVad } from "../src/core/providers/vad/energy";
import { Segmenter } from "../src/core/segmenter";
import { fakeHost } from "./helpers";

const cfg = { threshold: 0.5, minSilenceMs: 320, minSpeechMs: 200, padMs: 96 };
const frame = () => new Float32Array(512); // 32 ms

function feed(seg: Segmenter, pattern: Array<[number, number]>) {
  const events = [];
  for (const [p, n] of pattern)
    for (let i = 0; i < n; i++) events.push(...seg.push(frame(), p));
  return events;
}

describe("segmenter", () => {
  test("start after ~150 ms of speech, end after minSilenceMs, audio includes pre-roll", () => {
    const seg = new Segmenter(cfg);
    const events = feed(seg, [
      [0, 10],
      [0.9, 20],
      [0.1, 10],
    ]);
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    const end = events[1] as {
      type: "end";
      audio: Float32Array;
      speechMs: number;
    };
    expect(end.speechMs).toBeGreaterThanOrEqual(600);
    // 3 pre-roll frames + 20 speech + ~100 ms of tail
    expect(end.audio.length / 512).toBeGreaterThanOrEqual(23);
    expect(end.audio.length / 512).toBeLessThan(30);
  });
  test("short blips are dropped and never start", () => {
    const events = feed(new Segmenter(cfg), [
      [0.9, 3],
      [0, 12],
    ]);
    expect(events.map((e) => e.type)).toEqual(["drop"]);
  });
  test("short pauses inside speech do not end the segment (hysteresis + minSilence)", () => {
    const events = feed(new Segmenter(cfg), [
      [0.9, 10],
      [0.4, 4],
      [0.1, 5],
      [0.9, 10],
      [0, 12],
    ]);
    expect(events.filter((e) => e.type === "end").length).toBe(1);
  });
});

describe("listener", () => {
  test("energy VAD + listener turn loud audio into one utterance", async () => {
    const vad = await energyVad({}).open(fakeHost());
    const got: number[] = [];
    let starts = 0;
    const l = new Listener(vad, cfg, {
      onSpeechStart: () => starts++,
      onUtterance: (a) => got.push(a.length),
    });
    const loud = Float32Array.from(
      { length: 16000 },
      (_, i) => 0.3 * Math.sin(i / 5),
    );
    l.push(new Float32Array(8000));
    l.push(loud.subarray(0, 7000));
    l.push(loud.subarray(7000));
    l.push(new Float32Array(16000));
    await l.flush();
    expect(starts).toBe(1);
    expect(got.length).toBe(1);
    expect(got[0]!).toBeGreaterThan(16000);
  });
});
