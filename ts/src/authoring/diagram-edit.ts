/** One edit vocabulary for every graph-style family, dispatched to the family's source-preserving editor. */
import { readPreamble } from "../mermaid/preamble.ts";
import { addMissingEdgeIds } from "../mermaid/flowchart/edge-ids.ts";
import type { Direction, EdgeLine, NodeShape } from "../model/index.ts";
import type { EditDiagnostic } from "./compile-cache.ts";
import { editC4, type C4ElementFunction, type C4Relation } from "./c4-edit.ts";
import { editEr, type ErCardinality } from "./er-edit.ts";
import { editFlowchart, type FlowchartEdit } from "./flowchart-edit.ts";
import { editState, type StateNodeKind } from "./state-edit.ts";
import {
  editSequence,
  type SequenceFragment,
  type SequenceNotePosition,
  type SequenceParticipantKind,
} from "./sequence-edit.ts";
import type { MessageKind } from "../model/index.ts";
import { activeTelemetry, currentRequest } from "../telemetry/index.ts";

export { C4_ELEMENT_FUNCTIONS, C4_RELATIONS, type C4ElementFunction, type C4Relation } from "./c4-edit.ts";

/**
 * change-arrow's `arrow`: `one-way` (one arrowhead, at the target), `two-way` (one at each end), or `reverse`
 * (the ends swapped, the arrowheads as they were).
 */
export const ARROW_CHANGES = ["one-way", "two-way", "reverse"] as const;
export type ArrowChange = (typeof ARROW_CHANGES)[number];

/**
 * The shared operations. Flowchart parameters: `shape`, connect `id` and `line`, `change-shape`, `direction`.
 * C4 parameters: add-node `element` and `external`, connect `relation` (its id is derived `source--target`).
 * State parameters: add-node `state` (choice, fork, join); connect `[*]` as the top-level start or end.
 * ER parameters: connect `cardinality` and `identifying` (its id is derived `source--target`).
 * Sequence parameters: add-node `participant`; connect `message` (arrow) and `after` (message ID, null = first).
 * Sequence operations: move-node, move-edge, add-note, relabel-note, delete-note, wrap-edges,
 * unwrap-fragment. Message, note and fragment IDs are the compiler's source-order ordinals.
 * retarget-edge changes one or both ends of a connection in place, splicing only the end names; `message`
 * (arrow kind) is sequence-only. A flowchart edge keeps its ID; elsewhere the derived `source--target` changes.
 * change-arrow (flowchart edge, sequence message) sets the arrowheads: `one-way`, `two-way` (`<-->`, `<<->>`), or
 * `reverse` the ends. It splices only the link (or the two ends); Mermaid has no two-way async message.
 * add-edge-ids (flowchart) declares each node only named (`a` → `a[a]`) and writes a readable ID (`source_target`, `_2` when taken) on every edge written without
 * one, the fix the compiler's diagnostics name; it needs no valid source and touches no other byte.
 * A parameter or operation the source's family does not take is refused `edit_unsupported_for_family`.
 */
export type DiagramEdit =
  | { kind: "relabel-node"; id: string; label: string }
  | {
      kind: "add-node";
      id: string;
      label: string;
      shape?: NodeShape;
      element?: C4ElementFunction;
      external?: boolean;
      state?: StateNodeKind;
      participant?: SequenceParticipantKind;
    }
  | {
      kind: "connect";
      id?: string;
      source: string;
      target: string;
      label?: string;
      line?: EdgeLine;
      relation?: C4Relation;
      cardinality?: ErCardinality;
      identifying?: boolean;
      message?: MessageKind;
      after?: string | null;
    }
  | { kind: "move-node"; id: string; before: string | null }
  | {
      kind: "retarget-edge";
      id: string;
      source?: string;
      target?: string;
      message?: MessageKind;
      cardinality?: ErCardinality;
      identifying?: boolean;
    }
  | { kind: "move-edge"; id: string; before: string | null }
  | { kind: "add-note"; participants: string[]; position: SequenceNotePosition; text: string; after?: string | null }
  | { kind: "relabel-note"; id: string; text: string }
  | { kind: "delete-note"; id: string }
  | { kind: "wrap-edges"; ids: string[]; fragment: SequenceFragment; label: string }
  | { kind: "unwrap-fragment"; id: string }
  | { kind: "relabel-edge"; id: string; label: string }
  | { kind: "change-shape"; id: string; shape: NodeShape }
  | { kind: "change-arrow"; id: string; arrow: ArrowChange }
  | { kind: "delete-edge"; id: string }
  | { kind: "delete-node"; id: string }
  | { kind: "direction"; direction: Direction }
  | { kind: "add-edge-ids" };
