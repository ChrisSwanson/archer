// Every keyboard focus stop shows where the focus is, in the same language.
//
// A focus indicator is not decoration: for someone driving the page from the
// keyboard it is the only thing saying where they are. The app already answers
// that consistently -- a 2px `--accent` ring on chips and the theme
// toggle -- and one control answered it with a background tint instead, having
// explicitly removed the outline. A surface token on a surface-token panel is
// unlikely to clear the 3:1 non-text contrast floor in either theme, and it is
// a second visual language for the same fact besides.
//
// Enumerated rather than spot-checked, per AGENTS.md: a new focusable control
// that forgets its ring should fail this suite rather than ship unnoticed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STYLESHEET = "src/styles.css";
const css = readFileSync(STYLESHEET, "utf8");

/** Every class in the app that is a keyboard focus stop. */
const FOCUSABLE_CONTROLS = [
  "archer-dataflow-chip",
  "archer-theme-toggle",
  // The native legend button owns keyboard focus; its surrounding list item
  // mirrors the ring with :has(), while the button draws the shared outline.
  "archer-emph-legend-body",
] as const;

/** The declarations of every rule whose selector list mentions the class. */
function focusVisibleBodies(control: string): string[] {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(css); match !== null; match = rule.exec(css)) {
    const [, selector, body] = match;
    if (selector.includes(`.${control}:focus-visible`)) {
      bodies.push(body);
    }
  }
  return bodies;
}

describe("keyboard focus is always visible", () => {
  it.each(FOCUSABLE_CONTROLS)("%s draws the shared focus ring", (control) => {
    const bodies = focusVisibleBodies(control);

    expect(bodies, `.${control} has no :focus-visible rule at all`).not.toHaveLength(0);
    const ring = bodies.join("\n");
    // The same ring everywhere: one visual language for one fact.
    expect(ring, `.${control} does not draw a 2px accent ring`).toMatch(/outline:\s*2px\s+solid\s+var\(--accent\)/);
  });

  it.each(FOCUSABLE_CONTROLS)("%s never suppresses its own outline", (control) => {
    const suppressed = focusVisibleBodies(control).some((body) => /outline:\s*none/.test(body));

    expect(suppressed, `.${control} removes the outline on :focus-visible`).toBe(false);
  });
});
