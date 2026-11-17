import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("arbitrary, vocabulary, edited-valid and deeply corrupted note emphasis is refused or valid on a small stack", () => {
  const runner = fileURLToPath(new URL("./support/note-emphasis-property-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--stack_size=256", "--import", "tsx", runner], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("refused or valid: 3002");
}, 30_000);
