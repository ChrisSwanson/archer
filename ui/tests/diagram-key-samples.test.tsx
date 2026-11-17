// @vitest-environment jsdom
/** Visual samples exercise DiagramKey, with shared glyphs compared to their production renderer. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DiagramKey, type KeyModel } from "../src/diagrams/DiagramKey";
import { ArchitectureGlyph, PersonGlyph } from "../src/diagrams/FigureGlyphs";
import { ARCHITECTURE_ICONS, C4_BOUNDARY_KINDS, type GroupFigure, type NodeFigure } from "../src/diagrams/figures";
import type { ProjectedView } from "../src/diagrams/projection";
afterEach(cleanup);
const base: ProjectedView = {
  viewId: "drawing",
  title: "Drawing",
  revision: "r",
  kind: "freeform",
  modelType: "freeform-graph",
  nodes: [],
  edges: [],
  groups: [],
};
const graph = (figure: NodeFigure): KeyModel => ({
  type: "graph",
  view: { ...base, nodes: [{ id: "n", label: "Node", shape: undefined, classes: [], groupId: undefined, figure }] },
});
const group = (figure: GroupFigure): KeyModel => ({
  type: "graph",
  view: { ...base, groups: [{ id: "g", label: "Group", parentId: undefined, figure }] },
});
const journey: KeyModel = {
  type: "journey",
  view: {
    ...base,
    actors: ["Reader"],
    sections: [{ id: "s", label: "Stage", tasks: [{ id: "t", label: "Read", score: 4, actors: ["Reader"] }] }],
  },
};
const sample = (label: string): SVGElement => screen.getByText(label).querySelector("svg")!;
it.each(ARCHITECTURE_ICONS)("reuses the production architecture %s glyph", (icon) => {
  render(<DiagramKey model={graph({ type: "service", icon })} />);
  const key = sample(icon[0].toUpperCase() + icon.slice(1) + " icon");
  const reference = render(<ArchitectureGlyph icon={icon} size={24} />).container.querySelector("svg")!;
  expect(key.innerHTML).toBe(reference.innerHTML);
  expect(key.getAttribute("aria-hidden")).toBe("true");
});
it("reuses the production C4 person glyph", () => {
  render(<DiagramKey model={graph({ type: "c4", kind: "person", external: false })} />);
  const key = sample("Person");
  const reference = render(<PersonGlyph size={24} />).container.querySelector("svg")!;
  expect(key.innerHTML).toBe(reference.innerHTML);
});
it.each([
  ["Composite state", group({ type: "composite" })],
  ["Architecture group", group({ type: "zone" })],
  ["Sections", journey],
] as const)("shows %s as a solid rounded frame", (label, model) => {
  render(<DiagramKey model={model} />);
  const frame = sample(label).querySelector("rect");
  expect(frame).not.toBeNull();
  expect(frame!.getAttribute("stroke-dasharray")).toBeNull();
  expect(Number(frame!.getAttribute("rx"))).toBeGreaterThan(2);
});
it.each(C4_BOUNDARY_KINDS)("keeps %s boundary visually distinct from grouping", (kind) => {
  render(<DiagramKey model={group({ type: "boundary", kind })} />);
  const frame = screen.getByRole("region", { name: "Diagram Key" }).querySelector("dt svg rect");
  expect(frame?.getAttribute("stroke-dasharray")).toBeTruthy();
});
it("shows a thick flowchart line rather than a node", () => {
  render(
    <DiagramKey
      model={{
        type: "graph",
        view: { ...base, edges: [{ id: "e", source: "a", target: "b", label: undefined, line: "thick" }] },
      }}
    />,
  );
  expect(sample("Thick line: meaning not stated").querySelector("rect")).toBeNull();
  expect(
    Number(sample("Thick line: meaning not stated").querySelector("path")?.getAttribute("stroke-width")),
  ).toBeGreaterThan(1.5);
});
it("shows a state note as a plain sheet with its dashed tie", () => {
  render(
    <DiagramKey model={graph({ type: "state", kind: "state", note: { text: "Annotation", position: "right-of" } })} />,
  );
  expect(sample("State note").querySelector("rect")).not.toBeNull();
  expect(sample("State note").querySelector("path")?.getAttribute("stroke-dasharray")).toBeTruthy();
});
it("keeps a sequence note folded, distinct from a state note", () => {
  render(
    <DiagramKey
      model={{
        type: "sequence",
        view: {
          ...base,
          participants: [{ id: "p", label: "P" }],
          events: [{ type: "note", id: "note", participants: ["p"], position: "over", text: "Annotation" }],
        },
      }}
    />,
  );
  expect(sample("Note").querySelector("rect")).toBeNull();
  expect(sample("Note").querySelector("path")?.getAttribute("stroke-dasharray")).toBeNull();
  expect(sample("Note").querySelector("path")?.getAttribute("d")).toContain("v6h6");
});
it("shows score rails as dashed, thin and thick, with a five-dot score", () => {
  render(<DiagramKey model={journey} />);
  const rails = sample("Score rail").querySelectorAll("path");
  expect(rails).toHaveLength(3);
  expect(rails[0].getAttribute("stroke-dasharray")).toBeTruthy();
  expect(Number(rails[2].getAttribute("stroke-width"))).toBeGreaterThan(Number(rails[1].getAttribute("stroke-width")));
  expect(sample("Satisfaction score").querySelectorAll("circle")).toHaveLength(5);
});
it("draws an authored line row by its pattern, whatever the meaning says", () => {
  render(
    <DiagramKey
      model={{
        type: "graph",
        view: {
          ...base,
          lineKey: [
            { pattern: "dashed", meaning: "Person to system" },
            { pattern: "dotted", meaning: "Database access" },
          ],
          edges: [
            { id: "e", source: "a", target: "b", label: undefined, line: "dashed" },
            { id: "f", source: "b", target: "a", label: undefined, line: "dotted" },
          ],
        },
      }}
    />,
  );
  expect(sample("Dashed line: Person to system").querySelector("path")?.getAttribute("stroke-dasharray")).toBe("6 4");
  expect(sample("Dotted line: Database access").querySelector("ellipse")).toBeNull();
  expect(sample("Dotted line: Database access").querySelector("path")?.getAttribute("stroke-dasharray")).toBe("2 3");
});
