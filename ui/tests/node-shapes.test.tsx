// @vitest-environment jsdom
//
// A node says what it is by more than its label.
//
// The model has always carried a `shape` and semantic `classes`, the adapter
// has always delivered them, and for a long time nothing drew either: every
// node was the same rectangle. These tests enumerate both vocabularies -- the
// whole enum, per AGENTS.md, so a new shape or class with no drawing fails
// here instead of silently rendering as a plain box.
//
// jsdom lays nothing out and resolves no `var()`, so what is asserted is the
// markup the canvas produces and the rules the stylesheet on disk holds for
// it. What those rules LOOK like is checked in a real browser.
import { readStylesheet, throughTokens } from "./stylesheet";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout } from "../src/layout/elk-adapter";
import {
  EDGE_LABEL_FONT_PX,
  EDGE_LABEL_LINE_PX,
  NODE_KINDS,
  NODE_LABEL_FONT_PX,
  NODE_LABEL_LINE_PX,
  NODE_SHAPES,
  ROUNDED_RADIUS_PX,
  CYLINDER_CAP_PX,
  SUBROUTINE_BAR_PX,
  edgeLabelBox,
  hexagonPoints,
  nodeBox,
} from "../src/layout/graph-metrics";
import type { ProjectedView } from "../src/diagrams/projection";

