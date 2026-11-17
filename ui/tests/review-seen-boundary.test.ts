// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

it("never throws and stays bounded on arbitrary, vocabulary-built, and edited valid input on a small stack", () => {
  const directory = mkdtempSync(join(tmpdir(), "archer-review-seen-"));
  try {
    const module = join(directory, "review-seen.mjs");
    buildSync({
      entryPoints: [resolve(import.meta.dirname, "../src/comments/review-seen.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: module,
      logLevel: "silent",
    });
    const runner = resolve(import.meta.dirname, "support/review-seen-property-runner.mjs");
    expect(
      execFileSync(process.execPath, ["--stack-size=192", runner, module], { encoding: "utf8", timeout: 10_000 }),
    ).toBe("review seen outcomes bounded");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
