// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramKey, diagramKeyEntries, keyOfDrawing, type KeyModel } from "../src/diagrams/DiagramKey";
import { nestView } from "../src/nesting/nest-view";
import {
  ARCHITECTURE_ICONS,
  ATTRIBUTE_KEYS,
  CARDINALITIES,
  C4_BOUNDARY_KINDS,
  C4_ELEMENT_KINDS,
  C4_ELEMENT_SHAPES,
  STATE_KINDS,
  type NodeFigure,
  type GroupFigure,
} from "../src/diagrams/figures";
import { EDGE_LINES, GRAPH_DIRECTIONS, NODE_KINDS, NODE_SHAPES } from "../src/layout/graph-metrics";
import type { ProjectedSequenceEvent, ProjectedView } from "../src/diagrams/projection";

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
  view: { ...base, nodes: [{ id: "n", label: "A", shape: undefined, classes: [], groupId: undefined, figure }] },
});
const grouped = (figure: GroupFigure): KeyModel => ({
  type: "graph",
  view: { ...base, groups: [{ id: "g", label: "G", parentId: undefined, figure }] },
});
const labels = (m: KeyModel): string[] => diagramKeyEntries(m).map((e) => e.label);
const meanings = (m: KeyModel): string =>
  diagramKeyEntries(m)
    .map((e) => e.meaning)
    .join(" ");
const sequence = (events: readonly ProjectedSequenceEvent[]): KeyModel => ({
  type: "sequence",
  view: { ...base, participants: [{ id: "a", label: "A" }], events },
});

describe("what the drawing says plainly is not keyed (owner, 2026-11-12)", () => {
  it("has no row for a plain flowchart group: its frame and caption say what it is", () => {
    const plain: KeyModel = {
      type: "graph",
      view: {
        ...base,
        groups: [
          { id: "g", label: "Agent Farm", parentId: undefined },
          { id: "h", label: "GPU 1", parentId: "g" },
        ],
      },
    };
    expect(labels(plain)).toEqual([]);
    // The Key itself stays, with no "Group" row (lead's decision, 2026-11-12: the side panel and the Key keep
    // their place on a drawing with groups; only the redundant row went).
    render(<DiagramKey model={plain} />);
    const key = screen.getByRole("region", { name: "Diagram Key" });
    expect(within(key).queryByText("Group", { exact: true })).toBeNull();
  });

  it("keeps notation a frame alone does not say: boundaries, composite states, architecture groups", () => {
    expect(labels(grouped({ type: "boundary", kind: "system" }))).toEqual(["System boundary"]);
    expect(labels(grouped({ type: "composite" }))).toEqual(["Composite state"]);
    expect(labels(grouped({ type: "zone" }))).toEqual(["Architecture group"]);
  });
});

