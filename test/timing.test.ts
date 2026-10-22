import { describe, expect, test } from "bun:test";
import { TurnClock, summarize, waterfallBars } from "../src/core/timing";

describe("turn clock", () => {
  test("first mark wins and voice-to-voice is measured from end of speech", () => {
    let t = 1000;
    const clock = new TurnClock(() => t, 0, 450);
    clock.mark("endOfSpeech");
    t += 120;
    clock.mark("sttFinal");
    t += 30;
    clock.mark("routerDecision");
    t += 200;
    clock.mark("firstAudio");
    t += 500;
    clock.mark("firstAudio");
    clock.mark("done");
    const s = clock.snapshot();
    expect(s.marks).toEqual({
      endOfSpeech: 0,
      sttFinal: 120,
      routerDecision: 150,
      firstAudio: 350,
      done: 850,
    });
    expect(s.voiceToVoiceMs).toBe(350);
    expect(s.totalMs).toBe(850);
    expect(s.vadHangMs).toBe(450);
  });

  test("waterfall bars chain from mark to mark, skipping missing stages", () => {
    const bars = waterfallBars({
      startedAt: 0,
      marks: { sttFinal: 100, firstToken: 300, firstAudio: 400, done: 900 },
      voiceToVoiceMs: 400,
      totalMs: 900,
    });
    expect(bars).toEqual([
      { mark: "sttFinal", from: 0, to: 100 },
      { mark: "firstToken", from: 100, to: 300 },
      { mark: "firstAudio", from: 300, to: 400 },
      { mark: "done", from: 400, to: 900 },
    ]);
  });

  test("summary median / p90 ignore nulls", () => {
    expect(summarize([100, null, 300, 200, undefined])).toEqual({
      n: 3,
      median: 200,
      p90: 280,
      mean: 200,
    });
    expect(summarize([])).toEqual({
      n: 0,
      median: null,
      p90: null,
      mean: null,
    });
  });
});
