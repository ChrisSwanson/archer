/**
 * React Flow needs every parent in the `nodes` array before its children.
 *
 * `adoptUserNodes` resolves a child's absolute position by looking its parent
 * up in the map it is filling as it walks the array, so a child that comes
 * first is placed as if it had no parent. The first draw hid that: nothing is
 * measured yet, so React Flow measures every node and then recomputes every
 * absolute position from the finished map. Every later array -- a focus, a
 * selection, an emphasis, the keyboard ring -- states its sizes as `measured`,
 * is not re-measured, and so is not repaired. Release review 2026-10-01, B3.
 *
 * Checked over generated group trees rather than one example, because the
 * defect only shows for a tree whose ids happen to sort child-first.
 */
import { describe, expect, it } from "vitest";
import { toXFlowNodes } from "../src/diagrams/xflow-adapter";
import type { LayoutGroup, LayoutNode, LayoutResult } from "../src/layout/elk-adapter";

/** A small deterministic generator: the same seed is the same tree. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * A forest of `count` groups with random parents and random ids, each holding
 * one node. Ids are drawn independently of depth, so about half the children
 * sort before their parent.
 */
function generatedLayout(seed: number, count: number): LayoutResult {
  const random = mulberry32(seed);
  const ids = new Set<string>();
  while (ids.size < count) {
    const length = 1 + Math.floor(random() * 3);
    let id = "";
    for (let i = 0; i < length; i += 1) id += LETTERS[Math.floor(random() * LETTERS.length)];
    ids.add(id);
  }
  const groups: LayoutGroup[] = [];
  for (const id of ids) {
    // A parent is picked among the groups already made, so the tree is acyclic.
    const parent = groups.length > 0 && random() < 0.75 ? groups[Math.floor(random() * groups.length)] : undefined;
    const origin = parent ?? { x: 0, y: 0 };
    groups.push({
      id,
      label: id,
      parentId: parent?.id,
      x: origin.x + 12 + Math.floor(random() * 40),
      y: origin.y + 12 + Math.floor(random() * 40),
      width: 400,
      height: 300,
    });
  }
  const nodes: LayoutNode[] = groups.map((group) => ({
    id: `n-${group.id}`,
    x: group.x + 10,
    y: group.y + 10,
    width: 120,
    height: 40,
    label: group.id,
    shape: undefined,
    classes: [],
    groupId: group.id,
  }));
  return { nodes, edges: [], groups, width: 2000, height: 2000 };
}

/** What React Flow computes as it walks the array: null where it cannot. */
function absolutePositions(layout: LayoutResult): Map<string, { x: number; y: number } | null> {
  const placed = new Map<string, { x: number; y: number } | null>();
  for (const node of toXFlowNodes(layout)) {
    if (node.parentId === undefined) {
      placed.set(node.id, node.position);
      continue;
    }
    const parent = placed.get(node.parentId);
    placed.set(
      node.id,
      parent === undefined || parent === null ? null : { x: parent.x + node.position.x, y: parent.y + node.position.y },
    );
  }
  return placed;
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe("the node array React Flow is given", () => {
  it("names every parent before any of its children, at any nesting depth", () => {
    let childFirstTrees = 0;
    let deepest = 0;
    for (const seed of SEEDS) {
      const layout = generatedLayout(seed, 2 + (seed % 9));
      const byId = new Map(layout.groups.map((group) => [group.id, group]));
      if (layout.groups.some((group) => group.parentId !== undefined && group.id < group.parentId)) {
        childFirstTrees += 1;
      }
      for (const group of layout.groups) {
        let depth = 0;
        for (let at = group; at.parentId !== undefined; at = byId.get(at.parentId)!) depth += 1;
        deepest = Math.max(deepest, depth);
      }

      const seen = new Set<string>();
      for (const node of toXFlowNodes(layout)) {
        if (node.parentId !== undefined) {
          expect(seen.has(node.parentId), `seed ${seed}: ${node.id} comes before its parent ${node.parentId}`).toBe(
            true,
          );
        }
        seen.add(node.id);
      }
      expect(seen.size, `seed ${seed}: every group and node is emitted once`).toBe(
        layout.groups.length + layout.nodes.length,
      );
    }
    // The generator has to produce the case the defect needs, or this proves nothing.
    expect(childFirstTrees).toBeGreaterThan(SEEDS.length / 2);
    expect(deepest).toBeGreaterThanOrEqual(4);
  });

  it("puts every group and node where the layout put it, resolved in array order", () => {
    for (const seed of SEEDS) {
      const layout = generatedLayout(seed, 2 + (seed % 9));
      const placed = absolutePositions(layout);
      for (const group of layout.groups) {
        expect(placed.get(`group:${group.id}`), `seed ${seed}: group ${group.id}`).toEqual({ x: group.x, y: group.y });
      }
      for (const node of layout.nodes) {
        expect(placed.get(node.id), `seed ${seed}: node ${node.id}`).toEqual({ x: node.x, y: node.y });
      }
    }
  });

  it("is in the same order however the layout lists its groups", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const layout = generatedLayout(seed, 2 + (seed % 9));
      const reversed: LayoutResult = {
        ...layout,
        groups: [...layout.groups].reverse(),
        nodes: [...layout.nodes].reverse(),
      };
      expect(toXFlowNodes(reversed).map((node) => node.id)).toEqual(toXFlowNodes(layout).map((node) => node.id));
    }
  });

  it("the review's case: `left` and `data` sort before the parents they are nested in", () => {
    const group = (id: string, parentId: string | undefined, x: number, y: number): LayoutGroup => ({
      id,
      label: id,
      parentId,
      x,
      y,
      width: 100,
      height: 100,
    });
    const layout: LayoutResult = {
      nodes: [],
      edges: [],
      groups: [group("left", "outer", 24, 24), group("outer", undefined, 12, 12), group("right", "outer", 200, 24)],
      width: 400,
      height: 200,
    };
    expect(toXFlowNodes(layout).map((node) => node.id)).toEqual(["group:outer", "group:left", "group:right"]);
  });

  it("a group naming a parent the layout does not hold is drawn at its own place, not dropped", () => {
    const layout: LayoutResult = {
      nodes: [],
      edges: [],
      groups: [{ id: "orphan", label: "Orphan", parentId: "gone", x: 30, y: 40, width: 100, height: 100 }],
      width: 200,
      height: 200,
    };
    const [node] = toXFlowNodes(layout);
    expect(node.parentId).toBeUndefined();
    expect(node.position).toEqual({ x: 30, y: 40 });
  });
});
