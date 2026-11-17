// Counts are compared measurements. There is deliberately no baseline ratchet.
// The guard's sensitivity is pinned by pass/fail fixtures, using the same scanner as the CLI.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCss, staticCensus } from "../../tools/devkit/harness/tokens.mjs";
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../tools/devkit/fixtures/token-${name}.css`, import.meta.url)), "utf8");
describe("token guard known fixtures", () => {
  it("reports repository counts as compared metrics without a baseline ratchet", () => {
    const result = staticCensus();
    expect(result.metricPolicy).toBe("compared");
    expect(result.files).toBeGreaterThan(0);
    console.info("token census (compared):", JSON.stringify({ files: result.files, counts: result.counts }));
  });
  it("accepts a label and glyph sized with tokens", () => {
    const result = auditCss(fixture("pass"), { file: "token-pass.css" });
    expect(result.ok).toBe(true);
    expect(result.counts.fontSize).toEqual({ raw: 0, tokens: 1 });
    expect(result.counts.iconSize).toEqual({ raw: 0, tokens: 2 });
  });
  it("rejects a planted 13px label and names its file and line", () => {
    const result = auditCss(fixture("fail"), { file: "token-fail.css" });
    expect(result.ok).toBe(false);
    expect(result.counts.fontSize.raw).toBe(1);
    expect(result.declarations).toContainEqual(
      expect.objectContaining({ file: "token-fail.css", line: 3, property: "font-size", value: "13px", raw: true }),
    );
  });
});
