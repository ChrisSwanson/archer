/**
 * Where the nested view meets the page (ADR 0029 §3 table): its address, and the model ids the
 * page keeps (selection, focus, emphasis) translated to what is drawn and back. Pure.
 *
 * The page keeps everything in MODEL ids: a selection is published from the full view, so a
 * lifted end is never reported. Only what is handed to the canvas is translated.
 */
import type { ProjectedView } from "../diagrams/projection";
import type { Emphasis } from "../emphasis/contract";
import type { LayoutResult } from "../layout/elk-layout";
import type { DrawnKey, ModelKey, Nested } from "./nest-view";

export type NestMode = "nested" | "full";

/** The most `?open=` ids read; ids are model ids, `[A-Za-z0-9_-]` only. */
export const MAX_OPEN_IDS = 64;
const OPEN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `?zoom=nested|full` and `?open=a,b`, read when a diagram is opened. Anything else is ignored quietly. */
export function readNestAddress(search: string): { readonly zoom?: NestMode; readonly open: readonly string[] } {
  const query = new URLSearchParams(search);
  const zoom = query.get("zoom");
  const open = (query.get("open") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => OPEN_ID.test(id));
  return { ...(zoom === "nested" || zoom === "full" ? { zoom } : {}), open: [...new Set(open)].slice(0, MAX_OPEN_IDS) };
}

/** A model id as an element: a node when the view has one by that id, else a group. */
function modelKey(view: ProjectedView, id: string): ModelKey {
  return view.nodes.some((node) => node.id === id) ? { kind: "node", id } : { kind: "group", id };
}

/** Model node and edge ids → the drawn ones that stand for them (a box, a bundle, itself). */
export function drawnIds(
  nested: Nested,
  full: ProjectedView,
  ids: { readonly nodeIds?: readonly string[]; readonly edgeIds?: readonly string[] },
): { nodeIds: string[]; edgeIds: string[] } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const put = (drawn: DrawnKey | undefined): void => {
    if (drawn === undefined) return;
    (drawn.kind === "node" ? nodes : edges).add(drawn.id);
  };
  for (const id of ids.nodeIds ?? []) put(nested.drawnOf(modelKey(full, id)));
  for (const id of ids.edgeIds ?? []) put(nested.drawnOf({ kind: "edge", id }));
  return { nodeIds: [...nodes], edgeIds: [...edges] };
}

/** A drawn id the reader clicked → the model ids it stands for (a bundle: its members). */
export function modelIds(nested: Nested, kind: "node" | "edge", id: string): { nodeIds: string[]; edgeIds: string[] } {
  const keys = nested.modelOf({ kind, id });
  return {
    nodeIds: keys.filter((key) => key.kind !== "edge").map((key) => key.id),
    edgeIds: keys.filter((key) => key.kind === "edge").map((key) => key.id),
  };
}

/**
 * The agent's emphasis as the nested view draws it: each group's members moved to what stands
 * for them. A hidden edge inside a closed box colours the box. Two groups landing on one box or
 * bundle then share it, and the legend's One/All rule (ADR 0030) applies as on any view.
 */
export function nestEmphasis(
  emphasis: Emphasis | null | undefined,
  nested: Nested,
  full: ProjectedView,
): Emphasis | null {
  if (emphasis === null || emphasis === undefined) return null;
  return {
    ...emphasis,
    groups: emphasis.groups.map((group) => {
      const drawn = drawnIds(nested, full, { nodeIds: group.nodes, edgeIds: group.edges });
      // An edge hidden inside a box is drawn as that box.
      const viaEdges = group.edges.flatMap((id) => {
        const at = nested.drawnOf({ kind: "edge", id });
        return at?.kind === "node" ? [at.id] : [];
      });
      return { ...group, nodes: [...new Set([...drawn.nodeIds, ...viaEdges])], edges: drawn.edgeIds };
    }),
  };
}

/**
 * The order the prefetch lays opens out in, best first: the "+" the reader points at or focuses,
 * then boxes standing for an emphasised element, then by distance from the middle of the screen.
 */
export function prefetchOrder(
  layout: LayoutResult,
  options: {
    readonly hinted?: string | null;
    readonly emphasised?: ReadonlySet<string>;
    readonly centre?: { readonly x: number; readonly y: number };
  },
): string[] {
  const boxes = layout.nodes.flatMap((node) =>
    node.folded === undefined
      ? []
      : [{ groupId: node.folded.groupId, id: node.id, x: node.x + node.width / 2, y: node.y + node.height / 2 }],
  );
  const centre = options.centre ?? { x: layout.width / 2, y: layout.height / 2 };
  const rank = (box: (typeof boxes)[number]): number =>
    box.groupId === options.hinted ? 0 : options.emphasised?.has(box.id) === true ? 1 : 2;
  const distance = (box: (typeof boxes)[number]): number => Math.hypot(box.x - centre.x, box.y - centre.y);
  return boxes
    .sort((a, b) => rank(a) - rank(b) || distance(a) - distance(b) || a.groupId.localeCompare(b.groupId))
    .map((box) => box.groupId);
}