describe("notation actually present", () => {
  it.each(STATE_KINDS)("explains state kind %s", (kind) => {
    expect(meanings(graph({ type: "state", kind }))).toMatch(/state|transition|paths/);
    expect(diagramKeyEntries(graph({ type: "state", kind }))).toHaveLength(1);
  });
  it.each(CARDINALITIES)("explains ER end %s", (cardinality) => {
    const entries = diagramKeyEntries({
      type: "graph",
      view: {
        ...base,
        edges: [
          {
            id: "e",
            source: "a",
            target: "b",
            label: undefined,
            figure: { type: "cardinality", source: cardinality, target: cardinality },
          },
        ],
      },
    });
    expect(entries[0]?.meaning).toContain(cardinality.replaceAll("-", " "));
    expect(entries[1]?.meaning).toContain("not direction");
  });
  it.each(ATTRIBUTE_KEYS)("explains %s only when an entity has it", (key) => {
    expect(
      labels(graph({ type: "entity", attributes: [{ name: "id", type: "int", keys: [key], comment: undefined }] })),
    ).toContain(key);
  });
  it.each(C4_ELEMENT_KINDS)("explains C4 %s", (kind) => {
    expect(labels(graph({ type: "c4", kind, external: false }))).toEqual([kind[0].toUpperCase() + kind.slice(1)]);
  });
  it.each(C4_BOUNDARY_KINDS)("explains C4 boundary %s", (kind) => {
    expect(meanings(grouped({ type: "boundary", kind }))).toContain("nested frames show containment");
  });
  it.each(ARCHITECTURE_ICONS)("explains architecture icon %s", (icon) => {
    expect(labels(graph({ type: "service", icon }))).toEqual([icon[0].toUpperCase() + icon.slice(1) + " icon"]);
    expect(meanings(grouped({ type: "zone", icon }))).toContain("not status");
  });
  it.each(NODE_SHAPES)("gives a plain shape %s no row: an outline alone carries no meaning", (shape) => {
    const model: KeyModel = {
      type: "graph",
      view: { ...base, nodes: [{ id: "n", label: "A", shape, classes: [], groupId: undefined }] },
    };
    expect(diagramKeyEntries(model)).toEqual([]);
  });
  it.each(GRAPH_DIRECTIONS)("gives the layout direction %s no row", (direction) => {
    expect(diagramKeyEntries({ type: "graph", view: { ...base, direction } })).toEqual([]);
  });
  it("shows no key at all for a flowchart of plain shapes and arrows", () => {
    const model: KeyModel = {
      type: "graph",
      view: {
        ...base,
        direction: "lr",
        nodes: [
          { id: "a", label: "A", shape: "rectangle", classes: [], groupId: undefined },
          { id: "b", label: "B", shape: "diamond", classes: [], groupId: undefined },
        ],
        edges: [{ id: "e", source: "a", target: "b", label: undefined, line: "solid" }],
      },
    };
    render(<DiagramKey model={model} />);
    expect(screen.queryByRole("region", { name: "Diagram Key" })).toBeNull();
  });
  it("distinguishes composite state, queue, database and external outlines", () => {
    expect(meanings(grouped({ type: "composite" }))).toContain("inner state machine");
    for (const shape of C4_ELEMENT_SHAPES) {
      expect(labels(graph({ type: "c4", kind: "container", external: true, shape }))).toContain(
        shape === "queue" ? "Queue" : "Database",
      );
      expect(labels(graph({ type: "c4", kind: "container", external: true, shape }))).toContain("External");
    }
    expect(labels(graph({ type: "c4", kind: "container", external: false }))).not.toContain("Queue");
  });
  it.each(["sync", "reply", "async"] as const)("explains sequence %s", (kind) => {
    expect(meanings(sequence([{ type: "message", id: "m", from: "a", to: "a", label: "M", kind }]))).toContain(
      "receiver",
    );
  });
  it.each(["alt", "opt", "loop", "par"] as const)("finds %s and messages inside a fragment", (kind) => {
    const entries = labels(
      sequence([
        {
          type: "fragment",
          id: "f",
          kind,
          label: "Condition",
          sections: [
            { label: "C", events: [{ type: "message", id: "m", from: "a", to: "a", label: "M", kind: "async" }] },
          ],
        },
      ]),
    );
    expect(entries).toContain(kind);
    expect(entries).toContain("Async message");
  });
  it("explains activation, deactivation, notes and actor lifelines", () => {
    const model = sequence([
      { type: "activate", participant: "a" },
      { type: "deactivate", participant: "a" },
      { type: "note", id: "n", position: "over", participants: ["a"], text: "N" },
    ]);
    expect(labels(model)).toEqual(["Lifelines", "Activation", "Note"]);
  });
  it.each(NODE_KINDS)("names declared flowchart kind %s", (kind) => {
    const model: KeyModel = {
      type: "graph",
      view: { ...base, nodes: [{ id: "n", label: "A", shape: undefined, classes: [kind], groupId: undefined }] },
    };
    expect(labels(model)).toContain(kind[0].toUpperCase() + kind.slice(1));
  });
  it.each(EDGE_LINES)("names flowchart line %s with no meaning Archer made up, and no arrowhead row", (line) => {
    const model: KeyModel = {
      type: "graph",
      view: { ...base, edges: [{ id: "e", source: "a", target: "b", label: undefined, line }] },
    };
    expect(labels(model)).not.toContain("Arrowheads");
    if (line !== "solid") expect(labels(model).find((label) => label.endsWith(": meaning not stated"))).toBeDefined();
    else expect(labels(model)).toEqual([]);
  });
  it("shows the author's meaning for a pattern, first, and leaves it to the legend while one is up", () => {
    const model: KeyModel = {
      type: "graph",
      view: {
        ...base,
        lineKey: [{ pattern: "dashed", meaning: "Person to system" }],
        edges: [{ id: "e", source: "a", target: "b", label: undefined, line: "dashed" }],
      },
    };
    expect(labels(model)).toContain("Dashed line: Person to system");
    expect(diagramKeyEntries(model, { omitLinePatterns: true }).map((entry) => entry.label)).not.toContain(
      "Dashed line: Person to system",
    );
    render(<DiagramKey model={model} />);
    expect(screen.getByRole("region", { name: "Diagram Key" }).querySelector("dt")?.textContent).toBe(
      "Dashed line: Person to system",
    );
  });
  it("never invents a meaning for an ER relationship's notation dash", () => {
    const model: KeyModel = {
      type: "graph",
      view: {
        ...base,
        notation: "er",
        edges: [{ id: "e", source: "a", target: "b", label: undefined, line: "dotted" }],
      },
    };
    expect(labels(model).some((label) => label.startsWith("Dotted line"))).toBe(false);
  });
  it("returns no phantom marks for an empty model", () => {
    expect(diagramKeyEntries({ type: "graph", view: base })).toEqual([]);
  });
});

