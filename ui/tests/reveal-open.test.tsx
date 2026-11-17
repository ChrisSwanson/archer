// @vitest-environment jsdom
//
// J11-F1: an agent's emphasis (or presented focus) on parts inside a closed container opens the containers
// that hold them, once per emphasis: the person's own "−" afterwards holds until the agent shows something else.
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";
import { revealOpen, useRevealTargets } from "../src/nesting/reveal-open";

const full: ProjectedView = {
  viewId: "containers",
  kind: "c4",
  title: "Containers",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "customer", label: "Customer", shape: undefined, classes: [], groupId: undefined },
    { id: "web", label: "Storefront", shape: undefined, classes: [], groupId: "pageturner" },
    { id: "api", label: "Shop API", shape: undefined, classes: [], groupId: "pageturner" },
    { id: "db", label: "Shop database", shape: undefined, classes: [], groupId: "data" },
  ],
  edges: [
    { id: "web--api", source: "web", target: "api", label: undefined },
    { id: "api--db", source: "api", target: "db", label: undefined },
  ],
  groups: [
    { id: "pageturner", label: "Pageturner", parentId: undefined },
    { id: "data", label: "Data", parentId: "pageturner" },
  ],
};

describe("revealOpen", () => {
  it("opens what holds the targets, keeping what is open", () => {
    expect(revealOpen(full, [], { nodeIds: ["web", "api"], edgeIds: [] })).toEqual(["pageturner"]);
    expect(revealOpen(full, [], { nodeIds: [], edgeIds: ["api--db"] })).toEqual(["data", "pageturner"].sort());
  });
  it("is null when every target is already drawn as itself, or names nothing in the view", () => {
    expect(revealOpen(full, ["pageturner"], { nodeIds: ["web"], edgeIds: [] })).toBeNull();
    expect(revealOpen(full, [], { nodeIds: ["customer"], edgeIds: [] })).toBeNull();
    expect(revealOpen(full, [], { nodeIds: ["gone"], edgeIds: [] })).toBeNull();
  });
});

describe("useRevealTargets", () => {
  const drawn = (open: string[]) => ({ full, nested: nestView(full, open), press: 0 });
  it("opens once per target set; the person's close afterwards holds; a new set opens again", () => {
    let open: string[] = [];
    const set = vi.fn((next: readonly string[]) => {
      open = [...next];
      return 1;
    });
    const nest = () => ({ drawn: drawn(open), current: () => open, set });
    const { rerender } = renderHook(
      (p: { key: string | null; ids: { nodeIds: string[]; edgeIds: string[] } }) =>
        useRevealTargets({ ...p, nest: nest(), enabled: true }),
      { initialProps: { key: "e1", ids: { nodeIds: ["web", "api"], edgeIds: [] } } },
    );
    expect(set).toHaveBeenCalledTimes(1);
    expect(open).toEqual(["pageturner"]);
    open = []; // the person pressed "−"
    rerender({ key: "e1", ids: { nodeIds: ["web", "api"], edgeIds: [] } });
    expect(set).toHaveBeenCalledTimes(1);
    rerender({ key: "e2", ids: { nodeIds: ["db"], edgeIds: [] } });
    expect(set).toHaveBeenCalledTimes(2);
    expect(open).toEqual(["data", "pageturner"].sort());
  });
  it("waits for the nested drawing", () => {
    const set = vi.fn(() => 1);
    const { rerender } = renderHook(
      (p: { drawnOn: boolean }) =>
        useRevealTargets({
          key: "e1",
          ids: { nodeIds: ["web"], edgeIds: [] },
          enabled: true,
          nest: { drawn: p.drawnOn ? drawn([]) : null, current: () => [], set },
        }),
      { initialProps: { drawnOn: false } },
    );
    expect(set).not.toHaveBeenCalled();
    rerender({ drawnOn: true });
    expect(set).toHaveBeenCalledTimes(1);
  });
  it("what is shown while a walkthrough has the view opens nothing then or after it (the restored view wins)", () => {
    const set = vi.fn(() => 1);
    const { rerender } = renderHook(
      (p: { key: string; enabled: boolean }) =>
        useRevealTargets({
          key: p.key,
          ids: { nodeIds: ["web"], edgeIds: [] },
          enabled: p.enabled,
          nest: { drawn: drawn([]), current: () => [], set },
        }),
      { initialProps: { key: "e1", enabled: false } },
    );
    rerender({ key: "e1", enabled: true });
    expect(set).not.toHaveBeenCalled();
    rerender({ key: "e2", enabled: true });
    expect(set).toHaveBeenCalledTimes(1);
  });
});
