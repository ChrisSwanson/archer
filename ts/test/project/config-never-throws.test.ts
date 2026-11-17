import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("project configuration is refused or valid for arbitrary, vocabulary and edited valid input on a small stack", () => {
  const runner = fileURLToPath(new URL("./support/config-property-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--stack_size=256", "--import", "tsx", runner], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("project outcomes refused or valid: 3001");
}, 15_000);
