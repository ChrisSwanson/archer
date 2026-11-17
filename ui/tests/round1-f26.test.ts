// Round 1 (UI/UX) fixes, pass 7, batch F26: states and contrast. The browser test
// (`browser-ts/round1-f26.e2e.ts`) measures the painted pixels; this pins the rules and the token pairs they
// rest on, in both themes, so a token or selector change is caught without a browser.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = (path: string): string => readFileSync(resolve(__dirname, "../src", path), "utf8");
const styles = css("styles.css");

/** The custom properties a block declares, from the block that `selector` opens. */
function tokens(selector: string): Map<string, string> {
  const start = styles.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const body = styles.slice(start, styles.indexOf("\n}", start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}
const lin = (c: number): number => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a: string, b: string): number => {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const themes = { dark: tokens(':root,\n:root[data-theme="dark"]'), light: tokens(':root[data-theme="light"]') };
const pick = (theme: Map<string, string>, name: string): string => {
  const v = theme.get(name);
  expect(v, name).toBeDefined();
  return v!;
};

describe("G5-F1: pressed, selected and current wear an accent edge, not the accent fill alone", () => {
  it("the shared rule draws a 1px accent edge inside every borderless pressed or selected control", () => {
    const rule =
      /:is\(([^)]*)\):is\(\[aria-pressed="true"\], \[aria-selected="true"\]\) \{\s*box-shadow: inset 0 0 0 1px var\(--accent\);/.exec(
        styles,
      );
    expect(rule).not.toBeNull();
    const controls = rule![1]!.split(",").map((s) => s.trim());
    expect(controls).toEqual(expect.arrayContaining([".archer-pan-select-button", ".archer-walk-follow"]));
    // The segmented controls (One/All, walkthrough tabs, chat scope) turn their own border accent instead:
    // pinned with their shared rule in `round1-f29.test.ts` (R6-claude-04..06).
  });

  it("the controls with a border of their own (mode buttons, the Source toggle) turn it accent", () => {
    expect(css("app/diagram-panel.css")).toMatch(
      /\.archer-diagram-modes button\[aria-pressed="true"\] \{[^}]*border-color: var\(--accent\);/,
    );
    expect(css("authoring/authoring.css")).toMatch(
      /\.authoring-preview-source\[aria-pressed=true\]\{[^}]*border-color:var\(--accent\)/,
    );
    expect(css("app/SourcePanel.css")).toMatch(
      /\.archer-reader-source\[aria-pressed="true"\] \{[^}]*border-color: var\(--accent\);/,
    );
  });

  for (const [name, t] of Object.entries(themes))
    it(`in ${name}, the accent edge is 3:1 on its fill and on every ground those controls sit on`, () => {
      const accent = pick(t, "--accent");
      for (const ground of ["--accent-fill", "--surface", "--surface-2", "--bg"])
        expect(ratio(accent, pick(t, ground)), ground).toBeGreaterThanOrEqual(3);
    });
});

describe("G5-F3: one placeholder ink for every field", () => {
  it("is a tokenised ::placeholder rule at full opacity", () => {
    expect(styles).toMatch(/\n::placeholder \{\s*color: var\(--text-dim\);\s*opacity: 1;\s*\}/);
  });
  for (const [name, t] of Object.entries(themes))
    it(`in ${name}, it reads at 4.5:1 on the panel, the tint and the canvas`, () => {
      for (const ground of ["--surface", "--surface-2", "--bg"])
        expect(ratio(pick(t, "--text-dim"), pick(t, ground)), ground).toBeGreaterThanOrEqual(4.5);
    });
});

describe("G5-F4: a keyboard-focused edge or sequence message has a solid indicator", () => {
  for (const [what, pattern] of [
    ["edge", /\.archer-edge\.archer-kbd-focus \.react-flow__edge-path \{\s*filter:([^;]*);/],
    ["sequence message", /\.archer-seq-message\.archer-seq-kbd-focus \.archer-seq-message-stroke \{\s*filter:([^;]*);/],
  ] as const)
    it(`the ${what}'s halo is unblurred (a soft glow fades under 3:1 beside the line)`, () => {
      const rule = pattern.exec(styles)?.[1] ?? "";
      const shadows = [...rule.matchAll(/drop-shadow\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map((m) => m[1]!.trim());
      expect(shadows.length).toBeGreaterThan(0);
      for (const shadow of shadows) expect(shadow.split(/\s+/)[2], shadow).toBe("0");
      expect(shadows.some((s) => s.endsWith("var(--kbd-focus)"))).toBe(true);
    });
  for (const [name, t] of Object.entries(themes))
    it(`in ${name}, its ring is 3:1 on the canvas`, () => {
      expect(ratio(pick(t, "--kbd-focus"), pick(t, "--bg"))).toBeGreaterThanOrEqual(3);
    });
});
