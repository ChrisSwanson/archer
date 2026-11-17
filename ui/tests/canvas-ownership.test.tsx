// @vitest-environment jsdom
//
// Who owns the canvas appearance?
//
// `src/styles.css` used to key every hover and selected rule off React Flow's
// own node-type class (`.react-flow__node-default`). React Flow derives that
// class from `node.type`, so the moment a node is given any other type -- an
// emphasis node, a shaped node, anything -- it silently loses BOTH its hover
// affordance and its selected treatment, with the whole suite still green.
//
// These tests pin the ownership rather than the colours: the rules must hang
// off an Archer-owned class that our own adapter applies, so they survive a
// change of node type. Asserting on *which selectors match* (instead of on
// computed colour) also survives tokenising the palette, which jsdom cannot
// resolve -- see `canvas-theme.test.tsx` for the colour contract.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "ownership-view",
  kind: "c4-context",
  title: "Ownership",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [],
};

let layout: LayoutResult;
let archerSheet: CSSStyleSheet;

beforeAll(async () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  expect(css.length).toBeGreaterThan(0);
  const element = document.createElement("style");
  element.textContent = css;
  document.head.append(element);
  archerSheet = element.sheet!;
  layout = await computeLayout(view);
});

afterEach(cleanup);

function renderCanvas(): HTMLElement {
  return render(<DiagramCanvas state={{ status: "ready", layout }} />).container;
}

/**
 * Selectors in Archer's stylesheet that would style `element`.
 *
 * `:hover` is dropped from the probe because jsdom has no pointer, so a hover
 * rule can only be checked structurally: does the rest of the selector match
 * this element?
 */
function matchingSelectors(element: Element): string[] {
  const matched: string[] = [];
  for (const rule of Array.from(archerSheet.cssRules)) {
    if (rule.type !== CSSRule.STYLE_RULE) continue;
    const styleRule = rule as CSSStyleRule;
    for (const part of styleRule.selectorText.split(",")) {
      const probe = part.trim().replace(/:hover/g, "");
      if (probe.length === 0) continue;
      try {
        if (element.matches(probe)) {
          matched.push(styleRule.selectorText);
          break;
        }
      } catch {
        // A selector jsdom cannot parse styles nothing here.
      }
    }
  }
  return matched;
}

function declaresAny(selectors: readonly string[], properties: readonly string[]): boolean {
  return Array.from(archerSheet.cssRules).some((rule) => {
    if (rule.type !== CSSRule.STYLE_RULE) return false;
    const styleRule = rule as CSSStyleRule;
    if (!selectors.includes(styleRule.selectorText)) return false;
    return properties.some((property) => styleRule.style.getPropertyValue(property) !== "");
  });
}

describe("canvas styling is Archer-owned", () => {
  it("marks every diagram node with an Archer-owned class", () => {
    const container = renderCanvas();
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    expect(node).not.toBeNull();
    expect(node!.classList.contains("archer-node")).toBe(true);
  });

  it("keeps hover and selected styling when the node type changes", () => {
    const container = renderCanvas();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    expect(node).not.toBeNull();

    // Stand in for a future custom node type: React Flow names this class from
    // `node.type`, so anything other than "default" lands here.
    node!.classList.remove("react-flow__node-default");
    node!.classList.add("react-flow__node-emphasis");

    const base = matchingSelectors(node!);
    expect(declaresAny(base, ["background", "background-color", "border", "border-color"])).toBe(true);

    node!.classList.add("selected");
    const selected = matchingSelectors(node!).filter((s) => s.includes(".selected"));
    expect(declaresAny(selected, ["background", "background-color", "border", "border-color"])).toBe(true);

    node!.classList.remove("selected");
    const hover = matchingSelectors(node!).filter((s) => s.includes(":hover"));
    expect(declaresAny(hover, ["border-color", "box-shadow"])).toBe(true);
  });

  it("marks every diagram edge with an Archer-owned class", async () => {
    const container = renderCanvas();
    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge[data-id="e1"]')).not.toBeNull();
    });

    const edge = container.querySelector<Element>('.react-flow__edge[data-id="e1"]');
    expect(edge!.classList.contains("archer-edge")).toBe(true);
  });
});
