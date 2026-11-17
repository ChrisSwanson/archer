// A frame's caption keeps air from every wire, in the whole drawing (ELK and the route simplifier) and in the
// nested view's grow (its own router), on real diagrams. Rendered review, 2026-11-13: captions came to rest 4 to 7
// graph units from a line, which at a fit zoom reads as the words touching it ("Design Together, Live" against
// "Looks right"; "Living Knowledge Base" against "Next question").
import { describe, expect, test } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutResult } from "../src/layout/elk-layout";
import { nestView } from "../src/nesting/nest-view";
import { growInPlaceV2 } from "../src/nesting/grow-in-place-v2";
import { newProfile } from "../src/nesting/profile";
import { chainOrder } from "../src/nesting/nest-engine";
import { viewOf } from "./support/nest-strategies";

/** The air a caption keeps from a wire, in graph units: see `group-captions.test.ts`. */
const CAPTION_AIR = 10;

/** Each caption's nearest wire: the shortest distance from its box to any run of any wire. */
function nearestWires(layout: LayoutResult): { group: string; edge: string; gap: number }[] {
  return layout.groups.flatMap((group) => {
    const c = group.caption;
    if (c === undefined) return [];
    let nearest = { edge: "", gap: Number.POSITIVE_INFINITY };
    for (const edge of layout.edges)
      for (let i = 1; i < edge.points.length; i += 1) {
        const a = edge.points[i - 1]!;
        const b = edge.points[i]!;
        const dx = Math.max(c.x - Math.max(a.x, b.x), Math.min(a.x, b.x) - (c.x + c.width), 0);
        const dy = Math.max(c.y - Math.max(a.y, b.y), Math.min(a.y, b.y) - (c.y + c.height), 0);
        const gap = Math.hypot(dx, dy);
        if (gap < nearest.gap) nearest = { edge: edge.id, gap };
      }
    return [{ group: group.id, ...nearest }];
  });
}

const SOURCES = [
  "ts/test/fixtures/c4/nested.mmd",
  "tools/devkit/corpus/pageturner/.archer/diagrams/containers.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/state-composite.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/c4-boundaries.mmd",
];

describe("a frame's caption keeps air from every wire", () => {
  test.each(SOURCES)("%s, drawn whole", async (path) => {
    const layout = await computeLayout(await viewOf(path));
    for (const near of nearestWires(layout))
      expect(near.gap, `${near.group}'s caption beside ${near.edge}`).toBeGreaterThanOrEqual(CAPTION_AIR);
  });

  test.each(SOURCES)(
    "%s, every frame opened in the nested view",
    async (path) => {
      const full = await viewOf(path);
      const base = nestView(full, []).view;
      let laid = { view: base, layout: await computeLayout(base) };
      const open: string[] = [];
      for (const id of chainOrder(
        full,
        full.groups.map((g) => g.id),
      )) {
        open.push(id);
        const view = nestView(full, open).view;
        const layout = await growInPlaceV2(laid, view, id, {
          layout: (v) => computeLayout(v),
          profile: newProfile(),
          bundle: false,
        });
        laid = { view, layout };
      }
      for (const near of nearestWires(laid.layout))
        expect(near.gap, `${near.group}'s caption beside ${near.edge}`).toBeGreaterThanOrEqual(CAPTION_AIR);
    },
    60_000,
  );
});
