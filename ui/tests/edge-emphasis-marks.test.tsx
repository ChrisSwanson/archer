// @vitest-environment jsdom
//
// The agent's emphasis on a graph edge is its colour, and nothing else
// (ADR 0030): the line and its arrowheads take the group's hue. No band, no
// widening past 2px, no dash. A selection takes the line's stroke, as it
// always has; the arrowheads keep the hue, because each edge's markers are its
// own and read their ink from the edge rather than from the selection.
//
// With motion off, a `flow` edge's arrows are parked clear of the caption.
// jsdom paints nothing; these pin the markup and the rules. The pictures are
// the browser test's.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import { parseEmphasis, type Emphasis } from "../src/emphasis/contract";
import { CHEVRON_REACH, parkedAt, travelSeconds } from "../src/emphasis/EmphasisChevrons";
import { installReducedMotion } from "./match-media";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

const view: ProjectedView = {
  viewId: "marks",
  kind: "freeform",
  title: "Marks",
  revision: "1",
  modelType: "freeform-graph",
  direction: "lr",
  nodes: [
    { id: "a", label: "Alpha", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "Beta", shape: undefined, classes: [], groupId: undefined },
    { id: "c", label: "Gamma", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [
    { id: "captioned", source: "a", target: "b", label: "hands over" },
    { id: "plain", source: "b", target: "c", label: undefined },
  ],
  groups: [],
};

let layout: LayoutResult;
beforeAll(async () => {
  layout = await computeLayout(view);
});
beforeEach(() => installReducedMotion(false));
afterEach(() => {
  cleanup();
  localStorage.removeItem("archer.flow-animation");
});

function emphasis(group: Record<string, unknown>): Emphasis {
  const parsed = parseEmphasis({
    id: "e",
    viewId: "marks",
    title: "E",
    groups: [{ id: "g", palette: "teal", ...group }],
  });
  expect(parsed).toBeDefined();
  return parsed!;
}

async function drawn(value: Emphasis | null, edgeId: string): Promise<Element> {
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} emphasis={value} />);
  await waitFor(() => expect(container.querySelector(`.react-flow__edge[data-id="${edgeId}"]`)).not.toBeNull());
  return container.querySelector(`.react-flow__edge[data-id="${edgeId}"]`)!;
}

describe("an emphasised edge is its line and arrowheads in the hue", () => {
  it.each(["highlight", "flow"])("a %s edge draws no band or other mark of its own", async (style) => {
    const edge = await drawn(emphasis({ style, edges: ["plain"] }), "plain");
    expect(edge.querySelector(".archer-edge-emph-band")).toBeNull();
    expect(edge.classList.contains("archer-emph")).toBe(true);
  });

  it("draws its arrowheads from the edge's own ink, so the hue reaches them", async () => {
    const edge = await drawn(emphasis({ style: "highlight", edges: ["plain"] }), "plain");
    const arrow = edge.querySelector("marker polyline");
    expect(arrow, "the edge's own arrowhead").not.toBeNull();
    expect(arrow!.getAttribute("style")).toContain("var(--edge-arrow-ink)");
    // ...defined inside the edge, which is what lets the edge's variable reach it.
    expect(edge.contains(arrow)).toBe(true);
  });

  describe("in the stylesheet", () => {
    const rules = rulesOf(readStylesheet());
    const declared = (selector: string): Map<string, string> =>
      new Map(rules.filter((rule) => rule.selectors.includes(selector)).flatMap((rule) => declarationsOf(rule.body)));

    it("colours the line in the hue at the resting 2px, and the arrowheads with it", () => {
      const line = declared(".archer-edge.archer-emph .react-flow__edge-path");
      expect(line.get("stroke")).toBe("var(--emph-hue)");
      // The resting line's own weight (2px since the owner lightened the lines, 2026-11-15).
      expect(line.get("stroke-width")).toBe(declared(".archer-edge .react-flow__edge-path").get("stroke-width"));
      expect(declared(".archer-edge.archer-emph").get("--edge-arrow-ink")).toBe("var(--emph-hue)");
    });

    it("never dashes, widens or glows an emphasised line", () => {
      const emphRules = rules.filter((rule) =>
        rule.selectors.some((selector) => selector.includes("archer-emph") && selector.includes("edge")),
      );
      for (const rule of emphRules) {
        const body = new Map(declarationsOf(rule.body));
        expect(body.has("stroke-dasharray"), rule.selectors.join(", ")).toBe(false);
        expect(body.has("filter"), rule.selectors.join(", ")).toBe(false);
        // Never wider than the line it is: a thick line rests at 4px (owner, 2026-11-15).
        const thick = Number.parseFloat(
          declared(".archer-edge.archer-line-thick .react-flow__edge-path").get("stroke-width") ?? "0",
        );
        expect(thick).toBe(4);
        expect(Number.parseFloat(body.get("stroke-width") ?? "0"), rule.selectors.join(", ")).toBeLessThanOrEqual(
          thick,
        );
      }
    });

    it("has no band rule left to apply", () => {
      expect(rules.some((rule) => rule.selectors.some((selector) => selector.includes("archer-edge-emph-band")))).toBe(
        false,
      );
    });
  });
});

