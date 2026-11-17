// @vitest-environment jsdom
//
// A node's own connections stand out while the reader is on it (layout eval, 2026-11-15).
//
// Where many lines turn and cross in one place, a reader cannot tell which line leaves the box they are looking at.
// Highlighting a node's connections while it is hovered or selected is the best-supported aid for tracing paths
// through clutter (Ware & Bobrow 2004, 2005: without it, errors were high even on 32-node networks). So every edge
// with an end on the hovered or a selected node is marked attached: drawn in the accent above the other lines, at a
// weight between the resting line and a selected one, so an attached line never reads as selected. Nothing else
// fades -- fading is the agents' highlight (DESIGN.md "Highlights fade clearly").
//
// jsdom resolves no styles, so what is asserted is the class and stacking each edge is given, and the rules the
// stylesheet on disk holds for it; the look is checked in a real browser.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import { ATTACHED_EDGE_CLASS, toXFlowEdges } from "../src/diagrams/xflow-adapter";
import { viewOfSource } from "./route-metrics";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string | undefined =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2];

const SOURCE = ["flowchart LR", "  a[A] ab@--> b[B]", "  b bc@--> c[C]", "  c cd@--> d[D]"].join("\n");

describe("a node's own connections", () => {
  it("marks every edge with an end on an attached node, and raises it above the rest", async () => {
    const layout = await computeLayout(await viewOfSource(SOURCE, "attached"));
    const edges = toXFlowEdges(layout, undefined, undefined, undefined, undefined, undefined, new Set(["b"]));
    const byId = new Map(edges.map((e) => [e.id, e]));
    for (const id of ["ab", "bc"]) {
      expect(byId.get(id)!.className).toContain(ATTACHED_EDGE_CLASS);
      expect(byId.get(id)!.zIndex).toBeGreaterThan(byId.get("cd")!.zIndex ?? 0);
    }
    expect(byId.get("cd")!.className).not.toContain(ATTACHED_EDGE_CLASS);
  });

  it("marks nothing when no node is hovered or selected", async () => {
    const layout = await computeLayout(await viewOfSource(SOURCE, "attached"));
    for (const edge of toXFlowEdges(layout)) expect(edge.className).not.toContain(ATTACHED_EDGE_CLASS);
  });

  it("draws an attached line in the accent, heavier than resting and lighter than selected", () => {
    const attached = rule(`.archer-edge.${ATTACHED_EDGE_CLASS} .react-flow__edge-path`);
    const selected = rule(".archer-edge.selected .react-flow__edge-path");
    expect(attached).toMatch(/stroke:\s*var\(--accent\)/);
    const width = (body: string | undefined) => Number(body?.match(/stroke-width:\s*([\d.]+)/)?.[1]);
    expect(width(attached)).toBeGreaterThan(2);
    expect(width(attached)).toBeLessThan(width(selected));
  });

  it("brings an attached line back to full strength inside an agent's highlight", () => {
    expect(rule(`.archer-edge.archer-dimmed.${ATTACHED_EDGE_CLASS} .react-flow__edge-path`)).toMatch(/opacity:\s*1/);
  });
});
