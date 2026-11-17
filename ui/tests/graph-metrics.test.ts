// Node and caption boxes are ESTIMATED from the text, never measured.
//
// Layout runs under jsdom in tests and in a browser in production, and it has
// to produce the same coordinates in both -- so nothing here may touch the DOM
// (this file runs in the `node` environment, where there is none). What these
// tests pin is the contract the renderer relies on: the box a label is given is
// big enough for the lines it will be drawn as, on every shape.
import { LABEL_WRAP_CHARS } from "../../ts/src/mermaid/lint";
import { describe, expect, it } from "vitest";
import { closedToggleInset, TOGGLE_DRAWN_PX, TOGGLE_GAP_PX } from "../src/nesting/toggle-place";
import {
  NEST_CONTROL_CLEAR_PX,
  CYLINDER_CAP_PX,
  EDGE_LABEL_LINE_PX,
  EDGE_LABEL_MAX_LINES,
  edgeLabelWrapPx,
  EDGE_LABEL_PAD_X,
  EDGE_LABEL_WRAP_CHARS,
  EDGE_LABEL_PAD_Y,
  NODE_HEIGHT,
  NODE_KINDS,
  NODE_SHAPES,
  NODE_WIDTH,
  edgeLabelBox,
  captionParts,
  captionWithDetail,
  EDGE_DETAIL_WRAP_PX,
  EDGE_TECHNOLOGY_FONT_PX,
  EDGE_TECHNOLOGY_LINE_PX,
  estimateTextWidth,
  hexagonPoints,
  insideShape,
  kindOf,
  meetOutline,
  nodeBox,
  offsetPolygon,
  outlineOf,
  shapeOf,
} from "../src/layout/graph-metrics";

const SHORT = "CDN";
const MEDIUM = "Web application (Next.js)";
const LONG = "Workspace repository (archer.toml and .mmd sources)";

describe("shape and kind are read off the model, with a safe default", () => {
  it.each(NODE_SHAPES)("recognises %s", (shape) => {
    expect(shapeOf(shape)).toBe(shape);
  });

  it("draws an absent or unknown shape as a rectangle", () => {
    expect(shapeOf(undefined)).toBe("rectangle");
    expect(shapeOf("trapezoid")).toBe("rectangle");
  });

  it.each(NODE_KINDS)("recognises the %s class", (kind) => {
    expect(kindOf(["something-else", kind])).toBe(kind);
  });

  it("has no kind for a node with no semantic class", () => {
    expect(kindOf([])).toBeUndefined();
    expect(kindOf(["highlighted"])).toBeUndefined();
  });
});

describe("a node box is sized from its label", () => {
  it("keeps a short label in the standard box", () => {
    const box = nodeBox(SHORT, "rectangle", []);
    expect(box.lines).toEqual([SHORT]);
    expect(box.width).toBe(NODE_WIDTH);
    expect(box.height).toBe(NODE_HEIGHT);
  });

  it("wraps a long label and grows the box rather than letting it overflow", () => {
    const box = nodeBox(LONG, "rectangle", []);
    expect(box.lines.length).toBeGreaterThanOrEqual(2);
    expect(box.lines.join(" ")).toBe(LONG);
    expect(box.height).toBeGreaterThan(NODE_HEIGHT);
  });

  it("makes room for the kind caption a semantic class adds", () => {
    const plain = nodeBox(LONG, "rectangle", []);
    const kinded = nodeBox(LONG, "rectangle", ["external"]);
    expect(kinded.textHeight).toBeGreaterThan(plain.textHeight);
    expect(kinded.height).toBeGreaterThan(plain.height);
  });

  it("splits a single word no line can hold", () => {
    const word = "Supercalifragilisticexpialidocious-and-then-some-more";
    const box = nodeBox(word, "rectangle", []);
    expect(box.lines.length).toBeGreaterThan(1);
    expect(box.lines.join("")).toBe(word);
  });

  it.each(["circle", "diamond"] as const)("keeps a %s as tall as it is wide", (shape) => {
    for (const label of [SHORT, MEDIUM, LONG]) {
      const box = nodeBox(label, shape, []);
      expect(box.width).toBe(box.height);
    }
  });

  // The contract the renderer relies on, for every shape and label length: the
  // centred text block lies wholly inside the OUTLINE, not merely inside the
  // bounding box -- a diamond's corners are outside the diamond.
  const cases = NODE_SHAPES.flatMap((shape) =>
    [SHORT, MEDIUM, LONG].flatMap((label) =>
      [[] as string[], ["database"]].map((classes) => ({ shape, label, classes })),
    ),
  );
  it.each(cases)("fits the text of a $shape inside its outline ($label, $classes)", ({ shape, label, classes }) => {
    const box = nodeBox(label, shape, classes);

    const widest = Math.max(...box.lines.map((line) => estimateTextWidth(line, 14, true)));
    expect(box.textWidth).toBeGreaterThanOrEqual(widest);
    expect(box.textHeight).toBeGreaterThan(0);

    const outline = outlineOf(shape, classes);
    const left = (box.width - box.textWidth) / 2;
    // A cylinder's text is centred in what is left below its lid.
    const lid = outline === "cylinder" ? 2 * CYLINDER_CAP_PX : 0;
    const top = lid + (box.height - lid - box.textHeight) / 2;
    for (const [x, y] of [
      [left, top],
      [left + box.textWidth, top],
      [left, top + box.textHeight],
      [left + box.textWidth, top + box.textHeight],
    ]) {
      expect(insideShape(outline, box.width, box.height, x, y), `corner ${x},${y}`).toBe(true);
      expect(y, "text under the cylinder's lid").toBeGreaterThanOrEqual(lid);
    }
  });

  it("is a pure function of its input", () => {
    expect(nodeBox(LONG, "stadium", ["person"])).toEqual(nodeBox(LONG, "stadium", ["person"]));
  });
});

