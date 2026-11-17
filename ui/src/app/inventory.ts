/**
 * The registered inventory: which diagrams exist, independent of which one is
 * being presented.
 *
 * Presentation says "look at this"; the inventory says "these are available".
 * They are different questions, and the web shell needs both -- a diagram can
 * be registered and never presented, which is precisely the state a tab strip
 * exists to make reachable.
 *
 * Wire shape (frozen):
 *   { "schemaVersion": 1,
 *     "views": [{ "id", "kind", "title", "registration" }] }
 * carried by `GET api/diagrams` and by the `inventory` SSE event.
 */
import { rememberThumbnailFormat, rememberThumbnailVersion } from "./thumbnail-version";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mjs";
import { parseFileFacts, type FileFacts } from "./file-facts";

/**
 * The one inventory wire version this page reads.
 *
 * Its own number: the inventory, the emphasis snapshot and the diagram envelope
 * are versioned separately, and one moving does not move the others.
 */
export const INVENTORY_SCHEMA_VERSION = 1;

/** `embedded`: a mermaid block in a note, its id the block's address (ADR 0012). */
export type Registration = "ephemeral" | "durable" | "embedded";

/** The diagram's intent, which the contents page groups by (phase3-front-door.md). */
export type ViewGroup = "system" | "behaviour" | "data" | "journeys" | "other";

export const VIEW_GROUPS: readonly ViewGroup[] = ["system", "behaviour", "data", "journeys", "other"];

/**
 * The kind, in the reader's words.
 *
 * The wire value (`c4-container`) is an identifier, not a label. `freeform` has
 * no entry on purpose: it is the kind a diagram gets when nobody chose one, so
 * printing it beside every such diagram told the reader nothing.
 */
const KIND_LABEL: Readonly<Record<string, string>> = {
  "c4-context": "Context",
  "c4-container": "Containers",
  "c4-component": "Components",
  "c4-code": "Code",
  "data-flow": "Data flow",
  sequence: "Sequence",
  state: "State",
  "entity-relationship": "Entities",
  c4: "C4",
  architecture: "Architecture",
  journey: "Journey",
};

export function kindLabel(kind: string): string | undefined {
  return KIND_LABEL[kind];
}

/** Who last changed a diagram, and when: the service's times, ISO 8601. */
export type LastChange = {
  readonly at: string;
  readonly by: "agent" | "person";
  readonly summary?: string;
};

/** A diagram's comment threads, counted by state. */
export type ThreadCounts = {
  readonly draft: number;
  readonly sent: number;
  readonly read: number;
  readonly answered: number;
  readonly resolved: number;
};

export const THREAD_STATES: readonly (keyof ThreadCounts)[] = ["draft", "sent", "read", "answered", "resolved"];

export type DiagramView = FileFacts & {
  /** Optional Archer-folder-relative source path supplied by the TypeScript service. */
  readonly sourcePath?: string;
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly registration: Registration;
  /*
   * Phase 3 (the front door). Each is optional (absent when there is nothing
   * to say) and read on its own, so one malformed field costs that field and
   * not the diagram.
   */
  readonly lastChange?: LastChange;
  readonly threads?: ThreadCounts;
  /** The caption of the agent's latest presentation of this view; absent when it had none. */
  readonly caption?: string;
  /** When the agent last presented this view, ISO 8601 (settled by the server slice). */
  readonly presentedAt?: string;
  readonly group?: ViewGroup;
  readonly counts?: { readonly elements: number; readonly links: number };
  /** For an embedded diagram: its note (folder-relative) and its name there. */
  readonly note?: string;
  readonly name?: string;
  /** The served model's revision; it keys the service thumbnail. Absent while the view has none (never compiled). */
  readonly modelRevision?: string;
  /** A diagram file's bytes revision (not an embedded block's). */
  readonly sourceRevision?: string;
  /** How many walkthroughs it has (ADR 0034): a count of the sidecar's entries; absent when none or not said. */
  readonly walkthroughs?: number;
  /** Its file is gone; the drawing served is the last that compiled (flows-r1 S4). */
  readonly sourceMissing?: true;
  /** Where its file went: the one diagram file now holding the bytes it last compiled from. */
  readonly movedTo?: { readonly id: string; readonly sourcePath: string };
};

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function parseLastChange(value: unknown): LastChange | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) return undefined;
  if (record.by !== "agent" && record.by !== "person") return undefined;
  const summary = typeof record.summary === "string" && record.summary.trim() !== "" ? record.summary : undefined;
  return summary === undefined ? { at: record.at, by: record.by } : { at: record.at, by: record.by, summary };
}

