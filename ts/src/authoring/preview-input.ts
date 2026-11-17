/** Fixed-depth browser source-edit request boundary. */
import { AuthoringInputError } from "../../../shared/authoring-contract.mts";
import { ARROW_CHANGES, C4_ELEMENT_FUNCTIONS, C4_RELATIONS, type DiagramEdit } from "./diagram-edit.ts";
import { ER_CARDINALITIES } from "./er-edit.ts";
import { STATE_NODE_KINDS, STATE_START_END } from "./state-edit.ts";
import {
  SEQUENCE_FRAGMENTS,
  SEQUENCE_MESSAGE_KINDS,
  SEQUENCE_NOTE_POSITIONS,
  SEQUENCE_PARTICIPANT_KINDS,
} from "./sequence-edit.ts";
import { DIRECTIONS, NODE_SHAPES } from "../model/graph.ts";
/** The lines the canvas draws itself; `dashed` and `dashdot` are classes the author writes (ADR 0030). */
export const CANVAS_LINES = ["solid", "dotted", "thick"] as const;
import { isStableId } from "../model/ids.ts";
export function parseAuthoringPreview(value: unknown, editing = false): { source: string; edit?: DiagramEdit } {
  const invalid = (): never => {
    throw new AuthoringInputError("invalid or oversized authoring preview");
  };
  const object = (v: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype ||
      Object.getOwnPropertySymbols(v).length
    )
      return invalid();
    const ds = Object.getOwnPropertyDescriptors(v),
      keys = Object.keys(ds);
    if (
      keys.length > 7 ||
      required.some((k) => !Object.hasOwn(ds, k)) ||
      keys.some((k) => !required.includes(k) && !optional.includes(k)) ||
      keys.some((k) => ds[k]?.get || ds[k]?.set)
    )
      return invalid();
    return v as Record<string, unknown>;
  };
  try {
    const v = object(value, editing ? ["source", "edit"] : ["source"]);
    if (
      typeof v.source !== "string" ||
      !wellFormed(v.source) ||
      v.source.length > 262144 ||
      Buffer.byteLength(v.source) > 262144
    )
      return invalid();
    if (!editing) return { source: v.source };
    const e = object(
      v.edit,
      ["kind"],
      [
        "id",
        "label",
        "source",
        "target",
        "shape",
        "direction",
        "line",
        "element",
        "external",
        "relation",
        "state",
        "cardinality",
        "identifying",
        "participant",
        "message",
        "after",
        "before",
        "participants",
        "position",
        "text",
        "ids",
        "fragment",
        "arrow",
      ],
    );
    const ids = (v: unknown, max: number) => {
      if (
        !Array.isArray(v) ||
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length < 1 ||
        v.length > max ||
        Object.keys(v).length !== v.length ||
        v.some((x) => typeof x !== "string" || !isStableId(x))
      )
        invalid();
    };
    const nullableId = (v: unknown) => {
      if (v !== null && (typeof v !== "string" || !isStableId(v))) invalid();
    };
    const oneOf = (v: unknown, values: readonly string[]) => {
      if (v !== undefined && !values.includes(v as string)) invalid();
    };
    if (e.kind === "add-node") {
      object(e, ["kind", "id", "label"], ["shape", "element", "external", "state", "participant"]);
      oneOf(e.participant, SEQUENCE_PARTICIPANT_KINDS);
      if (e.state !== undefined && !STATE_NODE_KINDS.includes(e.state as (typeof STATE_NODE_KINDS)[number]))
        return invalid();
      if (e.shape !== undefined && !NODE_SHAPES.includes(e.shape as (typeof NODE_SHAPES)[number])) return invalid();
      if (e.element !== undefined && !C4_ELEMENT_FUNCTIONS.includes(e.element as (typeof C4_ELEMENT_FUNCTIONS)[number]))
        return invalid();
      if (e.external !== undefined && typeof e.external !== "boolean") return invalid();
    } else if (["relabel-node", "relabel-edge"].includes(e.kind as string)) object(e, ["kind", "id", "label"]);
    else if (e.kind === "connect") {
      object(
        e,
        ["kind", "source", "target"],
        ["id", "label", "line", "relation", "cardinality", "identifying", "message", "after"],
      );
      oneOf(e.message, SEQUENCE_MESSAGE_KINDS);
      if (e.after !== undefined) nullableId(e.after);
      if (e.cardinality !== undefined && !ER_CARDINALITIES.includes(e.cardinality as (typeof ER_CARDINALITIES)[number]))
        return invalid();
      if (e.identifying !== undefined && typeof e.identifying !== "boolean") return invalid();
      if (e.line !== undefined && !CANVAS_LINES.includes(e.line as (typeof CANVAS_LINES)[number])) return invalid();
      if (e.relation !== undefined && !C4_RELATIONS.includes(e.relation as (typeof C4_RELATIONS)[number]))
        return invalid();
    } else if (e.kind === "change-shape") {
      object(e, ["kind", "id", "shape"]);
      if (!NODE_SHAPES.includes(e.shape as (typeof NODE_SHAPES)[number])) return invalid();
    } else if (e.kind === "direction") {
      object(e, ["kind", "direction"]);
      if (!DIRECTIONS.includes(e.direction as (typeof DIRECTIONS)[number])) return invalid();
    } else if (
      e.kind === "delete-node" ||
      e.kind === "delete-edge" ||
      e.kind === "delete-note" ||
      e.kind === "unwrap-fragment"
    )
      object(e, ["kind", "id"]);
    else if (e.kind === "move-node" || e.kind === "move-edge") {
      object(e, ["kind", "id", "before"]);
      nullableId(e.before);
    } else if (e.kind === "retarget-edge") {
      object(e, ["kind", "id"], ["source", "target", "message", "cardinality", "identifying"]);
      oneOf(e.message, SEQUENCE_MESSAGE_KINDS);
      oneOf(e.cardinality, ER_CARDINALITIES);
      if (e.identifying !== undefined && typeof e.identifying !== "boolean") return invalid();
    } else if (e.kind === "add-note") {
      object(e, ["kind", "participants", "position", "text"], ["after"]);
      ids(e.participants, 2);
      if (!SEQUENCE_NOTE_POSITIONS.includes(e.position as (typeof SEQUENCE_NOTE_POSITIONS)[number])) return invalid();
      if (e.after !== undefined) nullableId(e.after);
    } else if (e.kind === "relabel-note") {
      object(e, ["kind", "id", "text"]);
    } else if (e.kind === "add-edge-ids") object(e, ["kind"]);
    else if (e.kind === "change-arrow") {
      object(e, ["kind", "id", "arrow"]);
      if (!ARROW_CHANGES.includes(e.arrow as (typeof ARROW_CHANGES)[number])) return invalid();
    } else if (e.kind === "wrap-edges") {
      object(e, ["kind", "ids", "fragment", "label"]);
      ids(e.ids, 256);
      if (!SEQUENCE_FRAGMENTS.includes(e.fragment as (typeof SEQUENCE_FRAGMENTS)[number])) return invalid();
    } else return invalid();
    if (
      e.kind !== "direction" &&
      e.kind !== "connect" &&
      e.kind !== "add-note" &&
      e.kind !== "wrap-edges" &&
      e.kind !== "add-edge-ids" &&
      (typeof e.id !== "string" || !isStableId(e.id))
    )
      return invalid();
    if (e.kind === "connect" && (typeof e.source !== "string" || typeof e.target !== "string")) return invalid();
    if (
      ["relabel-node", "relabel-edge", "add-node", "wrap-edges"].includes(e.kind as string) &&
      typeof e.label !== "string"
    )
      return invalid();
    if (["add-note", "relabel-note"].includes(e.kind as string) && typeof e.text !== "string") return invalid();
    for (const key of ["id", "source", "target"])
      if (
        e[key] !== undefined &&
        (typeof e[key] !== "string" || !(isStableId(e[key] as string) || (key !== "id" && e[key] === STATE_START_END)))
      )
        return invalid();
    if (
      e.label !== undefined &&
      (typeof e.label !== "string" ||
        !wellFormed(e.label) ||
        e.label.length > 8192 ||
        Buffer.byteLength(e.label) > 8192)
    )
      return invalid();
    if (
      e.text !== undefined &&
      (typeof e.text !== "string" || !wellFormed(e.text) || e.text.length > 8192 || Buffer.byteLength(e.text) > 8192)
    )
      return invalid();
    // A line break is `\n` (written to the source as `<br/>`); every other control character is refused.
    for (const text of [e.label, e.text])
      if (typeof text === "string" && /[\u0000-\u0009\u000b-\u001f]/u.test(text))
        throw new AuthoringInputError("edit label must have no control characters (a line break is \\n)");
    return { source: v.source, edit: structuredClone(e) as DiagramEdit };
  } catch (error) {
    if (error instanceof AuthoringInputError) throw error;
    return invalid();
  }
}

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
