// The quiet neutral ("Dropped", the loop's `gone`) is told from the plain neutral (the AI's work) in dark as in light
// (owner's image; legend agent's finding, 2026-11-12): in dark both were near-black slates. Like light's, dark's quiet
// neutral is a step of neutral grey away from the plain card -- a visible change of fill and a dimmer outline -- and
// still readable and still an outline.
import { describe, expect, it } from "vitest";
import { contrastRatio, deltaE, parseColour, type Rgb } from "./contrast";
import { readStylesheet } from "./stylesheet";

const CSS = readStylesheet();
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(declaration);
    if (match !== null) tokens.set(match[1]!, match[2]!);
  }
  return tokens;
}
const THEMES = {
  light: block(':root[data-theme="light"]'),
  dark: block(':root,\n:root[data-theme="dark"]'),
} as const;
const colour = (theme: keyof typeof THEMES, token: string): Rgb => parseColour(THEMES[theme].get(token)!).rgb;

describe("the quiet neutral in dark", () => {
  it("is a visible step from the plain neutral: its fill and its outline", () => {
    expect(deltaE(colour("dark", "--node-quiet-bg"), colour("dark", "--node-bg"))).toBeGreaterThanOrEqual(6);
    expect(deltaE(colour("dark", "--node-quiet-border"), colour("dark", "--node-border"))).toBeGreaterThanOrEqual(15);
  });

  it("is at least as far from the plain neutral as light's is", () => {
    for (const token of ["bg", "border"] as const)
      expect(
        deltaE(colour("dark", `--node-quiet-${token}`), colour("dark", `--node-${token}`)),
        token,
      ).toBeGreaterThanOrEqual(deltaE(colour("light", `--node-quiet-${token}`), colour("light", `--node-${token}`)));
  });

  it("recedes yet reads: its outline quieter than the plain one but 3:1 on the canvas, its words 4.5:1", () => {
    const canvas = colour("dark", "--bg");
    const quiet = contrastRatio(colour("dark", "--node-quiet-border"), canvas);
    expect(quiet).toBeGreaterThanOrEqual(3);
    expect(quiet).toBeLessThan(contrastRatio(colour("dark", "--node-border"), canvas));
    expect(
      contrastRatio(colour("dark", "--node-quiet-text"), colour("dark", "--node-quiet-bg")),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