describe("the key of what is drawn (nested view)", () => {
  const c4: ProjectedView = {
    ...base,
    kind: "c4",
    modelType: "c4",
    notation: "c4",
    nodes: [
      {
        id: "customer",
        label: "Customer",
        shape: undefined,
        classes: [],
        groupId: undefined,
        figure: { type: "c4", kind: "person", external: false },
      },
      {
        id: "db",
        label: "Database",
        shape: undefined,
        classes: [],
        groupId: "shop",
        figure: { type: "c4", kind: "container", external: false, shape: "database" },
      },
      {
        id: "jobs",
        label: "Jobs",
        shape: undefined,
        classes: [],
        groupId: "shop",
        figure: { type: "c4", kind: "container", external: false, shape: "queue" },
      },
    ],
    edges: [],
    groups: [{ id: "shop", label: "Shop", parentId: undefined, figure: { type: "boundary", kind: "system" } }],
  };
  it("lists only the notation on screen while a boundary is closed, and its insides once it opens", () => {
    const closed = keyOfDrawing({ type: "graph", view: c4 }, nestView(c4, []).view);
    expect(labels(closed)).not.toContain("Database");
    expect(labels(closed)).not.toContain("Queue");
    expect(labels(closed)).toContain("Person");
    const open = keyOfDrawing({ type: "graph", view: c4 }, nestView(c4, ["shop"]).view);
    expect(labels(open)).toEqual(expect.arrayContaining(["Database", "Queue", "Person"]));
  });
  it("is the model itself in the full view", () => {
    const model: KeyModel = { type: "graph", view: c4 };
    expect(keyOfDrawing(model, null)).toBe(model);
  });
});

