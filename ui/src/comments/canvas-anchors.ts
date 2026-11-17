/**
 * What a comment on the diagram on screen can be about, read off the drawing
 * the reader is looking at: the whole diagram, what is selected, a group, or
 * the element a context menu was opened on.
 *
 * Labels are what the reader sees. The server re-reads them from the compiled
 * model, so they are words for the panel, not claims it relies on.
 */
import { MAX_SELECTION_ELEMENTS, type Anchor } from "./contract";
import type { AnchorChoice, ScopeGuard } from "./Composer";
import { eachSequenceEvent } from "../../../shared/sequence-events.mts";
import { anchorForSelection, anchorLabel } from "./state";
import {
  elementNodes,
  journeyElements,
  type ProjectedJourney,
  type ProjectedSequence,
  type ProjectedView,
} from "../diagrams/projection";
import { noteAccessibleName } from "../diagrams/sequence-nav";
import { sequenceSelectionModel } from "../selection/sequence-selection";

export type DrawnModel =
  | { readonly type: "graph"; readonly view: ProjectedView }
  | { readonly type: "sequence"; readonly view: ProjectedSequence }
  | { readonly type: "journey"; readonly view: ProjectedJourney };

type Ref = { readonly id: string; readonly label: string };

type SequenceScopes = {
  readonly blocks: ReadonlyMap<string, { label: string; kind: string }>;
  readonly notes: ReadonlyMap<string, { text: string; name: string }>;
};
const sequenceScopeCache = new WeakMap<ProjectedSequence, SequenceScopes>();

/** Projected views are immutable snapshots; all comment lookups share one traversal. */
function sequenceScopes(view: ProjectedSequence): SequenceScopes {
  const held = sequenceScopeCache.get(view);
  if (held !== undefined) return held;
  const participants = new Set(view.participants.map((participant) => participant.id));
  const blocks = new Map<string, { label: string; kind: string }>();
  const notes = new Map<string, { text: string; name: string }>();
  for (const event of eachSequenceEvent(view.events)) {
    if (event.type === "fragment") blocks.set(event.id, { label: event.label, kind: event.kind });
    // Notes stay separate from selectable elements and authored participant ids.
    if (event.type === "note" && !participants.has(event.id))
      notes.set(event.id, { text: event.text, name: noteAccessibleName(event, view.participants) });
  }
  const scopes = { blocks, notes };
  sequenceScopeCache.set(view, scopes);
  return scopes;
}

/** Host-owned scope choices and revision guards, independent of composer presentation. */
export type CommentScopes = { readonly choices: boolean; readonly guard?: ScopeGuard };
export function commentScopes(model: DrawnModel | null): CommentScopes {
  if (model?.type !== "sequence") return { choices: false };
  return {
    choices: true,
    guard: (anchor) => {
      if (anchor.kind === "group") return "block";
      if (isSequenceNoteAnchor(model, anchor)) return "note";
      return undefined;
    },
  };
}

/** Every selectable element's words: a node's label, an edge's label or its ends. */
export function elementLabels(model: DrawnModel): { nodes: Map<string, string>; edges: Map<string, string> } {
  if (model.type === "journey") {
    // Sections and tasks; a journey has no links.
    return { nodes: new Map(journeyElements(model.view).map((n) => [n.id, n.label] as const)), edges: new Map() };
  }
  if (model.type === "sequence") {
    const { nodeDetails, edgeDetails } = sequenceSelectionModel(model.view);
    const nodes = new Map([...nodeDetails].map(([id, d]) => [id, d.label] as const));
    const edges = new Map(
      [...edgeDetails].map(
        ([id, d]) =>
          [id, d.label ?? `${nodes.get(d.source) ?? d.source} → ${nodes.get(d.target) ?? d.target}`] as const,
      ),
    );
    return { nodes, edges };
  }
  // Groups that are model elements (a composite state, a C4 boundary) are
  // nodes here: the server anchors a comment on one as a node.
  const nodes = new Map(elementNodes(model.view).map((n) => [n.id, n.label] as const));
  const edges = new Map(
    model.view.edges.map(
      (e) => [e.id, e.label ?? `${nodes.get(e.source) ?? e.source} → ${nodes.get(e.target) ?? e.target}`] as const,
    ),
  );
  return { nodes, edges };
}

/**
 * True when `anchor` names an element, link or group the drawn diagram no longer has (claude-205): the agent renamed
 * or removed it after a draft was written about it. The whole diagram, a walkthrough and the rest are never gone.
 */
export function anchorMissing(model: DrawnModel, anchor: Anchor): boolean {
  if (anchor.kind !== "node" && anchor.kind !== "edge" && anchor.kind !== "group") return false;
  if (isSequenceNoteAnchor(model, anchor)) return false;
  const { nodes, edges } = elementLabels(model);
  if (anchor.kind === "edge") return !edges.has(anchor.id);
  const groups =
    model.type === "graph"
      ? model.view.groups.map((g) => g.id)
      : model.type === "sequence"
        ? [...sequenceScopes(model.view).blocks.keys()]
        : [];
  return !nodes.has(anchor.id) && !groups.includes(anchor.id);
}

