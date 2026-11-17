// @vitest-environment jsdom
//
// Inputs the schema allows that the per-type tests do not reach: found by
// review of the four new graph-like types.
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeLayout } from "../src/layout/elk-adapter";
import { layoutBounds } from "../src/diagrams/viewport-fit";
import { drawGraph, nodeElement, projectGraph } from "./support/draw-envelope";

afterEach(cleanup);

const REVISION = `sha256:${"d".repeat(64)}`;
const envelope = (kind: string, model: Record<string, unknown>) => ({
  schemaVersion: 2,
  view: { id: "edge-cases", kind, title: "Edge cases" },
  revision: REVISION,
  model,
});

describe("C4", () => {
  it("draws a null shape as no shape", async () => {
    const { container } = await drawGraph(
      envelope("c4", {
        type: "c4-model",
        level: "container",
        elements: [{ id: "api", kind: "container", label: "API", shape: null, technology: "Go" }],
        boundaries: [],
        relationships: [],
      }),
    );
    const api = nodeElement(container, "api");
    expect(api.querySelector(".archer-c4-type")?.textContent).toBe("[Container: Go]");
    expect(api.className).not.toContain("null");
    expect(api.getAttribute("aria-label")).toBe("API, container, Go");
  });

  it("gives a boundary with nothing in it a frame that can be seen", async () => {
    const view = projectGraph(
      envelope("c4", {
        type: "c4-model",
        level: "context",
        elements: [{ id: "a", kind: "system", label: "A" }],
        boundaries: [{ id: "empty", kind: "system", label: "Empty" }],
        relationships: [],
      }),
    );
    const layout = await computeLayout(view);
    const frame = layout.groups.find((group) => group.id === "empty")!;
    expect(frame.width).toBeGreaterThanOrEqual(80);
    expect(frame.height).toBeGreaterThanOrEqual(40);
  });
});

describe("state notes", () => {
  const states = (extra: Record<string, unknown>[]) =>
    envelope("state", {
      type: "state-machine",
      direction: "tb",
      states: [{ id: "s", label: "S" }, ...extra],
      transitions: [],
    });

  it("speaks a pseudo-state's note, since the drawn sheet is hidden from screen readers", async () => {
    const { container } = await drawGraph(
      states([{ id: "c", label: "c", kind: "choice", note: { position: "right-of", text: "pick one" } }]),
    );
    expect(nodeElement(container, "c").getAttribute("aria-label")).toBe("c, choice, note: pick one");
  });

  it("speaks a composite state's note", async () => {
    const { container } = await drawGraph(
      states([
        { id: "outer", label: "Outer", note: { position: "left-of", text: "the busy part" } },
        { id: "inner", label: "Inner", parentId: "outer" },
      ]),
    );
    expect(nodeElement(container, "outer").getAttribute("aria-label")).toBe(
      "Outer, composite state, note: the busy part",
    );
  });

  it("counts a note in the bounds a fit frames", async () => {
    const layout = await computeLayout(
      projectGraph(states([{ id: "n", label: "N", note: { position: "left-of", text: "a long note on the left" } }])),
    );
    const noted = layout.nodes.find((node) => node.id === "n")!;
    expect(layoutBounds(layout)!.x).toBeLessThanOrEqual(noted.note!.x);
  });

  it("lays out a transition from a state to the composite it is in", async () => {
    const layout = await computeLayout(
      projectGraph(
        envelope("state", {
          type: "state-machine",
          states: [
            { id: "c", label: "C" },
            { id: "a", label: "A", parentId: "c" },
          ],
          transitions: [{ id: "a--c", source: "a", target: "c" }],
        }),
      ),
    );
    expect(layout.edges.find((edge) => edge.id === "a--c")).toBeDefined();
  });
});

describe("validation", () => {
  it("refuses an edge that ends on another edge's id", () => {
    const projection = projectEnvelope(
      envelope("entity-relationship", {
        type: "entity-relationship",
        entities: [
          { id: "A", label: "A", attributes: [] },
          { id: "B", label: "B", attributes: [] },
        ],
        relationships: [
          {
            id: "A--B",
            source: "A",
            target: "B",
            sourceCardinality: "exactly-one",
            targetCardinality: "exactly-one",
            identifying: true,
          },
          {
            id: "A--X",
            source: "A",
            target: "A--B",
            sourceCardinality: "exactly-one",
            targetCardinality: "exactly-one",
            identifying: true,
          },
        ],
      }),
    );
    expect(projection.ok).toBe(false);
  });
});
