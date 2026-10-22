import { describe, expect, test } from "bun:test";
import {
  SentenceSplitter,
  findBoundary,
  speakable,
  splitAll,
} from "../src/core/splitter";
import { DEFAULT_SPLITTER } from "../src/shared/profile";

const cfg = { ...DEFAULT_SPLITTER, eagerFirstClause: false };

function streamed(text: string, config = cfg, step = 3): string[] {
  const s = new SentenceSplitter(config);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step)
    out.push(...s.push(text.slice(i, i + step)));
  return [...out, ...s.flush()];
}

describe("sentence splitter", () => {
  test("splits on sentence ends as tokens stream in", () => {
    expect(
      streamed("Hello there, friend. How are you today? I am fine!"),
    ).toEqual(["Hello there, friend.", "How are you today?", "I am fine!"]);
  });

  test("waits to see what follows a period (decimals, abbreviations, initials)", () => {
    expect(findBoundary("It costs 3.")).toBe(-1);
    expect(
      streamed(
        "Version 3.5 shipped today. Dr. Smith said so, e.g. in the notes. J. R. R. Tolkien agreed.",
      ),
    ).toEqual([
      "Version 3.5 shipped today.",
      "Dr. Smith said so, e.g. in the notes.",
      "J. R. R. Tolkien agreed.",
    ]);
  });

  test("merges a too-short sentence into the next one", () => {
    expect(streamed("Ok. That is the plan for tonight.")).toEqual([
      "Ok. That is the plan for tonight.",
    ]);
  });

  test("cuts the first clause early when eagerFirstClause is on", () => {
    const out = streamed(
      "Well, the quick brown fox jumps over, and then it runs far away.",
      { ...DEFAULT_SPLITTER, eagerFirstClause: true },
    );
    expect(out[0]).toBe("Well, the quick brown fox jumps over,");
    expect(out[1]).toBe("and then it runs far away.");
  });

  test("cuts run-ons at maxChars", () => {
    const text = "word ".repeat(100);
    const out = splitAll(text, { ...cfg, maxChars: 60 });
    expect(out.length).toBeGreaterThan(5);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(60);
  });

  test("strips markdown and emoji", () => {
    expect(
      speakable("## Title\n- **bold** item `code` [link](http://x) 🎉"),
    ).toBe("Title bold item code link");
  });
});