/** Recognizes the separate note comment scope without confusing a participant's authored id. */
export function isSequenceNoteAnchor(model: DrawnModel, anchor: Anchor): anchor is Extract<Anchor, { kind: "node" }> {
  return model.type === "sequence" && anchor.kind === "node" && sequenceScopes(model.view).notes.has(anchor.id);
}

/** The anchor for what is selected, or the whole diagram when that is nothing or too much. */
export function selectionAnchor(model: DrawnModel, nodeIds: readonly string[], edgeIds: readonly string[]): Anchor {
  if (nodeIds.length + edgeIds.length > MAX_SELECTION_ELEMENTS) {
    return { kind: "view" };
  }
  const { nodes, edges } = elementLabels(model);
  const refs = (ids: readonly string[], labels: Map<string, string>): Ref[] =>
    ids.flatMap((id) => (labels.has(id) ? [{ id, label: labels.get(id)! }] : []));
  return anchorForSelection(refs(nodeIds, nodes), refs(edgeIds, edges));
}

/** The picker's list: the selection (when there is one), the whole diagram, and each group. */
export function diagramChoices(
  model: DrawnModel | null,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): AnchorChoice[] {
  const whole: AnchorChoice = { anchor: { kind: "view" }, label: anchorLabel({ kind: "view" }, "view") };
  if (model === null) {
    return [whole];
  }
  const selected = selectionAnchor(model, nodeIds, edgeIds);
  // A flowchart's subgraphs, which comments anchor to as groups. A group
  // that is a model element is a node, and is offered as one when selected.
  const groups: AnchorChoice[] =
    model.type === "graph"
      ? model.view.groups
          .filter((g) => g.element !== true)
          .map((g) => {
            const anchor: Anchor = { kind: "group", id: g.id, label: g.label };
            return { anchor, label: anchorLabel(anchor, "view") };
          })
      : model.type === "sequence"
        ? [...sequenceScopes(model.view).blocks].map(([id, block]) => ({
            anchor: { kind: "group" as const, id, label: block.label },
            label: `${block.kind} block: ${block.label}`,
          }))
        : [];
  if (model.type === "sequence")
    groups.push(
      ...[...sequenceScopes(model.view).notes].map(([id, note]) => ({
        anchor: { kind: "node" as const, id, label: note.text },
        label: note.name,
      })),
    );
  return selected.kind === "view"
    ? [whole, ...groups]
    : [{ anchor: selected, label: anchorLabel(selected, "view") }, whole, ...groups];
}

/** The element a pointer event landed on, as an anchor, or `null` for empty canvas. */
export function anchorAt(target: EventTarget | null, model: DrawnModel): Anchor | null {
  if (!(target instanceof Element)) return null;
  const { nodes, edges } = elementLabels(model);
  const journey = target.closest("[data-journey-id]");
  if (journey !== null) {
    const id = journey.getAttribute("data-journey-id") ?? "";
    return nodes.has(id) ? { kind: "node", id, label: nodes.get(id)! } : null;
  }
  const sequence = target.closest("[data-seq-id]");
  if (sequence !== null) {
    const id = sequence.getAttribute("data-seq-id") ?? "";
    const channel = sequence.getAttribute("data-seq-channel");
    if (channel === "participants" && nodes.has(id)) return { kind: "node", id, label: nodes.get(id)! };
    if (channel === "messages" && edges.has(id)) return { kind: "edge", id, label: edges.get(id)! };
    if (channel === "notes" && model.type === "sequence") {
      const note = sequenceScopes(model.view).notes.get(id);
      if (note !== undefined) return { kind: "node", id, label: note.text };
    }
    if (channel === "fragments" && model.type === "sequence") {
      const block = sequenceScopes(model.view).blocks.get(id);
      if (block !== undefined) return { kind: "group", id, label: block.label };
    }
    return null;
  }
  const edge = target.closest(".react-flow__edge[data-id]");
  if (edge !== null) {
    const id = edge.getAttribute("data-id") ?? "";
    return edges.has(id) ? { kind: "edge", id, label: edges.get(id)! } : null;
  }
  const node = target.closest(".react-flow__node[data-id]");
  if (node !== null) {
    const id = node.getAttribute("data-id") ?? "";
    if (id.startsWith("group:") && model.type === "graph") {
      const group = model.view.groups.find((g) => g.id === id.slice("group:".length));
      return group === undefined ? null : { kind: "group", id: group.id, label: group.label };
    }
    return nodes.has(id) ? { kind: "node", id, label: nodes.get(id)! } : null;
  }
  return null;
}

/** The node and edge ids an anchor names, to select them on the canvas. */
export function anchorIds(anchor: Anchor, model?: DrawnModel): { nodeIds: string[]; edgeIds: string[] } | null {
  if (model !== undefined && isSequenceNoteAnchor(model, anchor)) return null;
  switch (anchor.kind) {
    case "node":
      return { nodeIds: [anchor.id], edgeIds: [] };
    case "edge":
      return { nodeIds: [], edgeIds: [anchor.id] };
    case "selection":
      return { nodeIds: anchor.nodes.map((n) => n.id), edgeIds: anchor.edges.map((e) => e.id) };
    default:
      return null;
  }
}