afterEach(cleanup);

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  // Comments quote selectors and declarations; only real rules count.
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { body }` in the stylesheet, selector list unsplit. */
const RULES: { selector: string; body: string }[] = [];
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  RULES.push({ selector: match[1].trim(), body: match[2] });
}

/** Bodies of the rules whose selector mentions every one of `fragments`. */
function bodiesFor(...fragments: string[]): string[] {
  return RULES.filter((rule) =>
    rule.selector.split(",").some((part) => fragments.every((fragment) => part.includes(fragment))),
  ).map((rule) => rule.body);
}

const LONG = "Workspace repository (archer.toml and .mmd sources)";

async function draw(
  nodes: { id: string; label: string; shape?: string; classes?: string[] }[],
  edges: { id: string; source: string; target: string; label?: string }[] = [],
): Promise<HTMLElement> {
  const view: ProjectedView = {
    viewId: "shapes",
    kind: "freeform",
    title: "Shapes",
    revision: "1",
    modelType: "freeform-graph",
    groups: [],
    nodes: nodes.map((node) => ({
      id: node.id,
      label: node.label,
      shape: node.shape,
      classes: node.classes ?? [],
      groupId: undefined,
    })),
    edges: edges.map((edge) => ({ ...edge, label: edge.label })),
  };
  const layout = await computeLayout(view);
  return render(<DiagramCanvas state={{ status: "ready", layout }} />).container;
}

const nodeElement = (container: HTMLElement, id: string): HTMLElement => {
  const element = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  expect(element, `node ${id} is not drawn`).not.toBeNull();
  return element!;
};

describe("every shape is drawn as itself", () => {
  it.each(NODE_SHAPES)("marks a %s node with its shape", async (shape) => {
    const container = await draw([{ id: "n", label: "Node", shape }]);
    const node = nodeElement(container, "n");

    expect(node.classList.contains(`archer-shape-${shape}`)).toBe(true);
    // Still the Archer node every state rule hangs off.
    expect(node.classList.contains("archer-node")).toBe(true);
  });

  it("draws a node with no shape, or one it does not know, as a rectangle", async () => {
    const container = await draw([
      { id: "none", label: "None" },
      { id: "odd", label: "Odd", shape: "trapezoid" },
    ]);

    expect(nodeElement(container, "none").classList.contains("archer-shape-rectangle")).toBe(true);
    expect(nodeElement(container, "odd").classList.contains("archer-shape-rectangle")).toBe(true);
  });

  // What a shape is drawn WITH: every declaration the stylesheet makes for
  // its class, plus whatever element the node renders inside itself for it.
  // The whole enum again -- a shape nobody drew has an empty drawing, and one
  // drawn like another has the same drawing, and both fail here.
  describe("no shape is left undrawn, or drawn like another", () => {
    const drawing = async (shape: string): Promise<string> => {
      const container = await draw([{ id: "n", label: "Node", shape }]);
      const inner = [...nodeElement(container, "n").querySelectorAll("[class^='archer-node-']")]
        .map((element) => element.getAttribute("class"))
        .filter((name) => name !== "archer-node-text" && name !== "archer-node-label-row");
      const rules = RULES.filter((rule) => rule.selector.includes(`.archer-shape-${shape}`))
        .map((rule) => rule.body.replace(/\s+/g, " ").trim())
        .sort();
      return JSON.stringify({ inner, rules });
    };

    it.each(NODE_SHAPES)("draws a %s with rules of its own", async (shape) => {
      const own = RULES.filter((rule) => rule.selector.includes(`.archer-shape-${shape}`));
      expect(own, `no rule mentions .archer-shape-${shape}`).not.toHaveLength(0);
    });

    it("draws every shape differently from every other", async () => {
      const drawings = await Promise.all(NODE_SHAPES.map(drawing));
      expect(new Set(drawings).size, "two shapes are drawn identically").toBe(NODE_SHAPES.length);
    });
  });

  it("gives each shape made by a radius a radius no other has", () => {
    const radius = (shape: string): string | undefined =>
      bodiesFor(`.archer-node.archer-shape-${shape}`)
        .map((body) => /border-radius:\s*([^;]+);/.exec(body)?.[1].trim())
        .find((value) => value !== undefined);

    const rounded = ["rectangle", "rounded", "stadium", "circle", "cylinder", "subroutine"];
    const radii = rounded.map(radius);
    expect(
      radii.every((value) => value !== undefined),
      `radii: ${radii.join(" | ")}`,
    ).toBe(true);
    expect(new Set(radii).size).toBe(rounded.length);
    // The layout carries wires on to these, so the two must agree.
    expect(radius("rounded")).toBe(`${ROUNDED_RADIUS_PX}px`);
    expect(radius("cylinder")).toBe(`50% / ${CYLINDER_CAP_PX}px`);
  });

  it("draws the hexagon as a six-cornered outline inside the node, since no radius can", async () => {
    const container = await draw([{ id: "h", label: "API gateway", shape: "hexagon" }]);
    const node = nodeElement(container, "h");
    const body = node.querySelector("svg.archer-node-hexagon .archer-node-hexagon-body");

    expect(body, "no hexagon is drawn inside the node").not.toBeNull();
    const corners = body!.getAttribute("points")!.trim().split(/\s+/);
    expect(corners).toHaveLength(6);
    // The corners the wires are carried to, not a second opinion on them.
    const { width, height } = nodeBox("API gateway", "hexagon", []);
    expect(corners.join(" ")).toBe(
      hexagonPoints(width, height)
        .map((point) => `${point.x},${point.y}`)
        .join(" "),
    );
    expect(bodiesFor(".archer-node-hexagon-body").join("\n")).toMatch(/var\(--node-bg\)/);
    expect(bodiesFor(".archer-node-hexagon-body").join("\n")).toMatch(/var\(--node-border\)/);
  });

  it("draws a subroutine as a box with a bar inside each end", () => {
    const bars = bodiesFor(".archer-shape-subroutine", "::before").join("\n");
    expect(bars).toMatch(/border-width:\s*0\s+var\(--line-chrome\)/);
    // The bars take the border's colour in every state, so no state needs a
    // rule of its own for them.
    expect(bars).toMatch(/border-color:\s*inherit/);
    expect(bars).toMatch(new RegExp(`right:\\s*${SUBROUTINE_BAR_PX - 1}px`));
  });

  it("draws the diamond as a turned square inside the node, since no radius can", async () => {
    const container = await draw([{ id: "d", label: "Fraud check?", shape: "diamond" }]);
    const node = nodeElement(container, "d");

    expect(node.querySelector(".archer-node-diamond")).not.toBeNull();
    const body = bodiesFor(".archer-node-diamond").join("\n");
    expect(body).toMatch(/rotate\(45deg\)/);
    expect(body).toMatch(/var\(--node-bg\)/);
    expect(body).toMatch(/var\(--node-border\)/);
  });

  it("draws no turned square inside any other shape", async () => {
    const container = await draw(
      NODE_SHAPES.filter((shape) => shape !== "diamond").map((shape) => ({ id: shape, label: shape, shape })),
    );
    expect(container.querySelector(".archer-node-diamond")).toBeNull();
  });

  it("draws no hexagon inside any other shape", async () => {
    const container = await draw(
      NODE_SHAPES.filter((shape) => shape !== "hexagon").map((shape) => ({ id: shape, label: shape, shape })),
    );
    expect(container.querySelector(".archer-node-hexagon")).toBeNull();
  });

  // The box, the fill and the rings of every other shape are the node element
  // itself, so the existing state rules reach them unchanged. A diamond's are
  // the turned square and a hexagon's are its polygons, so each state needs a
  // rule that reaches THEM -- and a state with no such rule is a state that
  // shape silently cannot show.
  const PAINTED_INSIDE: Readonly<Record<string, string>> = {
    diamond: ".archer-node-diamond",
    hexagon: ".archer-node-hexagon",
  };
  const STATES = [
    ["hover", ":hover"],
    ["selection", ".selected"],
    ["the keyboard ring", ".archer-kbd-focus"],
    ["the keyboard ring on a selected node", ".archer-kbd-focus.selected"],
    ["agent emphasis", ".archer-emph"],
    // Since ADR 0030 emphasis is the outline's colour in every style and with
    // motion off, so ".archer-emph" is the one emphasis state to draw.
    ["the system kind", ".archer-kind-system"],
    ["the external kind", ".archer-kind-external"],
  ] as const;

  describe.each(Object.entries(PAINTED_INSIDE))("a %s, painted inside the node", (shape, inner) => {
    it.each(STATES)("shows %s", (_state, fragment) => {
      const bodies = bodiesFor(`.archer-shape-${shape}`, fragment, inner);
      expect(bodies, `no rule draws ${fragment} on the ${shape}`).not.toHaveLength(0);
    });

    it("hands every paint the node element would have done to the inner outline", () => {
      const cancelled = bodiesFor(`.archer-node.archer-shape-${shape}:not(#archer-none)`).join("\n");
      for (const property of ["background", "box-shadow", "outline", "animation"]) {
        expect(cancelled, `${shape} still paints its own ${property}`).toMatch(
          new RegExp(`${property}:[^;]*!important`),
        );
      }
    });
  });

  // The other half of the table above: a shape that cancels the node's own
  // paint and is NOT listed there would have its states checked by nobody.
  it.each(NODE_SHAPES)("%s is either painted by the node itself or listed as painted inside it", (shape) => {
    const cancels = bodiesFor(`.archer-node.archer-shape-${shape}:not(#archer-none)`).length > 0;
    expect(cancels).toBe(shape in PAINTED_INSIDE);
  });

  it("keeps the hexagon's keyboard ring in the focus token, not the accent", () => {
    const ring = bodiesFor(".archer-shape-hexagon", ".archer-kbd-focus", ".archer-node-hexagon").join("\n");
    expect(ring).toMatch(/stroke:\s*var\(--kbd-focus\)/);
  });

  it("keeps the diamond's keyboard ring in the focus token, not the accent", () => {
    const ring = bodiesFor(".archer-shape-diamond", ".archer-kbd-focus", ".archer-node-diamond")[0];
    expect(ring).toMatch(/inset[^;]*var\(--kbd-focus\)/);
  });
});

