import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../src/core/registry";
import { ProfileStore } from "../src/main/profiles";
import { localLoopProfile } from "../src/shared/profile";
import { setup } from "./helpers";

describe("local speech loop", () => {
  test("has no sidecars, remote brain, device actions or escalation", () => {
    const profile = localLoopProfile();
    expect(profile.sidecars).toEqual([]);
    expect(profile.stt.provider).toBe("parakeet-local");
    expect(profile.brain.provider).toBe("echo");
    expect(profile.tools.provider).toBe("none");
    expect(profile.tools.enabled).toEqual([]);
    expect(profile.escalation.provider).toBe("none");
    expect(profile.tts.provider).toBe("phonon-wasm");
  });

  test("typed loop repeats the transcript through existing orchestration", async () => {
    const { orchestrator } = setup();
    const profile = localLoopProfile();
    profile.tts = { provider: "mock", options: { delayMs: 0, msPerChar: 1 } };
    const record = await orchestrator.runTurn({
      source: "text",
      text: "A real speech loop, not a language model.",
      profile,
    });
    expect(record.status).toBe("done");
    expect(record.reply).toBe(record.transcript);
    expect(record.tools).toEqual([]);
  });

  test("new stores choose Local loop without overwriting a saved active profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "parrotfish-local-test-"));
    try {
      const fresh = new ProfileStore(dir);
      expect(fresh.activeProfileName).toBe("Local loop");
      fresh.setActive("Mock");
      fresh.save(
        { ...localLoopProfile(), description: "owner edit" },
        "Local loop",
      );
      const reopened = new ProfileStore(dir);
      expect(reopened.activeProfileName).toBe("Mock");
      expect(reopened.get("Local loop").description).toBe("owner edit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loop brain is explicit and rejects an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const brain = createProvider("brain", localLoopProfile());
    const { host } = setup();
    await expect(
      (async () => {
        for await (const _token of brain.stream(
          [{ role: "user", content: "hello" }],
          { host, signal: controller.signal },
        )) {
          /* cancelled */
        }
      })(),
    ).rejects.toThrow("cancelled");
  });
});