export function parseThreadCounts(value: unknown): ThreadCounts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!THREAD_STATES.every((state) => isCount(record[state]))) return undefined;
  return {
    draft: record.draft as number,
    sent: record.sent as number,
    read: record.read as number,
    answered: record.answered as number,
    resolved: record.resolved as number,
  };
}

function parseCounts(value: unknown): DiagramView["counts"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return isCount(record.elements) && isCount(record.links)
    ? { elements: record.elements, links: record.links }
    : undefined;
}

type Phase3Fields = {
  sourcePath?: string;
  note?: string;
  name?: string;
  lastChange?: LastChange;
  threads?: ThreadCounts;
  caption?: string;
  presentedAt?: string;
  group?: ViewGroup;
  counts?: DiagramView["counts"];
  modelRevision?: string;
  sourceRevision?: string;
  walkthroughs?: number;
  sourceMissing?: true;
  movedTo?: { id: string; sourcePath: string };
};

/** A folder-relative path the page may put in an address: no root, no `..`, no control characters. */
const isRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 4096 &&
  !/^[\\/]|[\x00-\x1f\x7f\\]/.test(value) &&
  !value.split("/").includes("..");

function phase3Fields(record: Record<string, unknown>): Phase3Fields {
  const fields: Phase3Fields = {};
  if (isRelativePath(record.sourcePath)) fields.sourcePath = record.sourcePath;
  const lastChange = parseLastChange(record.lastChange);
  if (lastChange !== undefined) fields.lastChange = lastChange;
  // An embedded diagram's note and name, only as its own address spells them.
  const at = typeof record.id === "string" ? parseDiagramAddress(record.id) : null;
  if (at !== null && record.note === at.notePath && record.name === at.name) {
    fields.note = at.notePath;
    fields.name = at.name;
  }
  const threads = parseThreadCounts(record.threads);
  if (threads !== undefined) fields.threads = threads;
  if (typeof record.caption === "string" && record.caption.trim() !== "") fields.caption = record.caption;
  if (typeof record.presentedAt === "string" && !Number.isNaN(Date.parse(record.presentedAt)))
    fields.presentedAt = record.presentedAt;
  if (VIEW_GROUPS.includes(record.group as ViewGroup)) fields.group = record.group as ViewGroup;
  const counts = parseCounts(record.counts);
  if (counts !== undefined) fields.counts = counts;
  if (typeof record.modelRevision === "string" && /^sha256:[0-9a-f]{64}$/.test(record.modelRevision))
    fields.modelRevision = record.modelRevision;
  if (typeof record.sourceRevision === "string" && /^sha256:[0-9a-f]{64}$/.test(record.sourceRevision))
    fields.sourceRevision = record.sourceRevision;
  if (isCount(record.walkthroughs) && record.walkthroughs > 0) fields.walkthroughs = record.walkthroughs;
  if (record.sourceMissing === true) fields.sourceMissing = true;
  const moved = record.movedTo;
  if (
    typeof moved === "object" &&
    moved !== null &&
    typeof (moved as Record<string, unknown>).id === "string" &&
    isRelativePath((moved as Record<string, unknown>).sourcePath)
  )
    fields.movedTo = { id: (moved as { id: string }).id, sourcePath: (moved as { sourcePath: string }).sourcePath };
  return fields;
}

function parseView(value: unknown): DiagramView | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.title !== "string" ||
    (record.registration !== "ephemeral" && record.registration !== "durable" && record.registration !== "embedded")
  ) {
    return undefined;
  }
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    registration: record.registration,
    ...phase3Fields(record),
    // Its dates and description (projects-and-search.md).
    ...parseFileFacts(record),
  };
}

/**
 * Reads an inventory payload, or reports that it was not one.
 *
 * A malformed record is dropped rather than failing the whole payload: one bad
 * entry costs its own tab, where rejecting the payload would empty the strip
 * and make every other registered diagram unreachable.
 *
 * A payload at any other `schemaVersion` IS rejected whole. That is not one bad
 * entry: it is a shape this code was not written against, and reading its
 * records as version 1 would draw tabs from a guess. The caller already treats
 * `undefined` as a failed inventory and says so on the page; the console line
 * here is what tells that failure apart from a payload that was simply
 * malformed.
 */
export function parseInventory(payload: unknown): DiagramView[] | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.views)) {
    return undefined;
  }
  if (record.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    console.error(
      `[archer] inventory schemaVersion ${JSON.stringify(record.schemaVersion)} is not supported; ` +
        `this page reads version ${INVENTORY_SCHEMA_VERSION}`,
    );
    return undefined;
  }
  rememberThumbnailVersion(record.thumbnailVersion);
  rememberThumbnailFormat(record.thumbnailFormat);
  const views: DiagramView[] = [];
  for (const entry of record.views) {
    const view = parseView(entry);
    if (view !== undefined) {
      views.push(view);
    }
  }
  return views;
}
