// The two voices (the second design review, decided 2026-10-04): structure is
// neutral, and hue means exactly two things -- the person (selection, drafts,
// comment pins, their words) and the agent (emphasis, caption, replies, its
// mark on a pin). Both are tokens, in both themes, and every pair they are
// read in clears WCAG AA. Measured from the stylesheet, not quoted.
import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio, parseColour, type Rgb } from "./contrast";
import { declarationsOf, readStylesheet, rulesOf, tokensOf } from "./stylesheet";

const css = readStylesheet();

const THEMES = {
  dark: tokensOf(css, ':root[data-theme="dark"]'),
  light: tokensOf(css, ':root[data-theme="light"]'),
} as const;

/** A token's colour, following `var(--x)` aliases within its theme. */
function colour(theme: keyof typeof THEMES, name: string, seen: string[] = []): string {
  const value = THEMES[theme].get(name);
  if (value === undefined) throw new Error(`${name} is not declared in the ${theme} theme`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias === null) return value;
  if (seen.includes(alias[1]!)) throw new Error(`${name} aliases itself`);
  return colour(theme, alias[1]!, [...seen, name]);
}

/** What a token paints on the canvas: a translucent panel lands on `--bg`. */
function painted(theme: keyof typeof THEMES, name: string): Rgb {
  const bg = parseColour(colour(theme, "--bg")).rgb;
  return compositeOver(parseColour(colour(theme, name)), bg);
}

const ratio = (theme: keyof typeof THEMES, a: string, b: string): number =>
  contrastRatio(painted(theme, a), painted(theme, b));

describe.each(["dark", "light"] as const)("the %s theme", (theme) => {
  it("declares both voices", () => {
    for (const name of ["--you", "--you-ink", "--you-fill", "--agent", "--agent-ink", "--agent-fill", "--agent-text"]) {
      expect(() => colour(theme, name), name).not.toThrow();
    }
  });

  it("is the accent for the person: the reader's voice was already the accent", () => {
    expect(colour(theme, "--you")).toBe(colour(theme, "--accent"));
  });

  it.each([
    // Text: 4.5:1.
    ["the agent's name on its reply", "--agent-text", "--agent-fill", 4.5],
    ["the reply's words on its wash", "--text", "--agent-fill", 4.5],
    ["the agent's name on the panel", "--agent-text", "--panel", 4.5],
    ["a sent pin's number", "--you-ink", "--you", 4.5],
    ["a draft pin's number, on a node's white", "--you", "--node-bg", 4.5],
    ["a resolved thread's chip", "--agent-ink", "--agent", 4.5],
    // Marks and outlines: 3:1.
    ["the agent's mark on the canvas", "--agent", "--bg", 3],
    ["the agent's mark on a node", "--agent", "--node-bg", 3],
    ["a pin's outline on the canvas", "--you", "--bg", 3],
  ])("%s clears its floor", (_what, fg, bg, floor) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(floor);
  });
});

it("declares the same voices for an unstamped light root as for the explicit one", () => {
  const unstamped = tokensOf(css, ":root:not([data-theme])");
  for (const name of ["--you", "--you-ink", "--you-fill", "--agent", "--agent-ink", "--agent-fill", "--agent-text"]) {
    expect(unstamped.get(name), name).toBe(THEMES.light.get(name));
  }
});

describe("where the voices are spent", () => {
  /** Every declaration of the rules one of whose selectors contains `fragment`. */
  const declared = (fragment: string): string =>
    rulesOf(css)
      .filter((rule) => rule.selectors.some((selector) => selector.includes(fragment)))
      .flatMap((rule) => declarationsOf(rule.body).map(([p, v]) => `${p}: ${v}`))
      .join("\n");

  it("draws pins in the person's hue, and the agent's mark in the agent's", () => {
    expect(declared(".archer-pin")).toMatch(/var\(--you\)/);
    expect(declared(".archer-pin-agent")).toMatch(/var\(--agent\)/);
  });

  it("sets the agent's replies in the agent's hue, and the person's comments in theirs", () => {
    expect(declared('.archer-comment[data-author="agent"]')).toMatch(/var\(--agent-fill\)/);
    expect(declared('[data-author="agent"] .archer-comment-author')).toMatch(/var\(--agent-text\)/);
    expect(declared('[data-author="person"] .archer-comment-author')).toMatch(/var\(--you\)|var\(--accent-quiet\)/);
  });

  it("marks the agent's caption as the agent's", () => {
    expect(declared(".archer-caption-by")).toMatch(/var\(--agent-text\)/);
  });

  it("marks passages in the opening comment's voice", () => {
    expect(declared(".archer-passage--person")).toMatch(/var\(--you\)/);
    expect(declared(".archer-passage--agent")).toMatch(/var\(--agent\)/);
  });

  it("names no other hue in the comment chrome", () => {
    const chrome = rulesOf(css).filter((rule) =>
      rule.selectors.some((s) => /archer-(pin|thread|comment|review-rail|send)/.test(s)),
    );
    for (const rule of chrome) {
      for (const [, value] of declarationsOf(rule.body)) {
        expect(value, rule.selectors.join(", ")).not.toMatch(/var\(--g[1-4]\)|#[0-9a-f]{3,8}\b/i);
      }
    }
  });
});
