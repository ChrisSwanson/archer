// The warm-up sources must compile, one per family the compiler dispatches on, or warming
// silently skips a family and its first request pays the parser load again.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/compile.ts";
import { WARM_SOURCES, warmCompilers } from "../../src/mermaid/warm.ts";

test("every warm-up source compiles", async () => {
  for (const [family, source] of Object.entries(WARM_SOURCES)) {
    const result = await compile(source);
    expect([family, result.diagnostics.filter((d) => d.severity === "error")]).toEqual([family, []]);
    expect(result.model).not.toBeNull();
  }
});

test("warm-up covers every family compile.ts dispatches on", () => {
  const dispatch = readFileSync(new URL("../../src/mermaid/compile.ts", import.meta.url), "utf8");
  const families = [...dispatch.matchAll(/family === "([a-z0-9]+)"/g)].map((match) => match[1]);
  expect(families.length).toBeGreaterThan(5);
  expect(Object.keys(WARM_SOURCES).sort()).toEqual([...new Set(families)].sort());
});

test("warmCompilers resolves with its duration and never throws", async () => {
  expect(await warmCompilers()).toBeGreaterThanOrEqual(0);
});
