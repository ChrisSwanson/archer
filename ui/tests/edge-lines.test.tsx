// @vitest-environment jsdom
//
// An edge says how its line is drawn: solid, dotted or thick.
//
// Wire contract version 2 carries `line` on every edge (ADR 0009: `-->`,
// `-.->`, `==>`), and for a while nothing drew it. The line is SHAPE -- a dash
// pattern and a weight -- so it reads without colour, and it has to go on
// reading while the edge is hovered, selected, emphasised or dimmed, all of
// which also restyle the same stroke.
//
// Enumerated over the whole vocabulary, per AGENTS.md: a fourth line style
// with no drawing fails here instead of silently rendering solid.
//
// jsdom resolves no `calc()` and no `var()`, so what is asserted is the class
// each edge is given and the rules the stylesheet on disk holds for it. What
// they look like is checked in a real browser.
import { cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout } from "../src/layout/elk-adapter";
import { EDGE_LINES } from "../src/layout/graph-metrics";
import { toXFlowEdges } from "../src/diagrams/xflow-adapter";
import type { EdgeLine, ProjectedView } from "../src/diagrams/projection";

afterEach(cleanup);

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULES: { selector: string; body: string }[] = [];
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  RULES.push({ selector: match[1].trim(), body: match[2] });
}
/** Every rule that restyles the routed line of an Archer edge. */
const PATH_RULES = RULES.filter(
  (rule) => rule.selector.includes(".archer-edge") && rule.selector.includes(".react-flow__edge-path"),
);

function view(lines: readonly (EdgeLine | undefined)[]): ProjectedView {
  return {
    viewId: "lines",
    kind: "freeform",
    title: "Lines",
    revision: "1",
    modelType: "freeform-graph",
    groups: [],
    nodes: ["a", "b"].map((id) => ({ id, label: id, shape: "rectangle", classes: [], groupId: undefined })),
    edges: lines.map((line, index) => ({
      id: `e${index}`,
      source: "a",
      target: "b",
      label: undefined,
      ...(line === undefined ? {} : { line }),
    })),
  };
}

describe("every line style reaches the canvas", () => {
  it("knows every line version 2 of the contract can send", () => {
    // ADR 0030 adds the authored dashes to version 2: additive optional values.
    expect([...EDGE_LINES].sort()).toEqual(["dashdot", "dashed", "dotted", "solid", "thick"]);
  });

  it.each(EDGE_LINES)("carries %s through the layout and names it on the edge", async (line) => {
    const layout = await computeLayout(view([line]));
    const [edge] = toXFlowEdges(layout);
    const lineClasses = (edge.className ?? "").split(" ").filter((name) => name.startsWith("archer-line-"));

    expect(lineClasses).toEqual([`archer-line-${line}`]);
    // Still the Archer edge every state rule hangs off.
    expect(edge.className).toContain("archer-edge");
  });

  it("draws an edge that states no line as solid", async () => {
    const [edge] = toXFlowEdges(await computeLayout(view([undefined])));
    expect(edge.className).toContain("archer-line-solid");
  });

  it.each(EDGE_LINES)("keeps the arrowhead of a %s edge the same solid head", async (line) => {
    const [plain] = toXFlowEdges(await computeLayout(view([undefined])));
    const [edge] = toXFlowEdges(await computeLayout(view([line])));
    expect(edge.markerEnd).toEqual(plain.markerEnd);
    // A dash pattern is inherited by nothing: it is set on the path alone,
    // never on the edge group the marker could be reached through.
    const onGroup = RULES.filter(
      (rule) => /stroke-dasharray/.test(rule.body) && /\.archer-line-[\w-]+\s*$/.test(rule.selector),
    );
    expect(onGroup).toEqual([]);
  });

  it("puts the line class on the element the stylesheet styles", async () => {
    const layout = await computeLayout(view(["dotted", "thick", undefined]));
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__edge").length).toBe(3);
    });
    const classOf = (id: string): string =>
      container.querySelector(`.react-flow__edge[data-id="${id}"]`)!.getAttribute("class")!;
    expect(classOf("e0")).toContain("archer-line-dotted");
    expect(classOf("e1")).toContain("archer-line-thick");
    expect(classOf("e2")).toContain("archer-line-solid");
    expect(container.querySelector(".archer-line-dotted .react-flow__edge-path")).not.toBeNull();
  });
});

