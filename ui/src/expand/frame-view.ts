/**
 * A grown canvas (ADR 0036 §12–§13, A10, O6, O7): the base view with each source's frame as a group of
 * its pieces' boxes. Pure, so the page (selection, comments, labels) and the layout worker (placement)
 * build the same view from the same frames.
 *
 * Identity (A10): a frame is the group `xf~<source>`; its boxes and wires are `xf~<source>~/<local id>`,
 * so a local id that two views both use never collides on the canvas. An element already drawn (the
 * base first, then frames in order of addition) is drawn once, and a wire to it goes to that box (O6).
 * A wire between two boxes the canvas already joins is not drawn again.
 */
import type { ProjectedEdge, ProjectedNode, ProjectedView } from "../diagrams/projection";
import { frameIdOf, framePartId } from "../../../shared/explorations.mts";

/** One piece as the page projected it: boxes and inside wires in the source's ids, and the wires back. */
export type FramePiece = {
  /** The element the piece was cut for. */
  readonly touches: string;
  readonly nodes: readonly ProjectedNode[];
  readonly edges: readonly ProjectedEdge[];
  /** Wires from the piece to boxes already on the canvas, in source ids. */
  readonly attach: readonly ProjectedEdge[];
};

export type Frame = {
  readonly source: string;
  readonly title: string;
  readonly proposed: boolean;
  /** The source's revision the pieces were cut from. */
  readonly revision: string;
  /** In order of addition; the first one's element is where the frame is placed. */
  readonly pieces: readonly FramePiece[];
};

export const frameGroupId = (frame: Frame): string => frameIdOf(frame.source);
/** The frame's first element: the frame is placed beside it. */
export const frameAnchor = (frame: Frame): string => frame.pieces[0]!.touches;

/** What a frame's layout depends on: its source, revision and every part, so a cached layout is reused only for the same frame. */
export function frameKey(frame: Frame): string {
  return JSON.stringify([
    frame.source,
    frame.revision,
    frame.proposed,
    frame.title,
    frame.pieces.map((p) => [p.touches, p.nodes.map((n) => n.id), p.edges.map((e) => e.id), p.attach.map((e) => e.id)]),
  ]);
}

export const framesKey = (frames: readonly Frame[]): string => JSON.stringify(frames.map(frameKey));

const pair = (a: string, b: string): string => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

export type Combined = {
  readonly view: ProjectedView;
  /** Model id → the canvas id drawing it. */
  readonly drawn: ReadonlyMap<string, string>;
  /** Canvas id of a frame's box or wire → (source, local id): what a comment or a selection names (A10). */
  readonly parts: ReadonlyMap<string, { readonly source: string; readonly id: string; readonly kind: "node" | "edge" }>;
  /** Boxes and wires the frames add, over all frames: what the limit counts (O4). */
  readonly added: { readonly boxes: number; readonly wires: number };
};

/** The base view with `frames` added, in order. */
export function combinedView(base: ProjectedView, frames: readonly Frame[]): Combined {
  const drawn = new Map<string, string>();
  for (const n of base.nodes) drawn.set(n.id, n.id);
  for (const g of base.groups) drawn.set(g.id, `group:${g.id}`);
  // A wire to a closed box of the nested view goes to the box drawing it.
  for (const n of base.nodes)
    if (n.folded !== undefined && !drawn.has(n.folded.groupId)) drawn.set(n.folded.groupId, n.id);
  const nodes: ProjectedNode[] = [...base.nodes];
  const edges: ProjectedEdge[] = [...base.edges];
  const groups = [...base.groups];
  const parts = new Map<string, { source: string; id: string; kind: "node" | "edge" }>();
  const pairs = new Set(base.edges.map((e) => pair(e.source, e.target)));
  let boxes = 0,
    wires = 0;
  const endOf = (id: string): string | undefined => {
    const at = drawn.get(id);
    // A group is wired to as its frame: the canvas draws `group:<id>`, the layout knows the group's own id.
    return at?.startsWith("group:") === true ? at.slice("group:".length) : at;
  };
  for (const frame of frames) {
    const id = frameGroupId(frame);
    // Inside the frame of the base that holds its element; a frame anchored in another frame is top level.
    const at = frameAnchor(frame);
    const parentId = base.nodes.find((n) => n.id === at)?.groupId ?? base.groups.find((g) => g.id === at)?.parentId;
    groups.push({ id, label: frame.title, parentId });
    for (const piece of frame.pieces) {
      for (const n of piece.nodes) {
        if (drawn.has(n.id)) continue;
        const canvasId = framePartId(frame.source, n.id);
        drawn.set(n.id, canvasId);
        parts.set(canvasId, { source: frame.source, id: n.id, kind: "node" });
        nodes.push({ ...n, id: canvasId, groupId: id });
        boxes++;
      }
    }
    for (const piece of frame.pieces) {
      for (const e of [...piece.edges, ...piece.attach]) {
        const s = endOf(e.source),
          t = endOf(e.target);
        if (s === undefined || t === undefined || s === t) continue;
        const key = pair(s, t);
        if (pairs.has(key)) continue;
        pairs.add(key);
        const canvasId = framePartId(frame.source, e.id);
        if (parts.has(canvasId)) continue;
        parts.set(canvasId, { source: frame.source, id: e.id, kind: "edge" });
        edges.push({ ...e, id: canvasId, source: s, target: t });
        wires++;
      }
    }
  }
  return {
    view: frames.length === 0 ? base : { ...base, nodes, edges, groups },
    drawn,
    parts,
    added: { boxes, wires },
  };
}
