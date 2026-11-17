// @vitest-environment jsdom
//
// `useWalkFollow` (ADR 0034 §6): the live canvas is not moved while the old version covers it, and a
// walkthrough chosen before the nested layout exists still gets its recorded open set once it does.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";
import type { Walk } from "../src/walkthroughs/contract";
import { useWalkFollow, type WalkNest } from "../src/walkthroughs/use-walk-camera";
import type { Walkthroughs } from "../src/walkthroughs/use-walkthroughs";
import { playableOld } from "../src/walkthroughs/walk-stale";

const full: ProjectedView = {
  viewId: "shop",
  kind: "flowchart",
  title: "Shop",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "cust", label: "Customer", shape: undefined, classes: [], groupId: undefined },
    { id: "orders", label: "Orders", shape: undefined, classes: [], groupId: "api" },
  ],
  edges: [{ id: "e1", source: "cust", target: "orders", label: undefined }],
  groups: [{ id: "api", label: "Shop API", parentId: undefined }],
};
const walk: Walk = {
  id: "w",
  title: "W",
  modelRevision: "1",
  open: ["api"],
  status: "current",
  outOfDate: [],
  steps: [
    {
      id: "s1",
      title: "One",
      kind: "sends",
      what: "x",
      code: [],
      nodes: [{ kind: "node", id: "cust", label: "Customer" }],
      edges: [],
      messages: [],
      status: "current",
    },
  ],
};
const walkthroughs = (w: Walk): Walkthroughs =>
  ({
    state: { open: true, id: w.id, count: 1, step: 1, playing: false },
    walk: w,
    model: {
      nodes: new Set(full.nodes.map((n) => n.id).concat(full.groups.map((g) => g.id))),
      edges: new Set(full.edges.map((e) => e.id)),
      labels: new Map(),
    },
  }) as unknown as Walkthroughs;
const drawn = (open: readonly string[], press = 0) => ({ full, nested: nestView(full, open), press });

describe("useWalkFollow", () => {
  it("does not follow while the old version covers the live canvas", () => {
    const nest: WalkNest = { drawn: drawn([]), current: () => [], set: vi.fn(() => null), saved: () => null };
    const { result } = renderHook(() => useWalkFollow({ walkthroughs: walkthroughs(playableOld(walk)), full, nest }));
    expect(result.current.camera).toBeUndefined();
    expect(result.current.note).toBeNull();
    expect(nest.set).not.toHaveBeenCalled();
  });

  it("applies the recorded open set once the layout exists, when the walkthrough was chosen before it", () => {
    const set = vi.fn(() => 1);
    const base = { current: () => [] as readonly string[], set, saved: () => null as readonly string[] | null };
    const { rerender } = renderHook(
      ({ nest }: { nest: WalkNest }) => useWalkFollow({ walkthroughs: walkthroughs(walk), full, nest }),
      { initialProps: { nest: { ...base, drawn: null } as WalkNest } },
    );
    expect(set).not.toHaveBeenCalled();
    rerender({ nest: { ...base, drawn: drawn([]) } });
    expect((set.mock.calls[0] as unknown as [readonly string[]])[0]).toEqual(["api"]);
  });

  it("Back from the old version is not choosing the walkthrough again: Follow stays as the person left it", () => {
    const two: Walk = { ...walk, steps: [walk.steps[0]!, { ...walk.steps[0]!, id: "s2" }] };
    const nest: WalkNest = { drawn: drawn([]), current: () => [], set: vi.fn(() => null), saved: () => null };
    const at = (w: Walk, n: number): Walkthroughs =>
      ({ ...walkthroughs(w), state: { open: true, id: w.id, count: 2, step: n, playing: false } }) as Walkthroughs;
    const { result, rerender } = renderHook(
      ({ w }: { w: Walkthroughs }) => useWalkFollow({ walkthroughs: w, full, nest }),
      { initialProps: { w: at(two, 1) } },
    );
    act(() => result.current.setFollow(false));
    rerender({ w: at(playableOld(two), 1) });
    rerender({ w: at(playableOld(two), 2) });
    rerender({ w: at(two, 2) });
    rerender({ w: at(two, 1) });
    expect(result.current.follow).toBe(false);
  });
  it("the request names the current step's parts apart from the previous step's (a phone frames those alone, O95)", () => {
    const orders = { ...walk.steps[0]!, id: "s2", nodes: [{ kind: "node" as const, id: "orders", label: "Orders" }] };
    const two: Walk = { ...walk, steps: [walk.steps[0]!, orders] };
    const nest: WalkNest = {
      drawn: drawn(["api"]),
      current: () => ["api"],
      set: vi.fn(() => null),
      saved: () => ["api"],
    };
    const w = {
      ...walkthroughs(two),
      state: { open: true, id: two.id, count: 2, step: 2, playing: false },
    } as Walkthroughs;
    const { result } = renderHook(() => useWalkFollow({ walkthroughs: w, full, nest }));
    const request = result.current.camera?.request;
    expect(request?.nodeIds).toEqual(expect.arrayContaining(["cust", "orders"]));
    expect(request?.current?.nodeIds).toEqual(["orders"]);
  });
});
