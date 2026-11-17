// The walked tone (ADR 0034 §4): earlier steps stay on the diagram in a quieter teal that still
// clears 3:1 on the canvas and on a box, in both themes, and is not the current step's teal.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, deltaE, parseColour } from "./contrast";

const css = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const block = (opener: string): string => {
  const at = css.indexOf(opener);
  expect(at, opener).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
};
const THEMES = {
  dark: block(':root,\n:root[data-theme="dark"] {'),
  light: block(':root[data-theme="light"] {'),
} as const;
const token = (theme: keyof typeof THEMES, name: string): string => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(THEMES[theme]);
  expect(match, `${theme} ${name}`).not.toBeNull();
  return match![1]!;
};
const rgb = (theme: keyof typeof THEMES, name: string) => parseColour(token(theme, name)).rgb;

describe.each(["dark", "light"] as const)("--walked, %s", (theme) => {
  it("clears 3:1 on the canvas and on a box", () => {
    expect(contrastRatio(rgb(theme, "--walked"), rgb(theme, "--bg"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(rgb(theme, "--walked"), rgb(theme, "--node-bg"))).toBeGreaterThanOrEqual(3);
  });
  it("is quieter than the current step's teal, and still a different colour from a plain line", () => {
    expect(contrastRatio(rgb(theme, "--walked"), rgb(theme, "--bg"))).toBeLessThan(
      contrastRatio(rgb(theme, "--g1"), rgb(theme, "--bg")),
    );
    expect(deltaE(rgb(theme, "--walked"), rgb(theme, "--edge"))).toBeGreaterThan(5);
  });
});

it("the walked class sets the hue, after the palette classes that it overrides", () => {
  const walked = css.indexOf(".archer-emph--walked");
  expect(walked).toBeGreaterThan(css.indexOf(".archer-emph-palette-coral {"));
  expect(css.slice(walked, css.indexOf("}", walked))).toContain("--emph-hue: var(--walked)");
});

it("the walked box border out-ranks the emphasised box's 3px (both are !important, so specificity decides)", () => {
  // Half a step under the emphasised box's 3px, which is a step over the resting 2px (diagram palette, 2026-11-11).
  // Through the line roles (slice 8): --line-selected is 2.5px, --line-emphasis 3px.
  const rule =
    /\.archer-node\.archer-emph\.archer-emph--walked\s*\{[^}]*border-width:\s*var\(--line-selected\) !important/;
  expect(css).toMatch(rule);
});
