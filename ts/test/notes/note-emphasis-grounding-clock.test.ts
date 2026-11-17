import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { MAX_NOTE_EMPHASIS_PASSAGES } from "../../../shared/note-emphasis.mts";
import { MAX_NOTE_BYTES } from "../../src/project/index.ts";

test("maximum-size repeated passage grounding remains bounded on a small stack", () => {
  const runner = fileURLToPath(new URL("./support/note-emphasis-grounding-clock-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--stack_size=256", "--import", "tsx", runner], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const measured = JSON.parse(result.stdout) as {
    fixtureBytes: number;
    passages: number;
    revision: number;
    orphans: number;
    upsertMs: number;
    readMs: number;
    maxRssKiB: number;
  };
  expect(measured).toMatchObject({
    fixtureBytes: MAX_NOTE_BYTES,
    passages: MAX_NOTE_EMPHASIS_PASSAGES,
    revision: 2,
    orphans: 0,
  });
  expect(measured.upsertMs).toBeLessThan(2_000);
  expect(measured.readMs).toBeLessThan(1_000);
  expect(measured.maxRssKiB).toBeLessThan(256 * 1024);
}, 25_000);