describe("every semantic class is told apart, and never by colour alone", () => {
  it.each(NODE_KINDS.filter((kind) => kind !== "person"))(
    "marks a %s node, names its kind in words and gives it a glyph",
    async (kind) => {
      const container = await draw([{ id: "n", label: "Node", classes: [kind] }]);
      const node = nodeElement(container, "n");

      expect(node.classList.contains(`archer-kind-${kind}`)).toBe(true);
      const caption = node.querySelector(".archer-node-kind");
      expect(caption, "no kind caption").not.toBeNull();
      expect(caption!.textContent).toBe(kind);
      expect(caption!.querySelector("svg"), "no glyph").not.toBeNull();
    },
  );

  // A flowchart person has no "Person" row over its label (review C.11, redesign slice 4): a glyph beside its title.
  it("marks a person node with a glyph beside its title and no kind word", async () => {
    const container = await draw([{ id: "n", label: "You", classes: ["person"] }]);
    const node = nodeElement(container, "n");
    expect(node.classList.contains("archer-kind-person")).toBe(true);
    expect(node.querySelector(".archer-node-kind")).toBeNull();
    const title = node.querySelector(".archer-node-title-row")!;
    expect(title.querySelector(".archer-node-person-glyph svg"), "no glyph").not.toBeNull();
    expect(title.textContent).toBe("You");
  });

  it("draws a different glyph for every class", async () => {
    const container = await draw(NODE_KINDS.map((kind) => ({ id: kind, label: kind, classes: [kind] })));
    const glyphs = NODE_KINDS.map(
      (kind) =>
        nodeElement(container, kind).querySelector(":is(.archer-node-kind, .archer-node-person-glyph) svg")!.innerHTML,
    );
    expect(new Set(glyphs).size).toBe(NODE_KINDS.length);
  });

  it("adds nothing to a node that carries no semantic class", async () => {
    const container = await draw([{ id: "n", label: "Node", classes: ["highlighted"] }]);
    const node = nodeElement(container, "n");

    expect(node.querySelector(".archer-node-kind")).toBeNull();
    expect([...node.classList].some((name) => name.startsWith("archer-kind-"))).toBe(false);
  });

  it("keeps the kind caption out of the node's accessible name", async () => {
    const container = await draw([{ id: "n", label: "Orders", classes: ["database"] }]);
    expect(nodeElement(container, "n").getAttribute("aria-label")).toBe("Orders");
  });

  it("draws an external system with a dashed border", () => {
    expect(bodiesFor(".archer-kind-external").join("\n")).toMatch(/border-style:\s*dashed/);
  });

  it("draws a cylinder with curved ends and a lid", () => {
    expect(bodiesFor(".archer-node.archer-shape-cylinder").join("\n")).toMatch(/border-radius:\s*50%\s*\//);
    expect(bodiesFor(".archer-shape-cylinder", "::before")).not.toHaveLength(0);
  });

  // `db[(Orders)]`, `db[Orders]:::database` and `db[(Orders)]:::database` are
  // one family: the same outline class, drawn by the same rules, once.
  it("draws a database rectangle and a declared cylinder as the same outline", async () => {
    const container = await draw([
      { id: "declared", label: "Orders", shape: "cylinder" },
      { id: "classed", label: "Orders", shape: "rectangle", classes: ["database"] },
      { id: "both", label: "Orders", shape: "cylinder", classes: ["database"] },
      { id: "shapeless", label: "Orders", classes: ["database"] },
    ]);
    const shapeClasses = (id: string): string[] =>
      [...nodeElement(container, id).classList].filter((name) => name.startsWith("archer-shape-"));

    for (const id of ["declared", "classed", "both", "shapeless"]) {
      expect(shapeClasses(id), id).toEqual(["archer-shape-cylinder"]);
    }
    // The class adds its words and glyph; the shape alone adds neither.
    expect(nodeElement(container, "declared").querySelector(".archer-node-kind")).toBeNull();
    expect(nodeElement(container, "both").querySelector(".archer-node-kind")).not.toBeNull();
    expect(nodeElement(container, "both").style.height).toBe(nodeElement(container, "classed").style.height);
  });

  it("leaves the database class no outline of its own to stack on a shape", () => {
    // Everything the class draws is its caption; the cylinder is the shape's.
    expect(RULES.filter((rule) => rule.selector.includes(".archer-kind-database"))).toEqual([]);
  });

  it("keeps a database's own shape when the author gave it one", async () => {
    const container = await draw([{ id: "n", label: "Queue", shape: "stadium", classes: ["database"] }]);
    expect(nodeElement(container, "n").classList.contains("archer-shape-stadium")).toBe(true);
    expect(nodeElement(container, "n").classList.contains("archer-shape-cylinder")).toBe(false);
  });
});

describe("a label is drawn in the box that was sized for it", () => {
  it("draws the label as the rows the layout wrapped it into", async () => {
    const container = await draw([{ id: "n", label: LONG }]);
    const rows = [...nodeElement(container, "n").querySelectorAll(".archer-node-label-row")].map(
      (row) => row.textContent,
    );

    expect(rows).toEqual(nodeBox(LONG, undefined, []).lines);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("centres the label both ways and never lets the browser re-wrap a row", () => {
    const node = bodiesFor(".archer-node").join("\n");
    expect(node).toMatch(/display:\s*flex/);
    expect(node).toMatch(/align-items:\s*center/);
    expect(node).toMatch(/justify-content:\s*center/);
    expect(bodiesFor(".archer-node-label-row").join("\n")).toMatch(/white-space:\s*nowrap/);
  });

  // The layout sizes boxes from these numbers; if the stylesheet draws the
  // text at another size the estimate is wrong and labels overflow again.
  it("draws node labels at the size the layout measured them at", () => {
    const node = RULES.find((rule) => rule.selector === ".archer-node")!.body;
    expect(node).toMatch(/font-size:\s*var\(--type-canvas-node-label\)/);
    expect(throughTokens(readStylesheet(), "var(--type-canvas-node-label)")).toBe(`${NODE_LABEL_FONT_PX}px`);
    expect(node).toMatch(new RegExp(`line-height:\\s*${NODE_LABEL_LINE_PX}px`));
  });

  it("draws edge captions at the size the layout measured them at", () => {
    const caption = RULES.find((rule) => rule.selector === ".archer-edge-label")!.body;
    expect(caption).toMatch(/font-size:\s*var\(--type-canvas-edge-label\)/);
    expect(throughTokens(readStylesheet(), "var(--type-canvas-edge-label)")).toBe(`${EDGE_LABEL_FONT_PX}px`);
    expect(caption).toMatch(new RegExp(`line-height:\\s*${EDGE_LABEL_LINE_PX}px`));
    expect(caption).toMatch(/white-space:\s*nowrap/);
  });

  it("draws an edge caption as the rows the layout wrapped it into", async () => {
    const text = "compiled model, diagnostics, selection and everything else";
    const container = await draw(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      [{ id: "e", source: "a", target: "b", label: text }],
    );

    const caption = await new Promise<Element>((done, fail) => {
      const started = Date.now();
      const poll = (): void => {
        const found = container.querySelector(".archer-edge-label");
        if (found) done(found);
        else if (Date.now() - started > 2000) fail(new Error("no edge caption was drawn"));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const rows = [...caption.querySelectorAll(".archer-edge-label-row")].map((row) => row.textContent);
    expect(rows).toEqual(edgeLabelBox(text).lines);
    expect(rows.length).toBeGreaterThan(1);
  });
});