describe("the shape vocabulary is the wire contract's", () => {
  it("knows every shape version 2 of the contract can send", () => {
    expect([...NODE_SHAPES].sort()).toEqual([
      "circle",
      "cylinder",
      "diamond",
      "hexagon",
      "rectangle",
      "rounded",
      "stadium",
      "subroutine",
    ]);
  });

  // The whole enum, so a shape added to the vocabulary without an outline and
  // a box of its own fails here rather than drawing its label over its edge.
  describe.each(NODE_SHAPES)("%s", (shape) => {
    it.each([SHORT, MEDIUM, LONG])("holds the label %j inside its own outline", (label) => {
      const box = nodeBox(label, shape, []);
      const left = (box.width - box.textWidth) / 2;
      const top = (box.height - box.textHeight) / 2;
      for (const [x, y] of [
        [left, top],
        [left + box.textWidth, top],
        [left, top + box.textHeight],
        [left + box.textWidth, top + box.textHeight],
      ]) {
        expect(insideShape(shape, box.width, box.height, x, y), `corner ${x},${y}`).toBe(true);
      }
    });

    it("is drawn as itself whatever class it carries", () => {
      expect(outlineOf(shape, [])).toBe(shape);
      if (shape !== "rectangle") expect(outlineOf(shape, ["database"])).toBe(shape);
    });

    it("lets a wire arriving on any side of its box reach it", () => {
      const box = { x: 0, y: 0, width: 180, height: 80 };
      for (const [end, towards] of [
        [
          { x: 60, y: 0 },
          { x: 60, y: 80 },
        ],
        [
          { x: 60, y: 80 },
          { x: 60, y: 0 },
        ],
        [
          { x: 0, y: 25 },
          { x: 180, y: 25 },
        ],
        [
          { x: 180, y: 25 },
          { x: 0, y: 25 },
        ],
      ]) {
        const met = meetOutline(shape, box, end, towards);
        const ux = Math.sign(towards.x - end.x);
        const uy = Math.sign(towards.y - end.y);
        expect(insideShape(shape, 180, 80, met.x + ux, met.y + uy), `from ${end.x},${end.y}`).toBe(true);
        expect(insideShape(shape, 180, 80, met.x - ux, met.y - uy), `from ${end.x},${end.y}`).toBe(false);
      }
    });
  });

  it("cuts the four corners off a hexagon and leaves its points on the box", () => {
    expect(insideShape("hexagon", 180, 60, 2, 2)).toBe(false);
    expect(insideShape("hexagon", 180, 60, 178, 58)).toBe(false);
    expect(insideShape("hexagon", 180, 60, 1, 30)).toBe(true);
    expect(insideShape("hexagon", 180, 60, 90, 1)).toBe(true);
  });

  it("gives a subroutine room for the bar inside each end", () => {
    const wide = "A label that is exactly as wide as it is";
    expect(nodeBox(wide, "subroutine", []).width).toBeGreaterThan(nodeBox(wide, "rectangle", []).width);
    expect(insideShape("subroutine", 180, 60, 1, 1)).toBe(true);
  });

  it("sizes a declared cylinder exactly as it sizes a database rectangle's", () => {
    expect(nodeBox(MEDIUM, "cylinder", ["database"])).toEqual(nodeBox(MEDIUM, "rectangle", ["database"]));
    expect(nodeBox(MEDIUM, "cylinder", []).height).toBeGreaterThanOrEqual(nodeBox(MEDIUM, "rectangle", []).height);
  });
});