describe("each line is told apart by shape, in every state", () => {
  const drawn = (line: string): string =>
    RULES.filter((rule) => rule.selector.includes(`.archer-line-${line}`))
      .map((rule) => rule.body.replace(/\s+/g, " ").trim())
      .join("\n");

  it.each(EDGE_LINES.filter((line) => line !== "solid"))("draws %s with rules of its own", (line) => {
    expect(drawn(line), `no rule mentions .archer-line-${line}`).not.toBe("");
  });

  it("draws every non-solid line differently from every other", () => {
    const drawings = EDGE_LINES.filter((line) => line !== "solid").map(drawn);
    expect(new Set(drawings).size).toBe(drawings.length);
  });

  it("never tells a line apart by colour", () => {
    for (const rule of RULES.filter((rule) => rule.selector.includes(".archer-line-"))) {
      expect(rule.body, rule.selector).not.toMatch(/(^|[;\s])(stroke|color|fill)\s*:/);
    }
  });

  it("draws dotted as a dash pattern on the line itself", () => {
    const dotted = PATH_RULES.filter((rule) => rule.selector.includes(".archer-line-dotted"));
    expect(dotted.map((rule) => rule.body).join("\n")).toMatch(/stroke-dasharray:\s*[\d.]+\s+[\d.]+/);
  });

  // The base stroke, hover, selection and a highlight emphasis each set the
  // stroke's width. Were thick one rule on the base stroke, a thick edge would
  // be exactly as heavy as a solid one for as long as any of those states
  // held. So every rule that sets a width has a thick twin -- the same
  // selector with the line class added, which also makes it the heavier
  // selector -- and the twin is visibly heavier.
  describe("thick stays heavier than solid in every state that sets the width", () => {
    const width = (body: string): { px: number; important: boolean } | undefined => {
      const found = /stroke-width\s*:\s*([\d.]+)(?:px)?\s*(!important)?\s*;/.exec(body);
      return found ? { px: Number(found[1]), important: found[2] !== undefined } : undefined;
    };
    const plain = PATH_RULES.filter(
      (rule) => width(rule.body) !== undefined && !rule.selector.includes(".archer-line-"),
    );

    it("finds the states that set a width", () => {
      const selectors = plain.map((rule) => rule.selector).join("\n");
      expect(plain.length).toBeGreaterThanOrEqual(4);
      for (const state of [":hover", ".selected", ".archer-emph"]) {
        expect(selectors, `no width rule for ${state}`).toContain(state);
      }
    });

    it.each(plain.map((rule) => [rule.selector, rule] as const))("%s", (selector, rule) => {
      const twinSelector = selector.replace(".archer-edge", ".archer-edge.archer-line-thick");
      const twin = PATH_RULES.find((candidate) => candidate.selector === twinSelector);
      expect(twin, `no rule \`${twinSelector}\``).toBeDefined();

      const solid = width(rule.body)!;
      const thick = width(twin!.body);
      expect(thick, `\`${twinSelector}\` sets no width`).toBeDefined();
      expect(thick!.px).toBeGreaterThanOrEqual(solid.px + 1.5);
      expect(thick!.important).toBe(solid.important);
      // Equal weight is settled by order, so the twin must also come later.
      expect(PATH_RULES.indexOf(twin!)).toBeGreaterThan(PATH_RULES.indexOf(rule));
    });
  });

  // The weights themselves (owner, 2026-11-15: borders and lines were too heavy, "cartoony"): a 2px resting line,
  // and every state weighed from it -- thick exactly 2px heavier in each, hover a step heavier, selection 2px of
  // accent each side, and emphasis no heavier at all (ADR 0030: colour, not width).
  describe("weighs every state from the resting 2px line", () => {
    const px = (selector: string): number => {
      const rule = PATH_RULES.find((candidate) => candidate.selector === selector);
      const found = /stroke-width\s*:\s*([\d.]+)/.exec(rule?.body ?? "");
      expect(found, `no width on \`${selector}\``).not.toBeNull();
      return Number(found![1]);
    };
    const thick = (selector: string) => selector.replace(".archer-edge", ".archer-edge.archer-line-thick");
    const REST = ".archer-edge .react-flow__edge-path";
    const HOVER = ".archer-edge.selectable:hover .react-flow__edge-path";
    const SELECTED = ".archer-edge.selected .react-flow__edge-path";
    const EMPH = ".archer-edge.archer-emph .react-flow__edge-path";

    it("rests at 2px", () => {
      expect(px(REST)).toBe(2);
    });

    it.each([REST, HOVER, SELECTED, EMPH])("draws thick exactly 2px heavier: %s", (selector) => {
      expect(px(thick(selector))).toBe(px(selector) + 2);
    });

    it("is heavier when pointed at and when selected, and not when emphasised", () => {
      expect(px(HOVER)).toBeGreaterThan(px(REST));
      expect(px(SELECTED)).toBe(px(REST) + 4);
      expect(px(EMPH)).toBe(px(REST));
    });
  });

  // Emphasis never dashes a line (ADR 0030), so a dotted edge keeps exactly
  // its own pattern under any emphasis: one cue per meaning.
  it("leaves a dotted edge's pattern to the source under an emphasis", () => {
    const dashing = PATH_RULES.filter(
      (rule) => /stroke-dasharray/.test(rule.body) && rule.selector.includes(".archer-emph"),
    );
    expect(dashing.map((rule) => rule.selector)).toEqual([]);
  });

  // A flow emphasis steps the line back to 55% so the packet leads. A dotted
  // line has already given up two thirds of its ink to the gaps; at 55% on top
  // of that the dots all but vanished on the light canvas (seen in a browser,
  // not predicted), and the edge the agent pointed at was the faintest thing
  // on screen.
  it("does not fade a dotted edge under a flow emphasis as far as a solid one", () => {
    // The solid line's opacity is a per-theme token (round 1, Cl-05b: a 3:1 line in every hue); the most opaque
    // theme is the one a dotted line has to stay above.
    const themes = [...css.matchAll(/--flow-line-opacity:\s*([\d.]+);/g)].map((m) => Number(m[1]));
    const opacity = (rule: (typeof PATH_RULES)[number] | undefined): number => {
      const body = rule?.body ?? "";
      if (/stroke-opacity:\s*var\(--flow-line-opacity\)/.test(body)) return Math.max(...themes);
      return Number(/stroke-opacity:\s*([\d.]+)/.exec(body)?.[1] ?? Number.NaN);
    };
    const flow = PATH_RULES.filter((rule) => rule.selector.includes(".archer-emph-style-flow"));
    const solid = flow.find(
      (rule) => !rule.selector.includes(".archer-line-") && !rule.selector.includes(".archer-emph-static"),
    );
    const dotted = flow.find((rule) => rule.selector.includes(".archer-line-dotted"));
    const still = flow.find((rule) => rule.selector.includes(".archer-emph-static"));

    expect(dotted, "no rule for a dotted edge under a flow emphasis").toBeDefined();
    expect(opacity(dotted)).toBeGreaterThanOrEqual(0.8);
    expect(opacity(dotted)).toBeGreaterThan(opacity(solid));
    // It must win over the solid rule, and lose to reduced motion's full line.
    expect(PATH_RULES.indexOf(dotted!)).toBeGreaterThan(PATH_RULES.indexOf(solid!));
    expect(PATH_RULES.indexOf(still!)).toBeGreaterThan(PATH_RULES.indexOf(dotted!));
    expect(opacity(still)).toBe(1);
  });

  it("never removes the dash pattern in any state", () => {
    for (const rule of PATH_RULES) {
      expect(rule.body, rule.selector).not.toMatch(/stroke-dasharray:\s*(none|0)\b/);
    }
  });
});
