// The nested view's invariants (docs/proposals/ws-b-boundary-zoom.md §3, item 7), on every
// graph fixture the compiler has golden output for, at every open set (or 64 drawn at
// random where there are too many to list).

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../../ts/src/mermaid/index";
import { envelopeFor, loadModelEnvelope } from "./fixtures";
import { projectGraph } from "./support/draw-envelope";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";

const FAMILIES = ["flowchart", "state", "c4", "architecture", "er"];
const cases = FAMILIES.flatMap((family) =>
  readdirSync(resolve(process.cwd(), "../ts/test/fixtures", family))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      name: `${family}/${file.slice(0, -5)}`,
      view: projectGraph(loadModelEnvelope(family, file.slice(0, -5))),
    })),
);

/**
 * A deep generated flowchart: three branches of four nested subgraphs, a node in each, edges
 * between the deepest nodes and to the top. More groups than can be listed, so it is sampled.
 */
async function deepView(): Promise<ProjectedView> {
  const lines = ["flowchart LR", "  top[Top]"];
  for (const branch of ["a", "b", "c"]) {
    for (let level = 1; level <= 4; level++)
      lines.push(
        `${"  ".repeat(level)}subgraph ${branch}${level}[${branch.toUpperCase()} ${level}]`,
        `${"  ".repeat(level + 1)}${branch}n${level}[${branch} ${level}]`,
      );
    for (let level = 4; level >= 1; level--) lines.push(`${"  ".repeat(level)}end`);
  }
  lines.push(
    "  an4 e1@--> bn4",
    "  bn4 e2@--> cn4",
    "  cn4 e3@-.-> an1",
    "  top e4@--> an4",
    "  an4 e5@--> top",
    "  bn2 e6@--> bn3",
    "  an4 e7@--> bn1",
  );
  const result = await compile(`${lines.join("\n")}\n`);
  if (result.model == null) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
  return projectGraph(envelopeFor(result.model as unknown as { type: string } & Record<string, unknown>, "deep"));
}
cases.push({ name: "generated/deep", view: await deepView() });

/** Mulberry32: integer-safe, so a failure names a set that reproduces. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every subset when there are few groups; always also 64 sets opened top-down, so they are reachable. */
function* openSets(view: ProjectedView): Generator<string[]> {
  const ids = view.groups.map((group) => group.id);
  if (ids.length <= 8)
    for (let mask = 0; mask < 1 << ids.length; mask++) yield ids.filter((_, index) => (mask >> index) & 1);
  const next = random(7);
  for (let draw = 0; draw < 64; draw++) {
    const open = new Set<string>();
    for (let round = 0; round < ids.length; round++) {
      const reachable = view.groups.filter(
        (g) => !open.has(g.id) && (g.parentId === undefined || open.has(g.parentId)),
      );
      if (reachable.length === 0 || next() < 0.25) break;
      open.add(reachable[Math.floor(next() * reachable.length)]!.id);
    }
    yield [...open];
  }
}

describe.each(cases)("$name", ({ view }) => {
  test("every open set keeps every edge exactly once and draws no dangling end", () => {
    for (const open of openSets(view)) {
      const nested = nestView(view, open);
      expect(nested.open).toEqual([...open].sort().filter((id) => nested.open.includes(id)));
      const drawnNodes = new Set(nested.view.nodes.map((node) => node.id));
      expect(drawnNodes.size, `duplicate node at ${open}`).toBe(nested.view.nodes.length);
      // An edge can end on an open frame (a transition to a composite state).
      const frames = new Set(
        nested.view.groups.map((group) => (group.element === true ? group.id : `group:${group.id}`)),
      );
      for (const edge of nested.view.edges) {
        expect(drawnNodes.has(edge.source) || frames.has(edge.source), `${edge.id} source at ${open}`).toBe(true);
        expect(drawnNodes.has(edge.target) || frames.has(edge.target), `${edge.id} target at ${open}`).toBe(true);
      }
      const keptGroups = new Set(nested.view.groups.map((group) => group.id));
      for (const node of nested.view.nodes) {
        if (node.groupId !== undefined)
          expect(keptGroups.has(node.groupId), `${node.id} in a hidden group at ${open}`).toBe(true);
      }
      for (const model of view.edges) {
        const drawnAsItself = nested.view.edges.some((edge) => edge.id === model.id) ? 1 : 0;
        const inBundles = [...nested.bundles.values()].filter((bundle) =>
          bundle.members.some((m) => m.id === model.id),
        ).length;
        const inBoxes = [...nested.closed.values()].filter((box) => box.hidden.some((m) => m.id === model.id)).length;
        expect(drawnAsItself + inBundles + inBoxes, `${model.id} at ${open}`).toBe(1);
        const drawn = nested.drawnOf({ kind: "edge", id: model.id })!;
        expect(nested.modelOf(drawn).some((key) => key.kind === "edge" && key.id === model.id) || inBoxes === 1).toBe(
          true,
        );
      }
      for (const bundle of nested.bundles.values()) expect(bundle.members.length).toBeGreaterThan(1);
    }
  });

  test("opening everything gives back the full view, and nothing open hides no top-level element", () => {
    expect(
      nestView(
        view,
        view.groups.map((group) => group.id),
      ).view,
    ).toEqual(view);
    const top = nestView(view, []);
    for (const node of view.nodes.filter((n) => n.groupId === undefined))
      expect(top.view.nodes.some((n) => n.id === node.id)).toBe(true);
  });
});
