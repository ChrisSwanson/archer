// set_emphasis's payload (ADR 0005) on the application path: the same parser
// and resolver the service publishes through (`service/emphasis.ts`), so the
// refusal an agent gets in-process and over the socket is one text from one
// implementation. This module only adapts it to the application's flow, which
// needs the payload's own viewId before it can fetch the model to resolve
// against.
import {
  parseDraft,
  resolveDraft,
  unknownView as unknownViewIssue,
  type Addressable,
  type Draft,
  type Emphasis,
  type Issue,
} from "./emphasis.mts";
import { MAX_ID_CHARS } from "../ts/src/model/ids.ts";
import { isDiagramAddress, MAX_ADDRESS_CHARS } from "./note-diagrams.mts";

export {
  GROUP_KEYS as GROUP_FIELDS,
  MAX_GROUPS,
  MAX_IDS,
  MAX_TEXT,
  PALETTES,
  SPEEDS,
  STATES,
  STYLES,
  SLOT_PALETTES,
  TEXT_LIMITS,
  addressable,
  rejection,
} from "./emphasis.mts";
export type { Addressable, Emphasis, Group, Issue } from "./emphasis.mts";

/** A draft whose `viewId` is known to be a usable string, or the issues saying why not. */
export interface ApplicationDraft extends Draft {
  readonly viewId: string | undefined;
}

const VIEW_FIX = "Name the view this emphasis belongs to; call list_diagrams to see them.";

export function parse(args: Readonly<Record<string, unknown>>): ApplicationDraft {
  const draft = parseDraft(args);
  const raw = args["viewId"];
  const issues: Issue[] = [...draft.issues];
  let viewId: string | undefined;
  // Where the issue goes: after the id's, as the payload reads.
  const at = issues[0]?.where === "id" ? 1 : 0;
  if (raw === undefined) issues.splice(at, 0, { where: "viewId", problem: "is missing", fix: VIEW_FIX });
  else if (typeof raw !== "string")
    issues.splice(at, 0, {
      where: "viewId",
      problem: `is ${raw === null ? "null" : Array.isArray(raw) ? "an array" : typeof raw === "object" ? "an object" : `a ${typeof raw}`}, not a string`,
      fix: VIEW_FIX,
    });
  else if (raw === "") issues.splice(at, 0, { where: "viewId", problem: "is empty", fix: VIEW_FIX });
  else if (!isDiagramAddress(raw) && [...raw].length > MAX_ID_CHARS)
    // An embedded diagram's address (`<note path>#<name>`) has the address limit, as in every other tool.
    issues.splice(at, 0, {
      where: "viewId",
      problem: `has ${[...raw].length} characters, more than the limit of ${MAX_ID_CHARS}`,
      fix: `An id is ${MAX_ID_CHARS} characters or fewer, an embedded diagram's address ${MAX_ADDRESS_CHARS}. ${VIEW_FIX}`,
    });
  else viewId = raw;
  return { ...draft, viewId, issues };
}

/** A payload for a view the call already names (present_diagram's emphasis): its own viewId may be left out, or must match. */
export function parseFor(raw: unknown, viewId: string): ApplicationDraft {
  return { ...parseDraft(raw, viewId), viewId };
}

/** The draft's own issues plus the "Did you mean" for a view the project does not have. */
export function unknownView(draft: ApplicationDraft, views: readonly string[]): Issue[] {
  return [...draft.issues, unknownViewIssue(draft.viewId ?? "", views)];
}

export function resolve(draft: ApplicationDraft, known: Addressable): { emphasis: Emphasis } | { issues: Issue[] } {
  if (draft.viewId === undefined) return { issues: [...draft.issues] };
  const parsed = resolveDraft(draft, draft.viewId, known);
  return parsed.ok ? { emphasis: parsed.emphasis } : { issues: parsed.issues };
}

/** A resolved emphasis as an agent would send it: without the palette and state the wire derives. */
export function asRequest(named: Emphasis): Record<string, unknown> {
  return { ...named, groups: named.groups.map(({ palette: _palette, state: _state, ...group }) => group) };
}