describe("a ring stands the same distance off every side", () => {
  it("grows a rectangle by the distance on all four sides", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const grown = offsetPolygon(square, 2).map((point) => [Math.round(point.x), Math.round(point.y)]);
    expect(grown).toEqual([
      [-2, -2],
      [12, -2],
      [12, 12],
      [-2, 12],
    ]);
  });

  it.each([4, -2])("moves every side of a hexagon by %ipx, flats and slants alike", (distance) => {
    const hexagon = hexagonPoints(180, 60);
    const moved = offsetPolygon(hexagon, distance);
    for (let i = 0; i < hexagon.length; i += 1) {
      const a = hexagon[i];
      const b = hexagon[(i + 1) % hexagon.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      // Signed distance of the moved corner from the original side's line.
      const off = ((moved[i].x - a.x) * (b.y - a.y) - (moved[i].y - a.y) * (b.x - a.x)) / length;
      expect(off).toBeCloseTo(distance, 6);
    }
  });

  it("puts a hexagon's corners on the outline the wires are carried to", () => {
    for (const point of offsetPolygon(hexagonPoints(180, 60), -0.5)) {
      expect(insideShape("hexagon", 180, 60, point.x, point.y)).toBe(true);
    }
    for (const point of offsetPolygon(hexagonPoints(180, 60), 0.5)) {
      expect(insideShape("hexagon", 180, 60, point.x, point.y)).toBe(false);
    }
  });
});

describe("the outline of each shape", () => {
  it("excludes the corners of the bounding box for the shapes that have none", () => {
    expect(insideShape("rectangle", 100, 100, 1, 1)).toBe(true);
    for (const shape of ["circle", "diamond", "stadium"] as const) {
      expect(insideShape(shape, 100, 100, 1, 1), shape).toBe(false);
      expect(insideShape(shape, 100, 100, 50, 50), shape).toBe(true);
    }
  });

  it("extends a wire that stops at the bounding box until it meets a diamond", () => {
    // Arriving from above, a quarter of the way along the top side: the
    // diamond's edge there is a quarter of the height further down.
    const box = { x: 0, y: 0, width: 100, height: 100 };
    const met = meetOutline("diamond", box, { x: 25, y: 0 }, { x: 25, y: 100 });
    expect(met.x).toBeCloseTo(25, 5);
    expect(met.y).toBeCloseTo(25, 0);
  });

  it("extends a wire until it meets a circle", () => {
    const box = { x: 10, y: 10, width: 100, height: 100 };
    const met = meetOutline("circle", box, { x: 60, y: 110 }, { x: 60, y: 10 });
    // Dead centre from below: the circle touches its box there already.
    expect(met.y).toBeCloseTo(110, 0);
    const offCentre = meetOutline("circle", box, { x: 30, y: 110 }, { x: 30, y: 10 });
    expect(offCentre.y).toBeCloseTo(100, 0);
  });

  it("draws a database rectangle, and only a rectangle, as a cylinder", () => {
    expect(outlineOf("rectangle", ["database"])).toBe("cylinder");
    expect(outlineOf(undefined, ["database"])).toBe("cylinder");
    expect(outlineOf("stadium", ["database"])).toBe("stadium");
    expect(outlineOf("rectangle", ["container"])).toBe("rectangle");
  });

  it("cuts the corners off a cylinder but leaves its sides straight", () => {
    expect(insideShape("cylinder", 180, 60, 1, 1)).toBe(false);
    expect(insideShape("cylinder", 180, 60, 90, 1)).toBe(true);
    expect(insideShape("cylinder", 180, 60, 1, 30)).toBe(true);
  });

  it("leaves a wire alone where the outline is the box", () => {
    const box = { x: 0, y: 0, width: 180, height: 60 };
    expect(meetOutline("rectangle", box, { x: 90, y: 0 }, { x: 90, y: 60 })).toEqual({ x: 90, y: 0 });
  });
});

