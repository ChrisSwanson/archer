// The nested view's layout engine (ui/src/nesting/nest-engine.ts): every open set reached from
// the base by grow in place v2, kept so a return shows the same picture, a deep link laid out in
// one fixed order, presses prefetched one step ahead, and the seeded ELK relayout only when grow
// in place refuses. Real diagrams, the production ELK pipeline (elk.bundled), no worker.

import { describe, expect, test } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutResult } from "../src/layout/elk-layout";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";
import { growthRecords } from "../src/nesting/grow-in-place-v2";
import { chainOrder, NestEngine, type NestEngineDependencies } from "../src/nesting/nest-engine";
import { routeOrthogonalJs } from "../src/nesting/ortho-router";
import { enclosureFaults, viewOf } from "./support/nest-strategies";

const NESTED = "ts/test/fixtures/c4/nested.mmd"; // shop > api
const BOUNDARIES = "tools/devkit/corpus/awkward/.archer/diagrams/c4-boundaries.mmd"; // corp > ops, shop
const COMPONENTS = ".archer/diagrams/service/application-components.mmd"; // five top-level groups

/** A kernel that counts the ELK runs it is asked for. */
function counted(extra: Partial<NestEngineDependencies> = {}) {
  const elk = new ELK();
  const state = { calls: 0, hangNext: false };
  const engine = new NestEngine({
    kernel: {
      layout(graph: ElkNode) {
        state.calls++;
        if (state.hangNext) {
          state.hangNext = false;
          return new Promise<ElkNode>(() => undefined);
        }
        return elk.layout(graph);
      },
    },
    ...extra,
  });
  return { engine, state };
}

const spec = (full: ProjectedView) => ({ full, typeface: DEFAULT_TYPEFACE, revision: "r1" });
const rects = (layout: LayoutResult) =>
  new Map<string, { x: number; y: number; width: number; height: number }>([
    ...layout.nodes.map((n) => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height }] as const),
    ...layout.groups.map((g) => [`group:${g.id}`, { x: g.x, y: g.y, width: g.width, height: g.height }] as const),
  ]);

/** Every box and frame the view draws is there, and every frame encloses its contents. */
function expectWhole(layout: LayoutResult, full: ProjectedView, open: string[]): void {
  const view = nestView(full, open).view;
  expect(layout.nodes.map((n) => n.id).sort()).toEqual(view.nodes.map((n) => n.id).sort());
  expect(layout.groups.map((g) => g.id).sort()).toEqual(view.groups.map((g) => g.id).sort());
  expect(enclosureFaults(layout, view)).toBe(0);
}

