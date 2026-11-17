/**
 * Draws an envelope down the production path -- validate, project, lay out,
 * draw -- and hands back what was drawn. For the per-type drawing tests.
 */
import { render, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { DiagramCanvas, type CanvasState } from "../../src/diagrams/DiagramCanvas";
import { projectEnvelope, type ProjectionResult } from "../../src/diagrams/projection";
import { computeLayout, type LayoutResult } from "../../src/layout/elk-adapter";
import type { Emphasis } from "../../src/emphasis/contract";
import type { CommentedElements } from "../../src/diagrams/xflow-adapter";

export type GraphProjection = Extract<ProjectionResult, { ok: true; type: "graph" }>;

/** The graph view an envelope projects to; fails the test when it does not. */
export function projectGraph(envelope: unknown): GraphProjection["view"] {
  const projection = projectEnvelope(envelope);
  if (!projection.ok) {
    throw new Error(`the envelope was refused: ${projection.errors.map((e) => e.message).join("; ")}`);
  }
  if (projection.type !== "graph") throw new Error(`the envelope projected to ${projection.type}, not a graph`);
  return projection.view;
}

export type Drawn = {
  readonly container: HTMLElement;
  readonly layout: LayoutResult;
  readonly rerender: (options?: DrawOptions) => void;
};

export type DrawOptions = {
  readonly emphasis?: Emphasis | null;
  readonly selection?: { readonly nodeIds?: readonly string[]; readonly edgeIds?: readonly string[] };
  readonly commented?: CommentedElements;
  readonly onNodeClick?: (id: string, additive: boolean) => void;
  readonly onEdgeClick?: (id: string, additive: boolean) => void;
};

/** Projects, lays out and draws a graph envelope, waiting until every edge is mounted. */
export async function drawGraph(envelope: unknown, options: DrawOptions = {}): Promise<Drawn> {
  const view = projectGraph(envelope);
  const layout = await computeLayout(view);
  const state: CanvasState = { status: "ready", layout };
  const element = (next: DrawOptions) => (
    <div style={{ width: 1200, height: 800 }}>
      <DiagramCanvas
        state={state}
        emphasis={next.emphasis}
        selection={next.selection}
        commented={next.commented}
        onNodeClick={next.onNodeClick}
        onEdgeClick={next.onEdgeClick}
      />
    </div>
  );
  const { container, rerender } = render(element(options));
  // React Flow draws an edge once both its ends have mounted and been measured.
  await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(view.edges.length));
  return { container, layout, rerender: (next = options) => rerender(element(next)) };
}

/** The React Flow element of the node (or element group) with this model id. */
export function nodeElement(container: HTMLElement, id: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".react-flow__node")].find((el) => el.dataset.id === id);
  expect(found, `no node is drawn for ${id}`).toBeDefined();
  return found!;
}

/** The React Flow element of the edge with this model id. */
export function edgeElement(container: HTMLElement, id: string): SVGElement {
  const found = [...container.querySelectorAll<SVGElement>(".react-flow__edge")].find((el) => el.dataset.id === id);
  expect(found, `no edge is drawn for ${id}`).toBeDefined();
  return found!;
}
