// Adding and removing a source frame (ui/src/expand/frame-engine.ts, ADR 0036 A12), on the service's own
// captured menu answers (tests/fixtures/expand), the production ELK pipeline (elk.bundled), no worker.
// Boxes present before an addition keep their relative order; nothing overlaps; every fallback is counted;
// removing a frame returns the picture it was added to.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { projectEnvelope, type ProjectedView } from "../src/diagrams/projection";
import { computeLayout } from "../src/layout/elk-adapter";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";
import { FrameEngine, orderChanges, overlapsIn, type FrameBase } from "../src/expand/frame-engine";
import { combinedView, type Frame } from "../src/expand/frame-view";
import { projectPiece, readExpandMenu, type ExpandMenu } from "../src/expand/pieces";
import { framePartId } from "../../shared/explorations.mts";

const dir = new URL("./fixtures/expand/", import.meta.url);
const envelopes = JSON.parse(readFileSync(new URL("envelopes.json", dir), "utf8")) as Record<string, unknown>;
const menuOf = (name: string): ExpandMenu => readExpandMenu(JSON.parse(readFileSync(new URL(name, dir), "utf8")))!;

function viewOf(id: string): ProjectedView {
  const p = projectEnvelope(envelopes[id]);
  if (!p.ok || p.type !== "graph") throw new Error(`${id} does not project`);
  return p.view;
}

async function baseOf(id: string): Promise<FrameBase> {
  const view = viewOf(id);
  return { key: `${id}@1`, view, layout: await computeLayout(view, DEFAULT_TYPEFACE), typeface: DEFAULT_TYPEFACE };
}

function frameFrom(menu: ExpandMenu, source: string): Frame {
  const entry = menu.diagrams.items.find((d) => d.source === source)!;
  const piece = projectPiece(entry.piece!, entry.title)!;
  return {
    source,
    title: entry.title,
    proposed: entry.proposed === true,
    revision: entry.sourceRevision,
    pieces: [piece],
  };
}

const engine = () => new FrameEngine({ kernel: new ELK() });

describe("projecting a piece (O3, O6)", () => {
  test("a C4 piece projects in its own notation, its wire back to the element projected with it", () => {
    const menu = menuOf("menu-context-shop.json");
    const piece = projectPiece(menu.diagrams.items[0]!.piece!, "Containers")!;
    expect(piece.nodes.map((n) => n.id)).toEqual(["api", "db", "web"]);
    expect(piece.nodes.every((n) => n.groupId === undefined && n.figure?.type === "c4")).toBe(true);
    expect(piece.attach.map((e) => [e.source, e.target, e.label])).toEqual([["user", "web", "uses"]]);
  });

  test("the combined view draws an element once and keys a frame's parts by their source (A10)", async () => {
    const base = viewOf("context");
    const frame = frameFrom(menuOf("menu-context-shop.json"), "containers");
    const combined = combinedView(base, [frame]);
    expect(combined.view.groups.at(-1)).toMatchObject({ id: "xf~containers", label: "Containers" });
    expect(combined.view.nodes.filter((n) => n.groupId === "xf~containers").map((n) => n.id)).toEqual(
      ["api", "db", "web"].map((id) => framePartId("containers", id)),
    );
    expect(combined.parts.get(framePartId("containers", "web"))).toEqual({
      source: "containers",
      id: "web",
      kind: "node",
    });
    // The wire from the base's user to the frame's web.
    expect(combined.view.edges.some((e) => e.source === "user" && e.target === framePartId("containers", "web"))).toBe(
      true,
    );
    expect(combined.added).toEqual({ boxes: 3, wires: 3 });
  });
});

describe("the grow path (A12)", () => {
  test("adding a frame grows in place: order kept, no overlap, no fallback; removing returns the base picture", async () => {
    const base = await baseOf("context");
    const frames = engine();
    const frame = frameFrom(menuOf("menu-context-shop.json"), "containers");
    const added = await frames.layout(base, [frame]);
    expect(added.steps.map((s) => s.how)).toEqual(["grow"]);
    expect(orderChanges(base.layout, added.layout)).toBe(0);
    expect(overlapsIn(added.layout)).toBe(0);
    const group = added.layout.groups.find((g) => g.id === "xf~containers")!;
    const shop = added.layout.nodes.find((n) => n.id === "shop")!;
    // Beside the element, not around it.
    expect(
      group.x >= shop.x + shop.width ||
        group.y >= shop.y + shop.height ||
        group.x + group.width <= shop.x ||
        group.y + group.height <= shop.y,
    ).toBe(true);
    expect(added.layout.nodes.filter((n) => n.groupId === "xf~containers")).toHaveLength(3);
    const removed = await frames.layout(base, []);
    expect(removed.layout).toBe(base.layout);
    // Re-adding reuses the first way in.
    const again = await frames.layout(base, [frame]);
    expect(again.steps).toEqual([]);
    expect(again.layout).toBe(added.layout);
  });

  test("a second frame from inside the first grows beside its element; removing the first keeps the second's order", async () => {
    const base = await baseOf("context");
    const frames = engine();
    const first = frameFrom(menuOf("menu-context-shop.json"), "containers");
    const grown = menuOf("menu-context-api-grown.json");
    const second = frameFrom(grown, "notes/deploy.md#deploy");
    const one = await frames.layout(base, [first]);
    const two = await frames.layout(base, [first, second]);
    expect(two.steps.map((s) => s.how)).toEqual(["grow"]);
    expect(orderChanges(one.layout, two.layout)).toBe(0);
    expect(overlapsIn(two.layout)).toBe(0);
    const fallbacks = [...one.steps, ...two.steps].filter((s) => s.how === "fallback").length;
    expect(fallbacks).toBe(0);
    const left = await frames.layout(base, [second]);
    expect(left.steps.length).toBeGreaterThan(0);
    expect(left.layout.groups.some((g) => g.id === "xf~containers")).toBe(false);
  });

  test("an anchor that is not on the canvas falls back to seeded ELK, and the step says so", async () => {
    const base = await baseOf("context");
    const frame = frameFrom(menuOf("menu-context-api-grown.json"), "notes/deploy.md#deploy");
    const answer = await engine().layout(base, [frame]);
    expect(answer.steps).toMatchObject([{ how: "fallback", why: expect.stringMatching(/not a box on the canvas/) }]);
  });
});
