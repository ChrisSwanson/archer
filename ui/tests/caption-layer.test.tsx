// @vitest-environment jsdom
//
// An edge caption is never struck through by a route.
//
// React Flow gives every edge an `<svg>` of its own and a z-index, and LIFTS
// the ones that touch a selected node: `elevateNodesOnSelect` raises the node
// by 1000, and an edge takes the higher of its two ends. The caption layer is
// one sibling element with one z-index, and it was held at 4 -- above an edge
// lifted by a group (1, 2, ...), far below one lifted by a selection. So
// selecting a node drew its routes straight over any caption they crossed.
//
// Seen first in the retired Line map design, where a 5px route through a
// caption struck it out; a hairline through the caption is the same defect.
//
// The z-indexes are React Flow's, read off the canvas it really renders; the
// caption layer's is ours, read from the stylesheet on disk (jsdom applies
// neither stylesheet, so nothing here could be read back as a computed style).
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { containersView } from "./graph-samples";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

const CAPTION_LAYER = ".react-flow__edgelabel-renderer";

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(containersView());
});

afterEach(cleanup);

/** The z-index React Flow gave each edge's own layer. */
async function edgeLayers(selectedNodeIds: readonly string[]): Promise<number[]> {
  const { container } = render(
    <DiagramCanvas state={{ status: "ready", layout }} selection={{ nodeIds: selectedNodeIds }} />,
  );
  // One `<svg>` per edge; the arrowhead definitions are a further one with no
  // edge in it.
  const layers = (): SVGSVGElement[] =>
    [...container.querySelectorAll<SVGSVGElement>(".react-flow__edges > svg")].filter(
      (layer) => layer.querySelector(".react-flow__edge") !== null,
    );
  await waitFor(() => {
    expect(layers().length).toBe(layout.edges.length);
  });
  return layers().map((layer) => Number(layer.style.zIndex || 0));
}

const rules = rulesOf(readStylesheet());

/** Every z-index the stylesheet gives the caption layer. */
function captionLayerRules(): { readonly zIndex: number }[] {
  return rules
    .filter((rule) => rule.selectors.some((selector) => selector.endsWith(CAPTION_LAYER)))
    .flatMap((rule) =>
      declarationsOf(rule.body)
        .filter(([property]) => property === "z-index")
        .map(([, value]) => ({ zIndex: Number(value) })),
    );
}

describe("the caption layer sits above every route", () => {
  it("has a selected node to test against: React Flow lifts the routes that touch it", async () => {
    // The premise. If this stops holding the two tests below prove nothing.
    const resting = Math.max(...(await edgeLayers([])));
    cleanup();
    const lifted = Math.max(...(await edgeLayers(["orders"])));
    expect(lifted).toBeGreaterThan(resting);
  });

  it("stays above the routes touching a selected node", async () => {
    const lifted = Math.max(...(await edgeLayers(["orders"])));
    const stated = captionLayerRules();

    expect(stated.length, `a z-index for ${CAPTION_LAYER}`).toBeGreaterThan(0);
    for (const rule of stated) {
      expect(rule.zIndex, "caption layer against a lifted route").toBeGreaterThan(lifted);
    }
  });

  it("stays above them when every node is selected at once", async () => {
    const everything = layout.nodes.map((node) => node.id);
    const lifted = Math.max(...(await edgeLayers(everything)));
    for (const rule of captionLayerRules()) {
      expect(rule.zIndex).toBeGreaterThan(lifted);
    }
  });

  it("is one rule", () => {
    expect(captionLayerRules()).toHaveLength(1);
  });
});
