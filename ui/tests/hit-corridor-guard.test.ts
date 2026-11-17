// A pointer target never changes shape with state.
//
// The defect this guards (found in a real browser, `graph-pointer.e2e.ts`):
// the retired Line map design drew keyboard focus by restyling `.react-flow__edge-interaction`
// itself, from the 24px solid corridor to an 11px dashed stroke. A press gives
// the edge focus, so the corridor shrank BETWEEN press and release; the release
// landed on the pane behind it, press and release no longer shared an element,
// and Chromium dispatched the `click` to the pane. jsdom does no hit-testing
// and cannot see that outcome, so this pins the cause structurally: the
// stylesheet may state a hit element's geometry once, under its bare class,
// and nowhere else. A state mark is drawn on an element of its own.
import { describe, expect, it } from "vitest";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

const CSS = readStylesheet();

/** Every element whose only job is to be hit by a pointer. */
const HIT_TARGETS = [".react-flow__edge-interaction", ".archer-seq-hit", ".archer-seq-lifeline-hit"] as const;

/** What decides where a stroke or a box is hit. */
const GEOMETRY = new Set([
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "fill",
  "pointer-events",
  "display",
  "visibility",
  "d",
  "x",
  "y",
  "width",
  "height",
  "transform",
]);

/** The last compound of a selector: the element the rule styles. */
function subjectOf(selector: string): string {
  const parts = selector.split(/[\s>+~]+/);
  return parts[parts.length - 1];
}

describe("pointer hit targets", () => {
  for (const target of HIT_TARGETS) {
    it(`${target} has its geometry stated only under its bare class`, () => {
      const offenders: string[] = [];
      for (const rule of rulesOf(CSS)) {
        for (const selector of rule.selectors) {
          if (!subjectOf(selector).includes(target) || selector === target) {
            continue;
          }
          for (const [property] of declarationsOf(rule.body)) {
            if (GEOMETRY.has(property)) {
              offenders.push(`${selector} { ${property} }`);
            }
          }
        }
      }
      expect(offenders, "a qualified rule changes where this element is hit").toEqual([]);
    });
  }

  it("the edge's keyboard mark is an element of its own that no pointer can hit", () => {
    const rule = rulesOf(CSS).find((candidate) => candidate.selectors.includes(".archer-edge-focus-mark"));
    expect(rule, "a bare .archer-edge-focus-mark rule").toBeDefined();
    const declared = new Map(declarationsOf(rule!.body));
    expect(declared.get("pointer-events")).toBe("none");
    // Unpainted until a design asks for it, so the Current design is unchanged.
    expect(declared.get("stroke")).toBe("none");
    expect(declared.get("fill")).toBe("none");
  });
});