describe("the width estimate", () => {
  // Real widths of the embedded Fira Sans with the page's tracking (600 for a
  // node label, 400 for a caption), measured in headless Chromium on macOS and
  // Linux, the wider rounded up. The estimate may run over -- slack is
  // invisible in a centred label -- but never under, or the label overflows.
  it.each([
    ["Notification worker", 14, true, 135],
    ["Web application (Next.js)", 14, true, 174],
    ["302 redirect carrying the authorization code", 12, false, 263],
  ] as const)("never under-reserves %s", (text, fontPx, bold, measured) => {
    const estimate = estimateTextWidth(text, fontPx, bold);
    expect(estimate).toBeGreaterThanOrEqual(measured);
    expect(estimate).toBeLessThanOrEqual(measured * 1.12);
  });

  it("reserves more for bold than for regular", () => {
    expect(estimateTextWidth("Orders", 14, true)).toBeGreaterThan(estimateTextWidth("Orders", 14));
  });
});

describe("an edge caption box", () => {
  it("is the box the caption is drawn in: its lines plus the plate's padding", () => {
    const box = edgeLabelBox("routes");
    expect(box.lines).toEqual(["routes"]);
    expect(box.height).toBe(EDGE_LABEL_LINE_PX + 2 * EDGE_LABEL_PAD_Y);
    expect(box.width).toBeGreaterThanOrEqual(estimateTextWidth("routes", 12) + 2 * EDGE_LABEL_PAD_X);
  });

  // Widened from 14 characters (owner, 2026-11-12: the reference keeps a short label on one line; ADR 0030 amended).
  it("wraps at about 24 characters, so a label of four or five words stays on one line", () => {
    expect(EDGE_LABEL_WRAP_CHARS).toBe(LABEL_WRAP_CHARS);
    expect(edgeLabelWrapPx()).toBeGreaterThanOrEqual(160);
    expect(edgeLabelWrapPx()).toBeLessThanOrEqual(200);
    for (const label of [
      "handed to the chat",
      "holes found: rewrite it",
      "not quite: rewrite it",
      "fails again: you decide",
      "next plans start smarter",
    ])
      expect(edgeLabelBox(label).lines, label).toEqual([label]);
    const box = edgeLabelBox("Queues emails and courier bookings on");
    expect(box.lines).toHaveLength(2);
    expect(box.width).toBeLessThanOrEqual(edgeLabelWrapPx() + 2 * EDGE_LABEL_PAD_X);
  });

  it("never takes a third line: a caption that would is widened, and nothing is cut", () => {
    const text = "compiled model, diagnostics, selection and anything else that fits";
    const box = edgeLabelBox(text);
    expect(box.lines).toHaveLength(EDGE_LABEL_MAX_LINES);
    expect(box.lines.join(" ")).toBe(text);
    expect(box.width).toBeGreaterThan(edgeLabelWrapPx() + 2 * EDGE_LABEL_PAD_X);
    expect(box.height).toBe(EDGE_LABEL_MAX_LINES * EDGE_LABEL_LINE_PX + 2 * EDGE_LABEL_PAD_Y);
  });

  it("keeps an author's own line break, and folds breaks past the two-line cap into the wrap", () => {
    expect(edgeLabelBox("one\ntwo").lines).toEqual(["one", "two"]);
    expect(edgeLabelBox("one\ntwo\nthree").lines).toEqual(["one two three"]);
  });
});