const journey: KeyModel = {
  type: "journey",
  view: {
    ...base,
    actors: ["Reader"],
    sections: [{ id: "s", label: "Stage", tasks: [{ id: "t", label: "Task", score: 4, actors: ["Reader"] }] }],
  },
};
/** The key inside a stage of the given size, as `App` mounts it. */
function inStage(size: { width: number; height: number }, props: { legendUp?: boolean } = {}) {
  const view = render(
    <div data-testid="stage">
      <DiagramKey model={journey} {...props} />
    </div>,
  );
  return view;
}
function sized(size: { width: number; height: number }): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return (
      this.dataset.testid === "stage"
        ? { x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, ...size }
        : { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    ) as DOMRect;
  });
}
describe("open or closed to its header (G2)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });
  const button = () => screen.getByRole("button", { name: "Diagram Key" });
  it("opens to its rows on a roomy stage with no legend up", () => {
    sized({ width: 1376, height: 796 });
    inStage({ width: 1376, height: 796 });
    expect(button()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Satisfaction score")).toBeVisible();
  });
  // Expanded by default wherever it appears (owner, 2026-11-12): it used to start closed on a small stage or with
  // the Highlights legend up, docked at the bottom where it was easy to miss.
  it.each([
    ["a stage under 1100 wide", { width: 960, height: 800 }, {}],
    ["a stage under 700 tall", { width: 1376, height: 620 }, {}],
    ["a legend up", { width: 1376, height: 796 }, { legendUp: true }],
  ] as const)("starts open to its rows with %s, and a tap closes it", (_name, size, props) => {
    sized(size);
    inStage(size, props);
    expect(button()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Satisfaction score")).toBeVisible();
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Satisfaction score")).not.toBeVisible();
  });
  it("remembers the viewer's choice over the stage's default", () => {
    sized({ width: 1376, height: 796 });
    const first = inStage({ width: 1376, height: 796 });
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-expanded", "false");
    first.unmount();
    inStage({ width: 1376, height: 796 });
    expect(button()).toHaveAttribute("aria-expanded", "false");
  });
  it("still works when storage is refused", () => {
    sized({ width: 1376, height: 796 });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    inStage({ width: 1376, height: 796 });
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-expanded", "false");
  });
  it("closes on Escape, keeping its header and focus", () => {
    sized({ width: 1376, height: 796 });
    inStage({ width: 1376, height: 796 });
    const key = screen.getByRole("region", { name: "Diagram Key" });
    expect(key.querySelector("svg")).not.toBeNull();
    expect(key.textContent).toContain("1 is least satisfied; 5 is most satisfied");
    fireEvent.keyDown(key, { key: "Escape" });
    expect(button()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region", { name: "Diagram Key" })).toBeVisible();
    expect(document.activeElement).toBe(button());
  });
});

describe("moved like the chat bubble (decided 2026-10-25)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });
  const grip = () => screen.getByRole("button", { name: "Move Diagram Key" });
  it("has a handle that is separate from the open/close toggle, and moves with the arrow keys", () => {
    sized({ width: 1376, height: 796 });
    inStage({ width: 1376, height: 796 });
    const key = screen.getByRole("region", { name: "Diagram Key" });
    expect(key).not.toHaveAttribute("data-moved");
    fireEvent.keyDown(grip(), { key: "ArrowRight" });
    expect(key).toHaveAttribute("data-moved");
    expect(key.style.position).toBe("fixed");
    // The toggle is untouched by a move.
    expect(screen.getByRole("button", { name: "Diagram Key" })).toHaveAttribute("aria-expanded", "true");
    expect(window.localStorage.getItem("archer.diagram-key.position")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset Diagram Key position" }));
    expect(key).not.toHaveAttribute("data-moved");
  });
});

it("uses a solid rounded sample for a composite state frame", () => {
  render(<DiagramKey model={grouped({ type: "composite" })} />);
  const sample = screen.getByText("Composite state").querySelector("svg rect");
  expect(sample?.getAttribute("stroke-dasharray")).toBeNull();
  expect(Number(sample?.getAttribute("rx"))).toBeGreaterThan(2);
});
