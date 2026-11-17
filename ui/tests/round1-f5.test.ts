// Round 1 (UI/UX) fixes, pass 2, batch F5: what a stylesheet must say on its own. The browser checks are in
// tests/browser-ts/round1-f5.e2e.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = (path: string): string => readFileSync(resolve(import.meta.dirname, "../src", path), "utf8");
const rule = (source: string, selector: string): string => {
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} is in the stylesheet`).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf("}", at));
};

describe("round 1 pass 2, F5", () => {
  it("the panel divider is its band's containing block without walkthroughs.css (lazy in dev), so the band never covers the stage", () => {
    expect(rule(css("app/diagram-panel.css"), ".archer-stage-row > .archer-panel-divider")).toMatch(
      /(^|[;{\s])position:\s*relative/,
    );
  });
});
