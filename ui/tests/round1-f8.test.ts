// Round 1 (UI/UX) fixes, pass 3, batch F8 row e (G5, RS2-03): the sequence lifeline is a graphic that ties
// each message to its participant, so it holds 3:1 against the canvas in every theme. Measured from the
// stylesheet, as the palette tests do, not trusted from a comment.
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColour } from "./contrast";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

const CSS = readStylesheet();

/** The custom properties the rules whose selector list names this selector declare (the last wins). */
function themeTokens(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of rulesOf(CSS).filter((candidate) => candidate.selectors.includes(selector))) {
    for (const [property, value] of declarationsOf(rule.body))
      if (property.startsWith("--")) found.set(property, value);
  }
  return found;
}

const THEMES = [
  ["dark", ':root[data-theme="dark"]'],
  ["light (system)", ":root:not([data-theme])"],
  ["light", ':root[data-theme="light"]'],
] as const;

describe("the sequence lifeline", () => {
  const stroke = rulesOf(CSS).find((rule) => rule.selectors.includes(".archer-seq-lifeline"));
  const token = /^var\((--[\w-]+)\)$/.exec(
    declarationsOf(stroke?.body ?? "").find(([property]) => property === "stroke")?.[1] ?? "",
  )?.[1];

  it("is drawn in a token", () => {
    expect(token).toBeDefined();
  });

  for (const [name, selector] of THEMES) {
    it(`is at least 3:1 on the canvas, ${name}`, () => {
      const tokens = themeTokens(selector);
      const line = tokens.get(token!);
      const bg = tokens.get("--bg");
      expect(line, `${selector} sets ${token}`).toBeDefined();
      expect(bg, `${selector} sets --bg`).toBeDefined();
      expect(contrastRatio(parseColour(line!).rgb, parseColour(bg!).rgb)).toBeGreaterThanOrEqual(3);
    });
  }
});

// Follow-up (coordinator): the exported sequence SVG draws as the canvas does -- the lifeline in the canvas's
// lifeline token, and each participant's name at the participant size, not a literal of its own.
describe("the exported sequence", () => {
  it("draws its lifelines in --lifeline and its participants at PARTICIPANT_FONT", async () => {
    const { projectEnvelope } = await import("../src/diagrams/projection");
    const { computeSequenceLayout, PARTICIPANT_FONT } = await import("../src/layout/sequence-layout");
    const { paintSequence } = await import("../src/export/sequence");
    const { loadValidFixture } = await import("./fixtures");
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence")
      throw new Error("minimal-sequence.json did not project to a sequence view");
    const layout = computeSequenceLayout(projection.view);
    const svg = paintSequence(layout).content;
    expect(svg).not.toContain("var(--border-hover)");
    const lifelines = svg.match(/<path d="M [\d.]+ [\d.]+ V [\d.]+" fill="none" stroke="var\(--lifeline\)"/g) ?? [];
    expect(lifelines).toHaveLength(layout.participants.length);
    // A participant's name: the text right after its box.
    const names = [
      ...svg.matchAll(
        /stroke-width="1\.5"\/>(?:<g fill="none"[\s\S]*?<\/g>)?<g fill="currentColor" stroke="none"><text [^>]*font-size="([\d.]+)"/g,
      ),
    ].map((match) => Number(match[1]));
    expect(names).toHaveLength(layout.participants.length);
    for (const size of names) expect(size).toBe(PARTICIPANT_FONT);
  });

  it("states the participant size through the layout's constant, not a literal that could drift", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/export/sequence.ts"), "utf8");
    expect(source).toMatch(/textRows\(p\.lines, tx, [^\n]*?, PARTICIPANT_FONT, /);
  });
});
