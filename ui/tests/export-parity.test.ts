// The export draws what the page draws (review D, "Implementation inconsistencies"; redesign slice 8): a notation's
// line weight, each line pattern, and a kind's caption in the same size, weight and case.
import { describe, expect, it } from "vitest";
import { paintSequence } from "../src/export/sequence";
import { paintGraph, paintNode } from "../src/export/svg";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { loadValidFixture } from "./fixtures";
import type { LayoutEdge, LayoutNode, LayoutResult } from "../src/layout/elk-layout";
import { NODE_KIND_FONT_PX } from "../src/layout/graph-metrics";
import { declarationsOf, readStylesheet, rulesOf, throughTokens } from "./stylesheet";

const CSS = readStylesheet();
const declared = (selector: string): Map<string, string> =>
  new Map(
    rulesOf(CSS)
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => declarationsOf(rule.body)),
  );

const node = (id: string, y: number, classes: string[] = []): LayoutNode => ({
  id,
  label: id,
  x: 0,
  y,
  width: 180,
  height: 60,
  shape: "rectangle",
  classes,
  groupId: undefined,
});
const edge = (line?: LayoutEdge["line"]): LayoutEdge => ({
  id: "e",
  source: "a",
  target: "b",
  label: undefined,
  ...(line === undefined ? {} : { line }),
  points: [
    { x: 90, y: 60 },
    { x: 90, y: 200 },
  ],
  labelAnchor: undefined,
});
const drawing = (over: Partial<LayoutResult>): LayoutResult => ({
  nodes: [node("a", 0), node("b", 200)],
  edges: [edge()],
  groups: [],
  width: 400,
  height: 300,
  ...over,
});
const strokeOf = (layout: LayoutResult): { width: string; dash: string | undefined } => {
  const path = /<path class="export-edge-line"[^>]*>/.exec(paintGraph(layout).content)![0];
  return {
    width: /stroke-width="([^"]+)"/.exec(path)![1]!,
    dash: /stroke-dasharray="([^"]+)"/.exec(path)?.[1],
  };
};

describe("a line in the export", () => {
  it.each([
    [undefined, "2", "4"],
    ["state", "1.5", "3.5"],
    ["er", "1.25", "3"],
  ] as const)("weighs what the page draws for the %s notation, thick too", (notation, rest, thick) => {
    const selector =
      notation === undefined
        ? ".archer-edge .react-flow__edge-path"
        : `[data-notation="${notation}"] .archer-edge .react-flow__edge-path`;
    expect(declared(selector).get("stroke-width")).toBe(rest);
    const over = notation === undefined ? {} : { notation };
    expect(strokeOf(drawing(over)).width).toBe(rest);
    expect(strokeOf(drawing({ ...over, edges: [edge("thick")] })).width).toBe(thick);
  });

  it.each(["dotted", "dashed", "dashdot"] as const)("draws a %s line in the page's own pattern", (line) => {
    const page = declared(`.archer-edge.archer-line-${line} .react-flow__edge-path`).get("stroke-dasharray");
    expect(strokeOf(drawing({ edges: [edge(line)] })).dash).toBe(page);
  });
});

describe("a box's border in the export", () => {
  // The page's `--line-node` (1.5px) and a C4 system's `--line-node-strong` (2px; owner, 2026-11-15).
  const token = (name: string) => Number.parseFloat(throughTokens(CSS, `var(${name})`));
  const borderOf = (svg: string) => Number(/stroke-width="([^"]+)"/.exec(svg)![1]);

  it("is the page's node line", () => {
    expect(declared(".archer-node").get("border")).toMatch(/^var\(--line-node\) /);
    expect(borderOf(paintNode(node("a", 0), drawing({})))).toBe(token("--line-node"));
  });

  it("is the page's strong node line for a C4 system", () => {
    expect(declared(".archer-node.archer-c4-system").get("border-width")).toBe("var(--line-node-strong)");
    const system: LayoutNode = { ...node("s", 0), figure: { type: "c4", kind: "system", external: false } as never };
    expect(borderOf(paintNode(system, drawing({})))).toBe(token("--line-node-strong"));
  });
});

describe("a sequence message in the export", () => {
  it("weighs what the page draws", () => {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("minimal-sequence.json is not a sequence");
    const { content } = paintSequence(computeSequenceLayout(projection.view));
    const line = /<path class="export-edge-line"[^>]*>/.exec(content)![0];
    expect(/stroke-width="([^"]+)"/.exec(line)![1]).toBe(
      declared(".archer-seq-message-stroke line").get("stroke-width"),
    );
  });
});

describe("a kind's caption in the export", () => {
  it("is set as the page sets it: capitalised, at the layout's size, in the page's weight", () => {
    const kind = declared(".archer-node-kind");
    expect(throughTokens(CSS, kind.get("font-size")!)).toBe(`${NODE_KIND_FONT_PX}px`);
    const svg = paintNode(node("db", 0, ["database"]), drawing({}));
    expect(svg).toMatch(
      new RegExp(`font-size="${NODE_KIND_FONT_PX}" font-weight="${kind.get("font-weight")}"><tspan[^>]*>Database<`),
    );
  });
});