describe("nest engine", () => {
  test("the base is the plain layout of the view with nothing open", async () => {
    const full = await viewOf(NESTED);
    const { engine } = counted();
    const key = engine.open(spec(full));
    const work = engine.layout(key, []);
    expect(await work.how).toBe("base");
    expect(await work.complete).toEqual(await computeLayout(nestView(full, []).view));
    expect(await work.first).toBe(await work.complete);
  });

  test("a press grows in place: first has every box final, complete adds the routes", async () => {
    const full = await viewOf(NESTED);
    const { engine } = counted();
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    const work = engine.layout(key, ["shop"], { from: [], toggled: "shop" });
    const [first, complete] = [await work.first, await work.complete];
    expect(await work.how).toBe("grow");
    // Every box exactly where `complete` has it: the page swaps the routed wires in under boxes
    // that do not move (`finish` in grow-in-place-v2.ts shifts by boxes only).
    const a = rects(first);
    const b = rects(complete);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [id, r] of a) expect(r, id).toEqual(b.get(id));
    expectWhole(complete, full, ["shop"]);
    expect(growthRecords(complete).has("shop")).toBe(true);
  });

  test("returning to an open set shows the identical layout", async () => {
    const full = await viewOf(NESTED);
    const { engine, state } = counted();
    const key = engine.open(spec(full));
    const base = await engine.layout(key, []).complete;
    const shop = await engine.layout(key, ["shop"], { from: [], toggled: "shop" }).complete;
    const both = await engine.layout(key, ["shop", "api"], { from: ["shop"], toggled: "api" }).complete;
    const calls = state.calls;
    const back = engine.layout(key, [], { from: ["api", "shop"], toggled: "shop" });
    expect(await back.complete).toBe(base);
    expect(await back.how).toBe("cache");
    expect(await engine.layout(key, ["shop"], { from: [], toggled: "shop" }).complete).toBe(shop);
    expect(await engine.layout(key, ["api", "shop"]).complete).toBe(both);
    expect(state.calls).toBe(calls);
  });

  test("closing a box not yet seen closed compacts by its growth record and keeps the others'", async () => {
    const full = await viewOf(COMPONENTS);
    const { engine } = counted();
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    await engine.layout(key, ["core"], { from: [], toggled: "core" }).complete;
    const open = await engine.layout(key, ["core", "service"], { from: ["core"], toggled: "service" }).complete;
    expect([...growthRecords(open).keys()].sort()).toEqual(["core", "service"]);
    const work = engine.layout(key, ["service"], { from: ["core", "service"], toggled: "core" });
    const closed = await work.complete;
    expect(await work.how).toBe("close");
    expect(await work.first).toBe(closed);
    expect([...growthRecords(closed).keys()]).toEqual(["service"]);
    expectWhole(closed, full, ["service"]);
  });

  test("a deep link opens parents first, in one fixed order, so two viewers see the same picture", async () => {
    const full = await viewOf(BOUNDARIES);
    const a = counted();
    const b = counted();
    const ka = a.engine.open(spec(full));
    const kb = b.engine.open(spec(full));
    const link = ["shop", "ops", "corp"];
    const work = a.engine.layout(ka, link);
    const one = await work.complete;
    expect(await work.how).toBe("chain");
    const two = await b.engine.layout(kb, [...link].reverse()).complete;
    expect(two).toEqual(one);
    expectWhole(one, full, link);
    // The way there was corp, then corp + ops, then all three: each is kept.
    const calls = a.state.calls;
    const corp = a.engine.layout(ka, ["corp"]);
    expect(await corp.how).toBe("cache");
    const corpOps = a.engine.layout(ka, ["corp", "ops"]);
    expect(await corpOps.how).toBe("cache");
    expect(a.state.calls).toBe(calls);
    expect([...growthRecords(one).keys()].sort()).toEqual(["corp", "ops", "shop"]);
  });

  test("a prefetched press is answered from the prefetch, with no layout work", async () => {
    const full = await viewOf(COMPONENTS);
    const { engine, state } = counted();
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    await engine.prefetch(key, [], ["service", "core"]);
    const calls = state.calls;
    const work = engine.layout(key, ["core"], { from: [], toggled: "core" });
    const pressed = await work.complete;
    expect(await work.how).toBe("prefetch");
    expect(await work.first).toBe(pressed);
    expect(state.calls).toBe(calls);
    expectWhole(pressed, full, ["core"]);
    // Promoted: the next request for it is the cache, the same object.
    const again = engine.layout(key, ["core"], { from: [], toggled: "core" });
    expect(await again.how).toBe("cache");
    expect(await again.complete).toBe(pressed);
  });

  test("a press preempts a prefetch chunk: the press is routed before the chunk's wires", async () => {
    const full = await viewOf(COMPONENTS);
    const elk = new ELK();
    const routed: string[] = [];
    let held: (() => void) | null = null;
    let holdNext = false;
    const engine = new NestEngine({
      kernel: {
        layout(graph: ElkNode) {
          if (!holdNext) return elk.layout(graph);
          holdNext = false;
          return new Promise<ElkNode>((resolve, reject) => {
            held = () => {
              elk.layout(graph).then(resolve, reject);
            };
          });
        },
      },
      route: (request) => {
        routed.push(
          (request.frames ?? [])
            .map((f) => f.id)
            .sort()
            .join(","),
        );
        return routeOrthogonalJs(request);
      },
    });
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    routed.length = 0;
    holdNext = true;
    const prefetch = engine.prefetch(key, [], ["core"]);
    // The chunk is inside its ELK run (the inside of core) when the press arrives.
    await expect.poll(() => held !== null).toBe(true);
    held!();
    const press = engine.layout(key, ["service"], { from: [], toggled: "service" });
    await press.complete;
    const beforePressDone = [...routed];
    await prefetch;
    expect(
      beforePressDone.some((frames) => frames.split(",").includes("group:core")),
      `routed before the press was done: ${beforePressDone.join(" | ")}`,
    ).toBe(false);
    // The chunk still finished after the press: pressing core is answered from it.
    expect(await engine.layout(key, ["core"], { from: [], toggled: "core" }).how).toBe("prefetch");
  });

  test("prefetch goes one step ahead only, never from a prefetched layout", async () => {
    const full = await viewOf(NESTED);
    const { engine, state } = counted();
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    await engine.prefetch(key, [], ["shop"]);
    const calls = state.calls;
    await engine.prefetch(key, ["shop"], ["api"]);
    expect(state.calls).toBe(calls);
  });

  test("cancelPrefetch drops the queued candidates", async () => {
    const full = await viewOf(COMPONENTS);
    const { engine, state } = counted();
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    const calls = state.calls;
    const queued = engine.prefetch(key, [], ["core", "service", "doors"]);
    engine.cancelPrefetch();
    await queued;
    expect(state.calls).toBe(calls);
    const work = engine.layout(key, ["core"], { from: [], toggled: "core" });
    await work.complete;
    expect(await work.how).toBe("grow");
  });

  test("a newer prefetch list replaces the queued one", async () => {
    const full = await viewOf(COMPONENTS);
    const { engine } = counted();
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    const old = engine.prefetch(key, [], ["core", "service"]);
    const newer = engine.prefetch(key, [], ["doors"]);
    await Promise.all([old, newer]);
    expect(await engine.layout(key, ["doors"], { from: [], toggled: "doors" }).how).toBe("prefetch");
    expect(await engine.layout(key, ["service"], { from: [], toggled: "service" }).how).toBe("grow");
  });

  test("dropPrefetched forgets the prefetched presses and keeps the open sets", async () => {
    const full = await viewOf(COMPONENTS);
    const { engine } = counted();
    const key = engine.open(spec(full));
    const base = await engine.layout(key, []).complete;
    await engine.prefetch(key, [], ["core"]);
    engine.dropPrefetched();
    const work = engine.layout(key, ["core"], { from: [], toggled: "core" });
    await work.complete;
    expect(await work.how).toBe("grow");
    expect(await engine.layout(key, []).complete).toBe(base);
  });

  test("a grow that throws falls back to the seeded relayout, still sound", async () => {
    const full = await viewOf(NESTED);
    const { engine } = counted({
      route: () => {
        throw new Error("router refused");
      },
    });
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    const work = engine.layout(key, ["shop"], { from: [], toggled: "shop" });
    const laid = await work.complete;
    expect(await work.how).toBe("fallback");
    expectWhole(laid, full, ["shop"]);
    expect(laid.edges.every((edge) => edge.points.length >= 2)).toBe(true);
    // Kept like any other way in.
    expect(await engine.layout(key, ["shop"]).complete).toBe(laid);
  });

  test("a grow past its deadline falls back", async () => {
    const full = await viewOf(NESTED);
    const { engine, state } = counted({ deadlineMs: 50 });
    const key = engine.open(spec(full));
    await engine.layout(key, []).complete;
    state.hangNext = true;
    const work = engine.layout(key, ["shop"], { from: [], toggled: "shop" });
    expectWhole(await work.complete, full, ["shop"]);
    expect(await work.how).toBe("fallback");
  });

  test("sessions are kept by revision and content; an unknown one is refused by name", async () => {
    const full = await viewOf(NESTED);
    const { engine } = counted();
    const key = engine.open(spec(full));
    expect(engine.has(key)).toBe(true);
    expect(engine.open({ ...spec(full), revision: "r2" })).not.toBe(key);
    expect(() => engine.layout("nope", [])).toThrow(/unknown session/);
  });
});

test("a deep link's order is worked out once: 400 groups in well under a second", () => {
  const groups = Array.from({ length: 400 }, (_, i) => ({
    id: `g${i}`,
    label: `G${i}`,
    parentId: i < 200 ? undefined : `g${i - 200}`,
  }));
  const full = {
    viewId: "v",
    kind: "flowchart",
    title: "v",
    revision: "1",
    modelType: "freeform-graph",
    nodes: [],
    edges: [],
    groups,
  } as unknown as Parameters<typeof chainOrder>[0];
  const started = performance.now();
  const order = chainOrder(
    full,
    groups.map((g) => g.id),
  );
  expect(performance.now() - started).toBeLessThan(250);
  expect(order.indexOf("g0")).toBeLessThan(order.indexOf("g200"));
});