/** `existingId` names the relationship an `edit_relationship_exists` refusal collided with. */
export type DiagramEditResult =
  | { ok: true; source: string }
  | { ok: false; source: string; code: string; existingId?: string; diagnostic?: EditDiagnostic };

/**
 * Dispatch by the header's family. Each editor compiles the source itself and refuses one that does not
 * compile to its model type, so an invalid source keeps its family's code (`edit_requires_valid_flowchart`,
 * `edit_requires_valid_c4`). A source with no header Archer reads stays with the flowchart editor, as before.
 */
export async function editDiagram(source: string, edit: DiagramEdit): Promise<DiagramEditResult> {
  const telemetry = activeTelemetry();
  if (telemetry === null) return dispatchEdit(source, edit);
  // Development telemetry: op, family and outcome; an editor refusing its own result is a warning.
  const started = performance.now();
  const result = await dispatchEdit(source, edit);
  telemetry.edit(
    readPreamble(source).family ?? "flowchart",
    edit.kind,
    result.ok ? null : result.code,
    performance.now() - started,
    currentRequest()?.id,
  );
  return result;
}

async function dispatchEdit(source: string, edit: DiagramEdit): Promise<DiagramEditResult> {
  const family = readPreamble(source).family;
  if (edit.kind === "add-edge-ids")
    return family === "flowchart"
      ? { ok: true, source: addMissingEdgeIds(source).source }
      : { ok: false, source, code: "edit_unsupported_for_family" };
  if (family === "sequence") return editSequence(source, edit);
  if (edit.kind === "change-arrow" && family !== undefined && family !== "flowchart")
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (edit.kind === "add-node" && edit.participant !== undefined)
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (
    (edit.kind === "connect" && (edit.message !== undefined || edit.after !== undefined)) ||
    (edit.kind === "retarget-edge" && edit.message !== undefined)
  )
    return { ok: false, source, code: "edit_unsupported_for_family" };
  // The sequence-only operations.
  if (
    edit.kind === "move-node" ||
    edit.kind === "move-edge" ||
    edit.kind === "add-note" ||
    edit.kind === "relabel-note" ||
    edit.kind === "delete-note" ||
    edit.kind === "wrap-edges" ||
    edit.kind === "unwrap-fragment"
  )
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (family === "er") return editEr(source, edit);
  if (
    (edit.kind === "connect" || edit.kind === "retarget-edge") &&
    (edit.cardinality !== undefined || edit.identifying !== undefined)
  )
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (family === "state") return editState(source, edit);
  if (edit.kind === "add-node" && edit.state !== undefined)
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (family === "c4") return editC4(source, edit);
  if (family !== undefined && family !== "flowchart") return { ok: false, source, code: "edit_unsupported_family" };
  if (edit.kind === "add-node" && (edit.element !== undefined || edit.external !== undefined))
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (edit.kind === "connect" && edit.relation !== undefined)
    return { ok: false, source, code: "edit_unsupported_for_family" };
  if (edit.kind === "connect" && edit.id === undefined) return { ok: false, source, code: "edit_id_required" };
  return editFlowchart(source, edit as FlowchartEdit);
}
