// B. The diagram's type hierarchy (DESIGN.md: Typography and "Diagram palette: Node text"; owner, 2026-11-11),
// after the reference: a node's title a step larger than its description and bold over regular, a small gap
// between them and a comfortable description line; group captions bold in caption ink at their own size;
// connection labels light, dim and italic. Archer measures canvas text outside the browser, so each size is a
// named canvas token equal to the layout's constant, and the export draws the same.
import { describe, expect, it } from "vitest";
import { paintGraph, paintNode } from "../src/export/svg";
import type { LayoutNode, LayoutResult } from "../src/layout/elk-layout";
import { FRAME_CAPTION_FONT_PX } from "../src/layout/captions";
import {
  NODE_DESCRIPTION_FONT_PX,
  NODE_DESCRIPTION_GAP_PX,
  NODE_DESCRIPTION_LINE_PX,
  NODE_TITLE_FONT_PX,
  NODE_TITLE_LINE_PX,
  nodeBox,
} from "../src/layout/graph-metrics";
import { estimateTextWidth } from "../src/layout/text-measure";
import { declarationsOf, readStylesheet, rulesOf, tokensOf } from "./stylesheet";

const CSS = readStylesheet();
const declared = (selector: string): Map<string, string> =>
  new Map(
    rulesOf(CSS)
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => declarationsOf(rule.body)),
  );

const node = (over: Partial<LayoutNode> & { id: string }): LayoutNode => ({
  label: over.id,
  x: 0,
  y: 0,
  width: 180,
  height: 60,
  shape: "rectangle",
  classes: [],
  groupId: undefined,
  ...over,
});
const layout = (over: Partial<LayoutResult> = {}): LayoutResult => ({
  nodes: [],
  edges: [],
  groups: [],
  width: 800,
  height: 600,
  ...over,
});

describe("node text: a title over a description", () => {
  it("names its sizes as canvas tokens equal to the layout's constants", () => {
    expect(NODE_TITLE_FONT_PX).toBe(18);
    expect(NODE_DESCRIPTION_FONT_PX).toBe(15);
    const root = tokensOf(CSS, ":root");
    expect(root.get("--type-canvas-node-title")).toBe(`${NODE_TITLE_FONT_PX}px`);
    expect(root.get("--type-canvas-node-description")).toBe(`${NODE_DESCRIPTION_FONT_PX}px`);
  });

  it("draws the title at its size and line, 700, and the description at 400 with a comfortable line and a gap", () => {
    const title = declared(".archer-node-title-row");
    expect(title.get("font-size")).toBe("var(--type-canvas-node-title)");
    expect(title.get("line-height")).toBe(`${NODE_TITLE_LINE_PX}px`);
    expect(title.get("font-weight")).toBe("700");
    const description = declared(".archer-node-description-row");
    expect(description.get("font-size")).toBe("var(--type-canvas-node-description)");
    expect(description.get("line-height")).toBe(`${NODE_DESCRIPTION_LINE_PX}px`);
    expect(NODE_DESCRIPTION_LINE_PX / NODE_DESCRIPTION_FONT_PX).toBeGreaterThanOrEqual(1.5);
    expect(description.get("font-weight")).toBe("400");
    expect(declared(".archer-node-title-row + .archer-node-description-row").get("margin-top")).toBe(
      `${NODE_DESCRIPTION_GAP_PX}px`,
    );
    expect(NODE_DESCRIPTION_GAP_PX).toBeGreaterThan(0);
  });

  it("measures the box for exactly that: no row overflows, and the height holds every row and the gap", () => {
    const label =
      "Farm Model Server for Build and Review Work\nQwen3.8 27B with a 262K context, for build and review work, kept free so the chat answers while a build runs";
    const box = nodeBox(label, "rectangle", []);
    const title = box.lines.slice(0, box.titleRows);
    const description = box.lines.slice(box.titleRows);
    expect(title.length).toBeGreaterThan(1);
    expect(description.length).toBeGreaterThan(1);
    for (const row of title)
      expect(estimateTextWidth(row, NODE_TITLE_FONT_PX, true), row).toBeLessThanOrEqual(box.width - 48);
    for (const row of description)
      expect(estimateTextWidth(row, NODE_DESCRIPTION_FONT_PX, false), row).toBeLessThanOrEqual(box.width - 48);
    expect(box.textHeight).toBe(
      title.length * NODE_TITLE_LINE_PX + NODE_DESCRIPTION_GAP_PX + description.length * NODE_DESCRIPTION_LINE_PX,
    );
    expect(box.height).toBeGreaterThanOrEqual(box.textHeight + 32);
  });

  it("exports the same sizes and weights", () => {
    const label = "Farm Core\nThe board and the chat";
    const box = nodeBox(label, "rectangle", []);
    const svg = paintNode(node({ id: "core", label, width: box.width, height: box.height }), layout());
    expect(svg).toMatch(new RegExp(`font-size="${NODE_TITLE_FONT_PX}" font-weight="700"><tspan[^>]*>Farm Core<`));
    expect(svg).toMatch(new RegExp(`font-size="${NODE_DESCRIPTION_FONT_PX}" font-weight="400"><tspan[^>]*>The board`));
  });
});

describe("secondary lines", () => {
  // A C4 card's type line and a relationship's technology line are one secondary style (edge-detail-inline.e2e):
  // set smaller, in the full ink of what they sit on, never faded by opacity -- faded dim ink fell under 4.5:1
  // (axe, 2026-11-11), and a faded family ink would read grey.
  it("sets a C4 type line and a connection's technology alike, without an opacity fade", () => {
    const type = declared(".archer-c4-type");
    const technology = declared(".archer-edge-label-technology");
    expect(type.has("opacity")).toBe(false);
    expect(technology.has("opacity")).toBe(false);
    expect(type.get("font-weight")).toBe(technology.get("font-weight"));
  });
});

describe("group captions and connection labels", () => {
  it("draws a group caption bold, in caption ink, at its own size, smaller than a node title", () => {
    const caption = declared(".archer-frame-caption");
    expect(caption.get("font-size")).toBe("var(--type-canvas-frame)");
    expect(caption.get("font-weight")).toBe("700");
    expect(caption.get("color")).toBe("var(--group-caption)");
    expect(FRAME_CAPTION_FONT_PX).toBeLessThan(NODE_TITLE_FONT_PX);
  });

  it("draws a connection's label light: regular, italic, in the dim ink", () => {
    const label = declared(".archer-edge-label");
    expect(label.get("font-weight")).toBe("400");
    expect(label.get("font-style")).toBe("italic");
    // The dim ink, unless the label sits on a family panel, where it takes the family's (treatment A).
    expect(label.get("color")).toBe("var(--edge-label-ink)");
  });

  it("exports the label the same way", () => {
    const a = node({ id: "a" });
    const b = node({ id: "b", y: 200 });
    const svg = paintGraph(
      layout({
        nodes: [a, b],
        edges: [
          {
            id: "e",
            source: "a",
            target: "b",
            label: "starts one per task",
            points: [
              { x: 90, y: 60 },
              { x: 90, y: 200 },
            ],
            labelAnchor: { x: 40, y: 110, width: 100, height: 20 },
          },
        ],
      }),
    ).content;
    expect(svg).toMatch(/<g fill="var\(--text-dim\)" stroke="none" font-style="italic"><text[^>]*font-weight="400"/);
  });
});