describe("a caption with a C4 relationship's detail (decided 2026-10-31: shown inline, not behind an ⓘ)", () => {
  it("carries the label, technology and description, and reads back the same parts", () => {
    expect(captionWithDetail(undefined, undefined, undefined)).toBeUndefined();
    expect(captionWithDetail("Calls", undefined, undefined)).toBe("Calls");
    const caption = captionWithDetail("Calls", "HTTPS", "Every request")!;
    expect(captionParts(caption)).toEqual({ label: "Calls", technology: "HTTPS", description: "Every request" });
    expect(captionParts(captionWithDetail(undefined, "SQL", undefined)!)).toEqual({ label: "", technology: "SQL" });
    expect(captionParts("Plain caption")).toEqual({ label: "Plain caption" });
  });

  it("draws the technology in brackets on a row under the label, at the C4 type line's size, inside the plate", () => {
    const plain = edgeLabelBox("Calls");
    const box = edgeLabelBox(captionWithDetail("Calls", "JSON over HTTPS", undefined)!);
    expect(box.lines).toEqual(["Calls"]);
    expect(box.technology).toEqual(["[JSON over HTTPS]"]);
    expect(box.description).toEqual([]);
    expect(box.height).toBe(plain.height + EDGE_TECHNOLOGY_LINE_PX);
    expect(box.width).toBeGreaterThanOrEqual(estimateTextWidth("[JSON over HTTPS]", 11) + 2 * EDGE_LABEL_PAD_X);
  });

  it("wraps a long description to a bounded width, never cut, and reserves every row", () => {
    const text = "Opens a hosted payment session for each checkout and waits for its webhook";
    const box = edgeLabelBox(captionWithDetail("Pays through", "HTTPS", text)!);
    expect(box.description.length).toBeGreaterThan(1);
    expect(box.description.join(" ")).toBe(text);
    expect(box.width).toBeLessThanOrEqual(EDGE_DETAIL_WRAP_PX * 1.5);
    // Balanced, so the last row is not one stray word ("…to the / receipt").
    const short = edgeLabelBox(
      captionWithDetail("Browses", "HTTPS", "Every page of the shop, from search to the receipt")!,
    ).description;
    const widths = short.map((row) => estimateTextWidth(row, 12));
    expect(Math.min(...widths)).toBeGreaterThan(0.6 * Math.max(...widths));
    expect(box.height).toBe(
      box.lines.length * EDGE_LABEL_LINE_PX +
        EDGE_TECHNOLOGY_LINE_PX +
        box.description.length * EDGE_LABEL_LINE_PX +
        2 * EDGE_LABEL_PAD_Y,
    );
  });

  it("sizes the technology row as the C4 card's type line, which the plate's stylesheet repeats", async () => {
    const { C4_TYPE_FONT_PX, C4_TYPE_LINE_PX } = await import("../src/layout/figure-metrics");
    expect([EDGE_TECHNOLOGY_FONT_PX, EDGE_TECHNOLOGY_LINE_PX]).toEqual([C4_TYPE_FONT_PX, C4_TYPE_LINE_PX]);
    const css = (await import("node:fs")).readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rule = /\.archer-edge-label-technology \{([^}]*)\}/.exec(css)?.[1] ?? "";
    // Through its canvas token (redesign slice 8).
    expect(rule).toContain("font-size: var(--type-canvas-edge-detail);");
    expect(css).toMatch(new RegExp(`--type-canvas-edge-detail: ${EDGE_TECHNOLOGY_FONT_PX}px;`));
    expect(rule).toContain(`line-height: ${EDGE_TECHNOLOGY_LINE_PX}px`);
  });

  it("stands the detail alone when there is no label", () => {
    const box = edgeLabelBox(captionWithDetail(undefined, "SQL", undefined)!);
    expect(box.lines).toEqual([]);
    expect(box.technology).toEqual(["[SQL]"]);
    expect(box.height).toBe(EDGE_TECHNOLOGY_LINE_PX + 2 * EDGE_LABEL_PAD_Y);
  });
});

describe("a closed container's label keeps clear of its + (decided 2026-10-29)", () => {
  const label = "Backend (core): API, worker and the scheduler that feeds it";
  it("wraps in a narrower band, centred, and the box keeps the clearance on both sides", () => {
    const plain = nodeBox(label, "rectangle", []);
    const closed = nodeBox(label, "rectangle", [], undefined, true);
    expect(closed.lines.length).toBeGreaterThanOrEqual(plain.lines.length);
    expect((closed.width - closed.textWidth) / 2).toBeGreaterThanOrEqual(NEST_CONTROL_CLEAR_PX);
  });
  it("clears the drawn control at zoom 1: its inset, its size and a gap", () => {
    for (const corner of [4, 6, 12, 16])
      expect(NEST_CONTROL_CLEAR_PX).toBeGreaterThanOrEqual(
        closedToggleInset(1, corner) + TOGGLE_DRAWN_PX + TOGGLE_GAP_PX,
      );
  });
  it("leaves a short label's box as it was", () => {
    expect(nodeBox("API", "rectangle", [], undefined, true).width).toBe(nodeBox("API", "rectangle", []).width);
  });
});
