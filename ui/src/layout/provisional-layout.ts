// What the editor draws between an edit to a large graph and ELK's layout of
// it (perf #9: ELK took ~0.9 s per added shape on the 150-node flowchart, and
// the canvas showed nothing new until then). The last drawing, with the edit
// made in it: kept shapes and wires stay exactly where they were, a deleted
// one goes, an added top-level shape is placed clear of the drawing (a
// flowchart's editor gives it a position of its own anyway), and a new wire is
// drawn straight. ELK's layout replaces it when it answers, so what settles is
// what the reading page draws.
//
// Only changes it can draw faithfully: any group change, a kept shape whose
// box changes, or a shape added inside a group gets no provisional drawing.
import type { ProjectedView } from "../diagrams/projection";
import { figureBox } from "./figure-metrics";
import { nodeBox } from "./graph-metrics";
import type { LayoutEdge, LayoutNode, LayoutResult } from "./elk-layout";
import { DEFAULT_TYPEFACE, type TypefaceId } from "./text-measure";

/** Smaller graphs lay out in well under 100 ms: one drawing, not two. */
export const PROVISIONAL_MIN_ELEMENTS = 80;
/** More shapes and wires changed than this, and the last drawing is no guide. */
export const PROVISIONAL_MAX_CHANGES = 8;
/** Between the drawing and a shape added beside it (ELK's `componentComponent`). */
const BESIDE_GAP = 72;
/** Between two shapes added at once (ELK's `nodeNode`). */
const STACK_GAP = 56;

export type LaidOut = { readonly view: ProjectedView; readonly layout: LayoutResult };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sortedById = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** `next` drawn from `last` without ELK, or null when it cannot be drawn faithfully. */
export function provisionalLayout(
  last: LaidOut,
  next: ProjectedView,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): LayoutResult | null {
  const before = last.view;
  if (next.nodes.length + next.edges.length < PROVISIONAL_MIN_ELEMENTS) return null;
  if (before.kind !== next.kind || before.modelType !== next.modelType || before.notation !== next.notation)
    return null;
  if ((before.direction ?? "tb") !== (next.direction ?? "tb")) return null;
  if (!same(sortedById(before.groups), sortedById(next.groups))) return null;
  if ((last.layout.typeface ?? DEFAULT_TYPEFACE) !== typeface) return null;

  const projectedBefore = new Map(before.nodes.map((node) => [node.id, node]));
  const drawnBefore = new Map(last.layout.nodes.map((node) => [node.id, node]));
  const kept: LayoutNode[] = [];
  const added: ProjectedView["nodes"][number][] = [];
  let changes = 0;
  for (const node of next.nodes) {
    const old = projectedBefore.get(node.id);
    const drawn = drawnBefore.get(node.id);
    if (old !== undefined && drawn !== undefined) {
      if (!same(old, node)) return null;
      kept.push(drawn);
      continue;
    }
    if (node.groupId !== undefined || (node.figure?.type === "state" && node.figure.note !== undefined)) return null;
    added.push(node);
    changes++;
  }
  const nextIds = new Set(next.nodes.map((node) => node.id));
  changes += before.nodes.filter((node) => !nextIds.has(node.id)).length;

  const projectedEdgesBefore = new Map(before.edges.map((edge) => [edge.id, edge]));
  const drawnEdgesBefore = new Map(last.layout.edges.map((edge) => [edge.id, edge]));
  const edges: LayoutEdge[] = [];
  for (const edge of sortedById(next.edges)) {
    const old = projectedEdgesBefore.get(edge.id);
    const drawn = drawnEdgesBefore.get(edge.id);
    if (old !== undefined && drawn !== undefined && same(old, edge)) {
      edges.push(drawn);
      continue;
    }
    changes++;
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.caption ?? edge.label,
      ...(edge.line === undefined ? {} : { line: edge.line }),
      ...(edge.bidirectional === true ? { bidirectional: true } : {}),
      points: [],
      labelAnchor: undefined,
      ...(edge.figure === undefined ? {} : { figure: edge.figure }),
    });
  }
  const nextEdgeIds = new Set(next.edges.map((edge) => edge.id));
  changes += before.edges.filter((edge) => !nextEdgeIds.has(edge.id)).length;
  if (changes === 0 || changes > PROVISIONAL_MAX_CHANGES) return null;

  // Added shapes go after the drawing, across the flow: below one that runs
  // sideways, to the right of one that runs down.
  const direction = next.direction ?? "tb";
  const sideways = direction === "lr" || direction === "rl";
  let width = last.layout.width;
  let height = last.layout.height;
  let along = 0;
  const placed: LayoutNode[] = added.map((node) => {
    const box =
      node.figure === undefined
        ? nodeBox(node.label, node.shape, node.classes, typeface)
        : figureBox(node.figure, node.label, node.shape, direction, typeface);
    const x = sideways ? along : last.layout.width + BESIDE_GAP;
    const y = sideways ? last.layout.height + BESIDE_GAP : along;
    along += (sideways ? box.width : box.height) + STACK_GAP;
    width = Math.max(width, x + box.width);
    height = Math.max(height, y + box.height);
    return {
      id: node.id,
      x,
      y,
      width: box.width,
      height: box.height,
      label: node.label,
      shape: node.shape,
      classes: node.classes,
      groupId: undefined,
      ...(node.figure === undefined ? {} : { figure: node.figure }),
    };
  });

  const { heading: _heading, ...drawing } = last.layout;
  return {
    ...drawing,
    nodes: sortedById([...kept, ...placed]),
    edges,
    width,
    height,
    ...(next.heading === undefined ? {} : { heading: next.heading }),
  };
}
