// Node proportions after the owner's references ("the loop", "the home rig"; redesign slice 4): a bold title over a
// full-ink description, generous padding, boxes wide enough that a long description takes two or three lines rather
// than four, and peers in one panel at one width. The outermost neutral panel names itself top-right, as the home
// rig's server boundary does; panels inside it name themselves top-left.
import { describe, expect, it } from "vitest";
import { paintNode } from "../src/export/svg";
import { computeLayout } from "../src/layout/elk-adapter";
import { FRAME_CAPTION_INSET, edgeObstacles } from "../src/layout/captions";
import { NODE_DESCRIPTION_FONT_PX, NODE_TITLE_FONT_PX, nodeBox } from "../src/layout/graph-metrics";
import { HOME_RIG, SHIP_LOOP, viewOf } from "./fixtures/palette/home-rig";
import { nestView } from "../src/nesting/nest-view";
import { chainOrder } from "../src/nesting/nest-engine";
import { growInPlaceV2 } from "../src/nesting/grow-in-place-v2";
import { frameToggleRect } from "../src/nesting/toggle-place";

type Box = { x: number; y: number; width: number; height: number };
const overlapsBox = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const label = (title: string, description: string) => `${title}\n${description}`;

describe("a node's box", () => {
  it("keeps generous room round its words: 24px each side, 16px above and below", () => {
    const box = nodeBox(
      label("5. Build", "An AI works alone in a fresh, throwaway container, 45 minutes max"),
      "rectangle",
      [],
    );
    expect(box.width - box.textWidth).toBeGreaterThanOrEqual(48);
    expect(box.height - box.textHeight).toBeGreaterThanOrEqual(32);
  });

  it("wraps the loop's longest descriptions into two or three lines, in a box no wider than the reference's", async () => {
    const view = await viewOf(SHIP_LOOP);
    for (const node of view.nodes) {
      const box = nodeBox(node.label, node.shape, node.classes);
      const description = box.lines.length - box.titleRows;
      expect(description, node.id).toBeLessThanOrEqual(3);
      expect(box.width, node.id).toBeLessThanOrEqual(400);
    }
    // "6. Check the Work" took four lines in the old 236px box.
    const check = view.nodes.find((node) => node.id === "check")!;
    const box = nodeBox(check.label, check.shape, check.classes);
    expect(box.lines.length - box.titleRows).toBe(2);
  });

  it("sets the title a clear step larger than the description", () => {
    expect(NODE_TITLE_FONT_PX / NODE_DESCRIPTION_FONT_PX).toBeGreaterThanOrEqual(1.15);
  });
});

describe("peers share a width", () => {
  it("draws the described nodes of one panel that are near one width at that width", async () => {
    const layout = await computeLayout(await viewOf(SHIP_LOOP));
    const described = layout.nodes.filter((node) => node.label.includes("\n"));
    const widest = Math.max(...described.map((node) => node.width));
    const near = described.filter((node) => nodeBox(node.label, node.shape, node.classes).width >= 0.75 * widest);
    expect(near.length).toBeGreaterThan(3);
    for (const node of near) expect(node.width, node.id).toBe(widest);
    // A title-only node keeps its own size.
    const dropped = layout.nodes.find((node) => node.id === "dropped")!;
    expect(dropped.width).toBeLessThan(widest);
  });

  it("never narrows a box below what its own words need", async () => {
    const layout = await computeLayout(await viewOf(HOME_RIG));
    for (const node of layout.nodes) {
      if (node.figure !== undefined) continue;
      expect(node.width, node.id).toBeGreaterThanOrEqual(nodeBox(node.label, node.shape, node.classes).width);
    }
  });
});

describe("group captions", () => {
  it("puts the outermost neutral panel's caption at its top right, and a nested panel's at its top left", async () => {
    const layout = await computeLayout(await viewOf(HOME_RIG));
    const outer = layout.groups.filter((group) => group.parentId === undefined);
    const nested = layout.groups.filter((group) => group.parentId !== undefined);
    expect(outer.length).toBeGreaterThan(0);
    expect(nested.length).toBeGreaterThan(0);
    const obstacles = [...edgeObstacles(layout.edges), ...layout.nodes];
    for (const group of outer) {
      const caption = group.caption!;
      // The rightmost run of the band no wire, arrowhead or caption crosses: the corner itself when it is free.
      expect(caption.x + caption.width / 2, group.id).toBeGreaterThan(group.x + group.width / 2);
      const rightOf = { ...caption, x: caption.x + 2 };
      const corner = caption.x + caption.width >= group.x + group.width - FRAME_CAPTION_INSET.x - 2;
      expect(corner || obstacles.some((box) => overlapsBox(box, rightOf)), group.id).toBe(true);
    }
    for (const group of nested) {
      const caption = group.caption!;
      // The leftmost run of the band no wire, arrowhead or caption crosses: the home inset itself when it is free.
      // (It was "in the left half"; with the caption's 10 units of air from a wire, gpu2's -- a wire crosses its band
      // 204 in, and the caption is 195 wide -- is first free just past the middle, at 214 of 425.)
      const leftOf = { ...caption, x: caption.x - 2 };
      const home = caption.x <= group.x + FRAME_CAPTION_INSET.x + 2;
      expect(home || obstacles.some((box) => overlapsBox(box, leftOf)), group.id).toBe(true);
    }
  });
});

describe("the outer caption, whole and opened in place", () => {
  it("sits at the top right clear of the frame's \u2212 in the whole drawing and when opened in place", async () => {
    const full = await viewOf(HOME_RIG);
    const whole = await computeLayout(full);
    let laid = { view: nestView(full, []).view, layout: await computeLayout(nestView(full, []).view) };
    const open: string[] = [];
    for (const id of chainOrder(full, ["server", "farm", "k8s", "gpu1", "gpu2"])) {
      open.push(id);
      const view = nestView(full, open).view;
      laid = { view, layout: await growInPlaceV2(laid, view, id, { layout: (v) => computeLayout(v) }) };
    }
    for (const layout of [whole, laid.layout]) {
      const server = layout.groups.find((group) => group.id === "server")!;
      const caption = server.caption!;
      expect(caption.x + caption.width / 2, "right half").toBeGreaterThan(server.x + server.width / 2);
      expect(overlapsBox(caption, frameToggleRect(server)), "clear of the \u2212").toBe(false);
      // A nested panel's caption stays at the left.
      const farm = layout.groups.find((group) => group.id === "farm")!;
      expect(farm.caption!.x - farm.x).toBeLessThan(farm.width / 2);
    }
  }, 120_000);
});

describe("a flowchart person", () => {
  it("has no 'Person' kicker row: a small glyph beside its title, and its box is no taller than a plain node's", () => {
    const plain = nodeBox(label("You", "A laptop or a phone"), "rectangle", []);
    const person = nodeBox(label("You", "A laptop or a phone"), "rectangle", ["person"]);
    expect(person.height).toBe(plain.height);
    expect(person.width).toBeGreaterThanOrEqual(plain.width);
  });

  it("exports the glyph beside the title and no kind word", () => {
    const text = label("You", "A laptop or a phone");
    const box = nodeBox(text, "rectangle", ["person"]);
    const svg = paintNode(
      {
        id: "you",
        label: text,
        x: 0,
        y: 0,
        width: box.width,
        height: box.height,
        shape: "rectangle",
        classes: ["person"],
        groupId: undefined,
      },
      { nodes: [], edges: [], groups: [], width: 400, height: 200 },
    );
    expect(svg).not.toContain(">PERSON<");
    expect(svg).toMatch(/<circle/);
  });
});