describe("a flow edge's moving arrows", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ];
  const clearOf = (at: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }) =>
    at.x + CHEVRON_REACH <= box.x ||
    at.x - CHEVRON_REACH >= box.x + box.width ||
    at.y + CHEVRON_REACH <= box.y ||
    at.y - CHEVRON_REACH >= box.y + box.height;

  it("sits still at a quarter and three quarters of the route, pointing along it", () => {
    expect(parkedAt(route, 0.25, undefined)).toMatchObject({ x: 50, y: 0, angle: 0 });
    expect(parkedAt(route, 0.75, undefined)).toMatchObject({ x: 150, y: 0, angle: 0 });
  });

  it("moves along the route, off the caption, when the caption is where it would sit", () => {
    const caption = { x: 40, y: -9, width: 30, height: 18 };
    const at = parkedAt(route, 0.25, caption);
    expect(at.y).toBe(0);
    expect(clearOf(at, caption), `parked at x=${at.x}`).toBe(true);
  });

  it("follows the route round a corner, and points the way the route runs there", () => {
    const bent = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(parkedAt(bent, 0.75, undefined)).toMatchObject({ x: 100, y: 50, angle: 90 });
  });

  it("takes longer on a longer hop at one pace, and longer at a slower pace", () => {
    const long = [
      { x: 0, y: 0 },
      { x: 800, y: 0 },
    ];
    expect(travelSeconds(long, "normal")).toBeGreaterThan(travelSeconds(route, "normal"));
    expect(travelSeconds(long, "slow")).toBeGreaterThan(travelSeconds(long, "fast"));
  });

  it("moves along a flow edge, and both ways along a two-way one", async () => {
    installReducedMotion(false);
    const edge = await drawn(emphasis({ style: "flow", edges: ["captioned"] }), "captioned");
    const chevrons = edge.querySelector(".archer-emph-chevrons");
    expect(chevrons, "a flow edge drew no moving arrows").not.toBeNull();
    const moving = [...chevrons!.querySelectorAll("animateMotion")];
    expect(moving.length).toBeGreaterThanOrEqual(2);
    expect(moving.every((motion) => motion.getAttribute("keyPoints") === null)).toBe(true);
    expect(moving[0]!.querySelector("mpath")?.getAttribute("href")).toBe("#captioned");
  });

  it("is drawn still, clear of the caption the layout placed, when motion is off", async () => {
    localStorage.setItem("archer.flow-animation", "off");
    const edge = await drawn(emphasis({ style: "flow", edges: ["captioned"] }), "captioned");
    const still = [...edge.querySelectorAll(".archer-emph-chevron")];
    expect(still).toHaveLength(2);
    expect(edge.querySelectorAll("animateMotion")).toHaveLength(0);
    const caption = layout.edges.find((entry) => entry.id === "captioned")!.labelAnchor!;
    for (const chevron of still) {
      const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(chevron.getAttribute("transform") ?? "")!.map(Number);
      expect(clearOf({ x: x!, y: y! }, caption), `chevron at ${x},${y}; caption ${JSON.stringify(caption)}`).toBe(true);
    }
  });

  it("draws none along a highlight edge", async () => {
    const edge = await drawn(emphasis({ style: "highlight", edges: ["captioned"] }), "captioned");
    expect(edge.querySelector(".archer-emph-chevrons")).toBeNull();
  });
});

describe("a two-way flow line", () => {
  const twoWay: ProjectedView = {
    ...view,
    edges: [{ id: "both", source: "a", target: "b", label: undefined, bidirectional: true }],
  };

  it("has arrowheads at both ends and moving arrows both ways", async () => {
    installReducedMotion(false);
    const laid = await computeLayout(twoWay);
    const value = emphasis({ style: "flow", edges: ["both"] });
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout: laid }} emphasis={value} />);
    await waitFor(() => expect(container.querySelector('.react-flow__edge[data-id="both"]')).not.toBeNull());
    const edge = container.querySelector('.react-flow__edge[data-id="both"]')!;
    expect(edge.querySelectorAll("marker")).toHaveLength(2);
    const motions = [...edge.querySelectorAll("animateMotion")];
    expect(motions.filter((motion) => motion.getAttribute("keyPoints") === "1;0").length).toBeGreaterThanOrEqual(2);
    expect(motions.filter((motion) => motion.getAttribute("keyPoints") === null).length).toBeGreaterThanOrEqual(2);
  });

  it("parks one arrow each way when motion is off", async () => {
    localStorage.setItem("archer.flow-animation", "off");
    const laid = await computeLayout(twoWay);
    const { container } = render(
      <DiagramCanvas
        state={{ status: "ready", layout: laid }}
        emphasis={emphasis({ style: "flow", edges: ["both"] })}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('.react-flow__edge[data-id="both"] .archer-emph-chevron')).not.toBeNull(),
    );
    const angles = [...container.querySelectorAll('.react-flow__edge[data-id="both"] .archer-emph-chevron')].map(
      (chevron) => Number(/rotate\(([-\d.]+)\)/.exec(chevron.getAttribute("transform") ?? "")![1]),
    );
    expect(angles).toHaveLength(2);
    expect(Math.abs(Math.abs(angles[0]! - angles[1]!) - 180)).toBeLessThan(1);
  });
});

describe("still arrows keep off a route's bends", () => {
  it("never parks on a corner the canvas rounds, and points along the leg it sits on", () => {
    const bent = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 80 },
      { x: 80, y: 80 },
    ];
    const at = parkedAt(bent, 0.25, undefined);
    expect(Math.hypot(at.x - 40, at.y - 0)).toBeGreaterThanOrEqual(12);
    expect([0, 90]).toContain(Math.round(at.angle));
  });
});
