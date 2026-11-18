// Walkthroughs on disk (ADR 0034 §1): one `<name>.walkthroughs.json` beside
// each diagram that has any, written only through writeConfined, under the
// cross-process writer lock comments use.
//
// - Every file is validated whole when read. A malformed one is reported by
//   path and never rewritten, dropped or "repaired": the person or git decides.
// - Each walkthrough carries a `revision`, +1 per write of it. Replacing or
//   deleting one names the revision read, and is refused with
//   `walkthrough_changed` (and the walkthrough as it is now) when it moved.
// - Fields are written in the contract's order, so an unchanged walkthrough
//   rewrites to the same bytes, and a write that changes nothing writes nothing.
// - Nothing here resolves against a model or writes on a recompile: the file
//   changes only when someone writes a walkthrough (resolve.ts derives status).
import { lstatSync } from "node:fs";
import { posix } from "node:path";
import { CommentsLockError, withCommentsLock } from "../comments/lock.ts";
import { assertWriteAllowed, WriteRuleDenied } from "../config/write-policy.ts";
import { isStableId, isViewId } from "../model/index.ts";
import { walkthroughsPathFor } from "../notes/embedded.ts";
import {
  ConfinedRefusal,
  ConfinedTooLarge,
  ProjectError,
  readInFolder,
  removeInFolder,
  resolveInFolder,
  writeConfined,
  type Project,
} from "../project/index.ts";
import { ConfinedWriteRefusedError } from "../project/project.ts";
import {
  AUTHORS,
  CODE_REFERENCE,
  COMMIT_ID,
  EDGE_REF_KEYS,
  FILE_KEYS,
  LIMITS,
  MAX_CODE_REFERENCE_CHARS,
  MAX_NOTE_PATH_CHARS,
  MESSAGE_KEYS,
  NODE_KINDS,
  NODE_REF_KEYS,
  RESERVED,
  SERVER_REF_KEYS,
  SERVER_WALKTHROUGH_KEYS,
  STEP_ID,
  STEP_KEYS,
  STEP_KINDS,
  TEXT_LIMITS,
  WALKTHROUGH_ID,
  WALKTHROUGH_KEYS,
  WALKTHROUGHS_SCHEMA_VERSION,
  type Author,
  type DraftStep,
  type DraftWalkthrough,
  type EdgeRef,
  type Issue,
  type Message,
  type NodeRef,
  type Step,
  type Walkthrough,
  type WalkthroughsFile,
} from "./contract.ts";
import { assignStepIds } from "./step-ids.ts";
import type { WalkthroughSubject } from "../comments/store.ts";

/** The write rule a walkthrough falls under: it is drawn as emphasis (ADR 0034 §4). */
const WRITE_RULE = "emphasis" as const;
/** How many times a write starts over when another process changed the file under it. */
const WRITE_ATTEMPTS = 4;

export type WalkthroughsErrorCode =
  | "invalid_walkthrough"
  | "walkthrough_changed"
  | "malformed_walkthroughs_file"
  | "walkthroughs_file_conflict"
  | "write_conflict";

const HTTP_STATUS: Readonly<Record<WalkthroughsErrorCode, number>> = {
  invalid_walkthrough: 422,
  walkthrough_changed: 409,
  malformed_walkthroughs_file: 409,
  walkthroughs_file_conflict: 409,
  write_conflict: 409,
};

/** A refusal with a stable code. `details`: `issues` for invalid_walkthrough, `walkthrough` (as it is now) for walkthrough_changed. */
export class WalkthroughsError extends Error {
  constructor(
    readonly code: WalkthroughsErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WalkthroughsError";
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

/** One refusal naming every problem, for the caller to fix in one retry. */
export function invalid(issues: readonly Issue[]): WalkthroughsError {
  const count = issues.length;
  let text = `The walkthrough was refused: ${count} ${count === 1 ? "problem" : "problems"}. Nothing was written. Fix all of them and retry.`;
  for (const issue of issues) text += `\n- ${issue.where}: ${issue.problem}. ${issue.fix}`;
  return new WalkthroughsError("invalid_walkthrough", text, { issues });
}

// ---------------------------------------------------------------- places

/** Where a view's walkthroughs live; `conflict` says why they cannot (another view spells the same file). */
export interface WalkthroughsPlace {
  readonly viewId: string;
  readonly path: string;
  readonly conflict?: string;
}

/** Every view's place, with the views that share a sidecar spelling marked (as `comments_file_conflict`). */
export function walkthroughsPlaces(
  views: Iterable<{ readonly id: string; readonly path: string; readonly embedded?: { readonly name: string } }>,
): Map<string, WalkthroughsPlace> {
  const owners = new Map<string, string[]>();
  const paths = new Map<string, string>();
  for (const view of views) {
    const path = walkthroughsPathFor(view.path, view.embedded?.name);
    paths.set(view.id, path);
    owners.set(path, [...(owners.get(path) ?? []), view.id]);
  }
  const places = new Map<string, WalkthroughsPlace>();
  for (const [viewId, path] of paths) {
    const others = (owners.get(path) ?? []).filter((id) => id !== viewId);
    places.set(
      viewId,
      others.length === 0
        ? { viewId, path }
        : {
            viewId,
            path,
            conflict: `${path} would hold the walkthroughs of ${JSON.stringify(viewId)} and of ${others.map((o) => JSON.stringify(o)).join(", ")}, so neither can keep walkthroughs until one of them is renamed`,
          },
    );
  }
  return places;
}

// ------------------------------------------------------------- validation

type Mode = "stored" | "request";
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const chars = (s: string): number => [...s].length;
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const quoted = (s: string): string => JSON.stringify(chars(s) > 64 ? `${[...s].slice(0, 64).join("")}…` : s);

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

class Reader {
  readonly issues: Issue[] = [];
  constructor(readonly mode: Mode) {}

  issue(where: string, problem: string, fix: string): void {
    this.issues.push({ where, problem, fix });
  }

  /** Unknown fields refused; reserved ones with their own reason; in a request, Archer's own fields are allowed and ignored. */
  fields(value: Json, allowed: readonly string[], server: readonly string[], where: string): void {
    for (const key of Object.keys(value)) {
      if (allowed.includes(key) || (this.mode === "request" && server.includes(key))) continue;
      const reserved = Object.hasOwn(RESERVED, key) ? RESERVED[key] : undefined;
      if (reserved !== undefined) this.issue(where === "" ? key : `${where}.${key}`, reserved, "Remove it.");
      else
        this.issue(
          where === "" ? key.slice(0, 32) : `${where}.${key.slice(0, 32)}`,
          "is not a field a walkthrough has",
          `Use only: ${allowed.filter((k) => this.mode === "stored" || !server.includes(k)).join(", ")}.`,
        );
    }
  }

  text(
    value: unknown,
    where: string,
    limit: { readonly words: number; readonly chars: number },
    required: boolean,
  ): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string") {
      this.issue(where, value === undefined ? "is missing" : "is not text", "Give it as one line of text.");
      return undefined;
    }
    if (value.trim() === "") {
      if (required) this.issue(where, "is empty", "Say it in a few words.");
      else this.issue(where, "is empty", "Leave it out, or say it in a few words.");
      return undefined;
    }
    if (hasControl(value)) this.issue(where, "holds a control character or a line break", "Keep it to one line.");
    const n = chars(value);
    if (n > limit.chars)
      this.issue(
        where,
        `is ${n} characters, more than the limit of ${limit.chars}`,
        "Say it in fewer; text is refused, never cut.",
      );
    if (Number.isFinite(limit.words) && words(value) > limit.words)
      this.issue(where, `is ${words(value)} words, more than the limit of ${limit.words}`, "Say it in fewer words.");
    return value;
  }

  plain(value: unknown, where: string): string | undefined {
    if (typeof value !== "string") {
      this.issue(where, value === undefined ? "is missing" : "is not text", "Archer writes it from the model.");
      return undefined;
    }
    return value;
  }

  id(value: unknown, where: string): string | undefined {
    if (typeof value !== "string" || !isStableId(value)) {
      this.issue(
        where,
        typeof value === "string"
          ? `${quoted(value)} is not an element id`
          : value === undefined
            ? "is missing"
            : "is not text",
        "Use an id from read_diagram.",
      );
      return undefined;
    }
    return value;
  }

  list(value: unknown, where: string, max: number, required = false): unknown[] {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) {
      this.issue(where, value === undefined ? "is missing" : "is not a list", "Give it as a list.");
      return [];
    }
    if (value.length > max)
      this.issue(
        where,
        `has ${value.length} entries, more than the limit of ${max}`,
        "Split the step, or keep the ones that matter.",
      );
    return value.slice(0, max);
  }

  oneOf<T extends string>(value: unknown, where: string, among: readonly T[], fallback?: T): T | undefined {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value === "string" && (among as readonly string[]).includes(value)) return value as T;
    this.issue(
      where,
      value === undefined ? "is missing" : `is ${typeof value === "string" ? quoted(value) : "not text"}`,
      `Use one of: ${among.join(", ")}.`,
    );
    return undefined;
  }
}

function nodeRef(
  r: Reader,
  value: unknown,
  where: string,
): { kind: (typeof NODE_KINDS)[number]; id: string; label?: string } | null {
  if (!isObject(value)) {
    r.issue(where, "is not an object", 'Name a box as { "kind": "node", "id": "<id>" }.');
    return null;
  }
  r.fields(value, NODE_REF_KEYS, SERVER_REF_KEYS, where);
  // A request may leave the kind out: a box is a node unless it says it is a group.
  const kind = r.oneOf(value["kind"], `${where}.kind`, NODE_KINDS, r.mode === "request" ? "node" : undefined);
  const id = r.id(value["id"], `${where}.id`);
  const label = r.mode === "stored" ? r.plain(value["label"], `${where}.label`) : undefined;
  if (kind === undefined || id === undefined || (r.mode === "stored" && label === undefined)) return null;
  return label === undefined ? { kind, id } : { kind, id, label };
}

function edgeRef(
  r: Reader,
  value: unknown,
  where: string,
): { id: string; source?: string; target?: string; label?: string } | null {
  if (!isObject(value)) {
    r.issue(where, "is not an object", 'Name a line as { "id": "<edge id>" }.');
    return null;
  }
  r.fields(value, EDGE_REF_KEYS, SERVER_REF_KEYS, where);
  const id = r.id(value["id"], `${where}.id`);
  if (r.mode === "request") return id === undefined ? null : { id };
  const source = r.id(value["source"], `${where}.source`);
  const target = r.id(value["target"], `${where}.target`);
  const label = value["label"] === undefined ? undefined : r.plain(value["label"], `${where}.label`);
  if (id === undefined || source === undefined || target === undefined) return null;
  return { id, source, target, ...(label === undefined ? {} : { label }) };
}

function message(r: Reader, value: unknown, where: string): Message | null {
  if (!isObject(value)) {
    r.issue(
      where,
      "is not an object",
      'Give a message as { "from": "<id>", "to": "<id>", "label": "<what is sent>" }.',
    );
    return null;
  }
  r.fields(value, MESSAGE_KEYS, [], where);
  const from = r.id(value["from"], `${where}.from`);
  const to = r.id(value["to"], `${where}.to`);
  const label = r.text(value["label"], `${where}.label`, TEXT_LIMITS.messageLabel, true);
  return from === undefined || to === undefined || label === undefined ? null : { from, to, label };
}

function codeRefs(r: Reader, value: unknown, where: string): string[] {
  return r.list(value, where, LIMITS.code).flatMap((ref, i) => {
    if (typeof ref !== "string" || chars(ref) > MAX_CODE_REFERENCE_CHARS || !CODE_REFERENCE.test(ref)) {
      r.issue(
        `${where}[${i}]`,
        typeof ref === "string" ? `${quoted(ref)} is not a code reference` : "is not text",
        "Write a repository-relative path: `src/a.ts`, `src/`, `src/a.ts#name` or `src/a.ts:12`.",
      );
      return [];
    }
    return [ref];
  });
}

/** A folder-relative note path's shape (whether it exists is grounding's question). */
function notePath(r: Reader, value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  const ok =
    typeof value === "string" &&
    value.endsWith(".md") &&
    chars(value) <= MAX_NOTE_PATH_CHARS &&
    !hasControl(value) &&
    !value.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes("\\"));
  if (!ok) {
    r.issue(
      where,
      "is not a note path",
      "Give the note's path relative to the Archer folder, e.g. notes/flows/checkout.md.",
    );
    return undefined;
  }
  return value;
}

function step(r: Reader, value: unknown, where: string): DraftStep | null {
  if (!isObject(value)) {
    r.issue(
      where,
      "is not an object",
      "Each step is an object with a title, a kind, what happens and the ids it names.",
    );
    return null;
  }
  r.fields(value, STEP_KEYS, [], where);
  const before = r.issues.length;
  const rawId = value["id"];
  const id = typeof rawId === "string" && STEP_ID.test(rawId) ? rawId : undefined;
  if (rawId !== undefined && id === undefined)
    r.issue(
      `${where}.id`,
      typeof rawId === "string" ? `${quoted(rawId)} is not a step id` : "is not text",
      "Use lower-case letters, digits and hyphens, at most 48, or leave id out and Archer makes one from the title.",
    );
  const title = r.text(value["title"], `${where}.title`, TEXT_LIMITS.stepTitle, true);
  const kind = r.oneOf(value["kind"], `${where}.kind`, STEP_KINDS);
  const what = r.text(value["what"], `${where}.what`, TEXT_LIMITS.what, true);
  const why = r.text(value["why"], `${where}.why`, TEXT_LIMITS.why, false);
  const code = codeRefs(r, value["code"], `${where}.code`);
  const nodesRaw = r.list(value["nodes"], `${where}.nodes`, LIMITS.nodes);
  const edgesRaw = r.list(value["edges"], `${where}.edges`, LIMITS.edges);
  const messagesRaw = r.list(value["messages"], `${where}.messages`, LIMITS.messages);
  const nodes = nodesRaw.map((n, i) => nodeRef(r, n, `${where}.nodes[${i}]`));
  const edges = edgesRaw.map((e, i) => edgeRef(r, e, `${where}.edges[${i}]`));
  const messages = messagesRaw.map((m, i) => message(r, m, `${where}.messages[${i}]`));
  if (nodesRaw.length + edgesRaw.length + messagesRaw.length === 0)
    r.issue(where, "names no element", "Name at least one box (nodes), line (edges) or message.");
  if (r.issues.length > before || title === undefined || kind === undefined || what === undefined) return null;
  return {
    ...(id === undefined ? {} : { id }),
    title,
    kind,
    what,
    ...(why === undefined ? {} : { why }),
    ...(code.length === 0 ? {} : { code }),
    nodes: nodes as NodeRef[],
    edges: edges as EdgeRef[],
    messages: messages as Message[],
  };
}

const MODEL_REVISION = /^sha256:[0-9a-f]{64}$/;

/** One walkthrough: as stored (every field) or as requested (content only; Archer's fields ignored). */
function walkthrough(r: Reader, value: unknown, where: string): Walkthrough | DraftWalkthrough | null {
  const at = (field: string) => (where === "" ? field : `${where}.${field}`);
  if (!isObject(value)) {
    r.issue(
      where === "" ? "walkthrough" : where,
      "is not an object",
      "Send an object with an id, a title and its steps.",
    );
    return null;
  }
  r.fields(value, WALKTHROUGH_KEYS, SERVER_WALKTHROUGH_KEYS, where);
  const before = r.issues.length;
  const rawId = value["id"];
  const id = typeof rawId === "string" && WALKTHROUGH_ID.test(rawId) ? rawId : undefined;
  if (id === undefined)
    r.issue(
      at("id"),
      typeof rawId === "string" ? `${quoted(rawId)} is not a walkthrough id` : "is missing",
      'Use lower-case letters, digits and hyphens, at most 48, e.g. "declined-card".',
    );
  const title = r.text(value["title"], at("title"), TEXT_LIMITS.title, true);
  const description = r.text(value["description"], at("description"), TEXT_LIMITS.description, false);
  const note = notePath(r, value["note"], at("note"));
  const open = r.list(value["open"], at("open"), LIMITS.open).flatMap((o, i) => {
    const valid = r.id(o, `${at("open")}[${i}]`);
    return valid === undefined ? [] : [valid];
  });
  if (new Set(open).size !== open.length) r.issue(at("open"), "repeats a container", "Name each container once.");
  const stepsRaw = r.list(value["steps"], at("steps"), LIMITS.steps, true);
  if (Array.isArray(value["steps"]) && value["steps"].length === 0)
    r.issue(at("steps"), "is empty", "A walkthrough has at least one step.");
  const steps = stepsRaw.map((s, i) => step(r, s, `${at("steps")}[${i}]`));
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    if (s !== null && s.id === undefined && r.mode === "stored")
      r.issue(`${at("steps")}[${i}].id`, "is missing", "Archer writes it.");
    if (s?.id === undefined) return;
    if (seen.has(s.id))
      r.issue(
        `${at("steps")}[${i}].id`,
        `repeats the id ${quoted(s.id)} of an earlier step`,
        "Give each step its own id, or leave id out.",
      );
    seen.add(s.id);
  });
  let server: Pick<Walkthrough, "revision" | "modelRevision" | "commit" | "author" | "writtenAt"> | null = null;
  if (r.mode === "stored") {
    const revision = value["revision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
      r.issue(at("revision"), "is not a whole number from 1", "Archer writes it.");
    const modelRevision = value["modelRevision"];
    if (typeof modelRevision !== "string" || !MODEL_REVISION.test(modelRevision))
      r.issue(at("modelRevision"), "is not a model revision", "Archer writes it.");
    const commit = value["commit"];
    if (commit !== undefined && (typeof commit !== "string" || !COMMIT_ID.test(commit)))
      r.issue(at("commit"), "is not a full commit id", "Archer writes it.");
    const author = r.oneOf<Author>(value["author"], at("author"), AUTHORS);
    const writtenAt = value["writtenAt"];
    if (typeof writtenAt !== "string" || writtenAt.length > 40 || Number.isNaN(Date.parse(writtenAt)))
      r.issue(at("writtenAt"), "is not a time", "Archer writes it.");
    if (r.issues.length === before && author !== undefined)
      server = {
        revision: revision as number,
        modelRevision: modelRevision as string,
        ...(commit === undefined ? {} : { commit: commit as string }),
        author,
        writtenAt: writtenAt as string,
      };
  }
  if (r.issues.length > before || id === undefined || title === undefined) return null;
  const content: DraftWalkthrough = {
    id,
    title,
    ...(description === undefined ? {} : { description }),
    ...(note === undefined ? {} : { note }),
    ...(open.length === 0 ? {} : { open }),
    steps: steps as DraftStep[],
  };
  return server === null ? content : ordered({ ...content, ...server, steps: steps as Step[] });
}

/** A draft as a caller sent it: its shape only, every problem that needs no model. */
export function parseDraft(raw: unknown): { draft: DraftWalkthrough | null; issues: Issue[] } {
  const r = new Reader("request");
  const draft = walkthrough(r, raw, "") as DraftWalkthrough | null;
  return { draft: r.issues.length === 0 ? draft : null, issues: r.issues };
}

/** A walkthroughs file's content, checked against the contract. */
export function validateWalkthroughsFile(
  raw: unknown,
): { ok: true; file: WalkthroughsFile } | { ok: false; problem: string } {
  const r = new Reader("stored");
  if (!isObject(raw)) return { ok: false, problem: "it is not a JSON object" };
  r.fields(raw, FILE_KEYS, [], "");
  if (raw["schemaVersion"] !== WALKTHROUGHS_SCHEMA_VERSION)
    r.issue("schemaVersion", `is not ${WALKTHROUGHS_SCHEMA_VERSION}`, "");
  const target = raw["target"];
  if (typeof target !== "string" || !target.startsWith("view:") || !isViewId(target.slice(5)))
    r.issue("target", "is not a view: reference", "");
  const list = raw["walkthroughs"];
  if (!Array.isArray(list)) r.issue("walkthroughs", "is not a list", "");
  else if (list.length > LIMITS.walkthroughs)
    r.issue("walkthroughs", `has ${list.length}, more than the limit of ${LIMITS.walkthroughs}`, "");
  const walkthroughs = (Array.isArray(list) ? list.slice(0, LIMITS.walkthroughs) : []).map(
    (w, i) => walkthrough(r, w, `walkthroughs[${i}]`) as Walkthrough | null,
  );
  const ids = walkthroughs.flatMap((w) => (w === null ? [] : [w.id]));
  if (new Set(ids).size !== ids.length) r.issue("walkthroughs", "has two walkthroughs with one id", "");
  if (r.issues.length > 0)
    return {
      ok: false,
      problem:
        r.issues
          .slice(0, 4)
          .map((i) => `${i.where} ${i.problem}`)
          .join("; ") + (r.issues.length > 4 ? `; and ${r.issues.length - 4} more` : ""),
    };
  return {
    ok: true,
    file: {
      schemaVersion: WALKTHROUGHS_SCHEMA_VERSION,
      target: target as `view:${string}`,
      walkthroughs: walkthroughs as Walkthrough[],
    },
  };
}

// -------------------------------------------------------------- serializing

function orderedStep(s: Step): Step {
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    what: s.what,
    ...(s.why === undefined ? {} : { why: s.why }),
    ...(s.code === undefined || s.code.length === 0 ? {} : { code: [...s.code] }),
    ...(s.nodes === undefined || s.nodes.length === 0
      ? {}
      : { nodes: s.nodes.map((n) => ({ kind: n.kind, id: n.id, label: n.label })) }),
    ...(s.edges === undefined || s.edges.length === 0
      ? {}
      : {
          edges: s.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            ...(e.label === undefined ? {} : { label: e.label }),
          })),
        }),
    ...(s.messages === undefined || s.messages.length === 0
      ? {}
      : { messages: s.messages.map((m) => ({ from: m.from, to: m.to, label: m.label })) }),
  };
}

/** A walkthrough rebuilt in the contract's field order, optional fields present only when set. */
export function ordered(w: Walkthrough): Walkthrough {
  return {
    id: w.id,
    title: w.title,
    ...(w.description === undefined ? {} : { description: w.description }),
    revision: w.revision,
    modelRevision: w.modelRevision,
    ...(w.commit === undefined ? {} : { commit: w.commit }),
    author: w.author,
    writtenAt: w.writtenAt,
    ...(w.note === undefined ? {} : { note: w.note }),
    ...(w.open === undefined || w.open.length === 0 ? {} : { open: [...w.open] }),
    steps: w.steps.map(orderedStep),
  };
}

/** The file's bytes: pretty-printed, fixed key order, one step per object. */
export function serializeWalkthroughs(file: WalkthroughsFile): string {
  return `${JSON.stringify({ schemaVersion: WALKTHROUGHS_SCHEMA_VERSION, target: file.target, walkthroughs: file.walkthroughs.map(ordered) }, null, 2)}\n`;
}

// ------------------------------------------------------------------- store

/** A walkthrough's content as grounding produced it: labels and ends from the model, no revision yet. */
export type GroundedWalkthrough = Omit<
  Walkthrough,
  "revision" | "modelRevision" | "commit" | "author" | "writtenAt" | "steps"
> & {
  /** A step's id is the caller's, or absent: the store assigns it from the stored walkthrough (step-ids.ts). */
  readonly steps: readonly (Omit<Step, "id"> & { readonly id?: string })[];
};

export interface WriteInput {
  readonly walkthrough: GroundedWalkthrough;
  /** The model the ids were checked against (the caller checks it is the current one). */
  readonly modelRevision: string;
  readonly author: Author;
  /** Required to replace a walkthrough: the revision read. Naming one that does not exist is refused. */
  readonly expectedRevision?: number;
  /** A full commit whose blob has `modelRevision`. */
  readonly commit?: string;
}

export type WalkthroughsRead =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly file: WalkthroughsFile; readonly bytes: Buffer }
  | { readonly kind: "malformed"; readonly problem: string };

export interface StoreOptions {
  readonly now?: () => string;
}

export class WalkthroughsStore {
  readonly #now: () => string;

  constructor(
    readonly project: Project,
    options: StoreOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** The view's walkthroughs (none when there is no file), under its own target whatever the file says. */
  read(place: WalkthroughsPlace): WalkthroughsFile {
    refuseConflict(place);
    const read = this.#read(place.path);
    if (read.kind === "malformed") throw new WalkthroughsError("malformed_walkthroughs_file", read.problem);
    return {
      schemaVersion: WALKTHROUGHS_SCHEMA_VERSION,
      target: `view:${place.viewId}`,
      walkthroughs: read.kind === "ok" ? read.file.walkthroughs : [],
    };
  }

  /** The file as it is on disk, without throwing: for the watcher's signature. */
  peek(place: WalkthroughsPlace): WalkthroughsRead {
    try {
      return this.#read(place.path);
    } catch (error) {
      return { kind: "malformed", problem: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What walkthrough and step comment anchors are checked against (ADR 0034 §9); null when the file cannot be read. */
  subjects(place: WalkthroughsPlace | undefined): Map<string, WalkthroughSubject> | null {
    if (place === undefined) return null;
    try {
      return new Map(
        this.read(place).walkthroughs.map((w) => [
          w.id,
          { title: w.title, steps: w.steps.map((s) => ({ id: s.id, title: s.title })) },
        ]),
      );
    } catch {
      return null;
    }
  }

  /** Creates the walkthrough, or replaces the one with its id at `expectedRevision`. Returns it as stored. */
  write(place: WalkthroughsPlace, input: WriteInput): Walkthrough {
    refuseConflict(place);
    return this.#update(place, (list) => {
      const at = list.findIndex((w) => w.id === input.walkthrough.id);
      const held = at < 0 ? undefined : list[at];
      if (held === undefined && input.expectedRevision !== undefined)
        throw invalid([
          {
            where: "id",
            problem: `no walkthrough ${JSON.stringify(input.walkthrough.id)} on this diagram to replace`,
            fix: "Leave expectedRevision out to create it, or use the id list_walkthroughs shows.",
          },
        ]);
      if (held !== undefined && input.expectedRevision !== held.revision) throw changed(held, input.expectedRevision);
      if (held === undefined && list.length >= LIMITS.walkthroughs)
        throw invalid([
          {
            where: "walkthroughs",
            problem: `the diagram already has ${list.length} walkthroughs, the most one diagram keeps (${LIMITS.walkthroughs})`,
            fix: "Replace or delete one first.",
          },
        ]);
      // A recorded commit still vouches for the same model, so a rewrite keeps it: a later commit that also holds the
      // model, or none found, is not a change (a new model revision starts without one).
      const commit =
        held?.commit !== undefined && held.modelRevision === input.modelRevision ? held.commit : input.commit;
      const draft: Walkthrough = ordered({
        ...input.walkthrough,
        steps: assignStepIds(input.walkthrough.steps, held?.steps),
        revision: held === undefined ? 1 : held.revision + 1,
        modelRevision: input.modelRevision,
        ...(commit === undefined ? {} : { commit }),
        author: input.author,
        writtenAt: this.#now(),
      });
      // The same content against the same model is no change: nothing is written, and the revision holds.
      if (held !== undefined && sameContent(held, draft)) return { list, value: held };
      const next = at < 0 ? [...list, draft] : list.map((w, i) => (i === at ? draft : w));
      return { list: next, value: draft };
    });
  }

  /** Deletes the walkthrough at `expectedRevision`; the file goes with its last one. */
  remove(place: WalkthroughsPlace, id: string, expectedRevision: number): void {
    refuseConflict(place);
    this.#update(place, (list) => {
      const held = list.find((w) => w.id === id);
      if (held === undefined)
        throw invalid([
          {
            where: "id",
            problem: `no walkthrough ${JSON.stringify(id.slice(0, 64))} on this diagram`,
            fix: "Use an id list_walkthroughs shows.",
          },
        ]);
      if (held.revision !== expectedRevision) throw changed(held, expectedRevision, "delete");
      return { list: list.filter((w) => w.id !== id), value: undefined };
    });
  }

  // ------------------------------------------------------------ internals

  #shown(path: string): string {
    return posix.join(this.project.folderSetting, path);
  }

  #absolute(path: string): string {
    try {
      return resolveInFolder(this.project, path);
    } catch (error) {
      if (error instanceof ProjectError)
        throw new WalkthroughsError(
          "malformed_walkthroughs_file",
          `${this.#shown(path)} cannot be reached inside the Archer folder: ${error.message}`,
        );
      throw error;
    }
  }

  #read(path: string): WalkthroughsRead {
    let absolute: string;
    try {
      absolute = this.#absolute(path);
    } catch (error) {
      if (error instanceof WalkthroughsError) return { kind: "malformed", problem: error.message };
      throw error;
    }
    let bytes: Buffer;
    try {
      const info = lstatSync(absolute);
      if (!info.isFile())
        return {
          kind: "malformed",
          problem: `${this.#shown(path)} is not a plain file, so its walkthroughs are not read; replace it with one`,
        };
      // The confined seam (G6): no link followed, one name, read from the descriptor.
      bytes = readInFolder(this.project, path, LIMITS.fileBytes);
    } catch (error) {
      if (error instanceof ConfinedTooLarge)
        return {
          kind: "malformed",
          problem: `${this.#shown(path)} is over ${LIMITS.fileBytes} bytes and was not read`,
        };
      if (error instanceof ConfinedRefusal)
        return { kind: "malformed", problem: `${this.#shown(path)} was not read: ${error.message}` };
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return {
        kind: "malformed",
        problem: `${this.#shown(path)} is not JSON in UTF-8, so its walkthroughs cannot be read; fix or remove it`,
      };
    }
    const checked = validateWalkthroughsFile(parsed);
    if (!checked.ok)
      return {
        kind: "malformed",
        problem: `${this.#shown(path)} cannot be read as walkthroughs: ${checked.problem}; fix or remove it`,
      };
    return { kind: "ok", file: checked.file, bytes };
  }

  #rawBytes(path: string): Buffer | null {
    this.#absolute(path);
    try {
      return readInFolder(this.project, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  #update<T>(
    place: WalkthroughsPlace,
    change: (list: readonly Walkthrough[]) => { list: readonly Walkthrough[]; value: T },
  ): T {
    try {
      return withCommentsLock(this.project, place.path, () => this.#updateLocked(place, change));
    } catch (error) {
      if (error instanceof CommentsLockError)
        throw new WalkthroughsError(
          "write_conflict",
          `${this.#shown(place.path)} is being changed by another process; try again`,
          undefined,
          { cause: error },
        );
      // The account's write rules keep their own refusal (write_rule_denied), as comments' do.
      if (error instanceof WriteRuleDenied || error instanceof WalkthroughsError) throw error;
      // A folder that cannot hold the file (a linked parent, a lock directory that cannot be made):
      // nothing was written, and the caller gets a stable code rather than an internal error.
      if (error instanceof ProjectError || error instanceof ConfinedWriteRefusedError)
        throw new WalkthroughsError(
          "write_conflict",
          `${this.#shown(place.path)} could not be written: ${error.message}`,
          undefined,
          { cause: error },
        );
      throw error;
    }
  }

  #updateLocked<T>(
    place: WalkthroughsPlace,
    change: (list: readonly Walkthrough[]) => { list: readonly Walkthrough[]; value: T },
  ): T {
    const target = `view:${place.viewId}` as const;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const read = this.#read(place.path);
      if (read.kind === "malformed") throw new WalkthroughsError("malformed_walkthroughs_file", read.problem);
      const before = read.kind === "ok" ? read.file.walkthroughs : [];
      const outcome = change(before);
      // Nothing changed: the file is left exactly as it is, canonical or not.
      if (outcome.list === before) return outcome.value;
      const next: WalkthroughsFile = {
        schemaVersion: WALKTHROUGHS_SCHEMA_VERSION,
        target,
        walkthroughs: [...outcome.list],
      };
      const was = read.kind === "ok" ? read.bytes : null;
      const serialized = serializeWalkthroughs(next);
      if (outcome.list.length === 0 ? was === null : was !== null && was.toString("utf8") === serialized)
        return outcome.value;
      if (Buffer.byteLength(serialized) > LIMITS.fileBytes)
        throw invalid([
          {
            where: "walkthroughs",
            problem: `the file would be ${Buffer.byteLength(serialized)} bytes, more than the limit of ${LIMITS.fileBytes}`,
            fix: "Shorten the steps, or delete a walkthrough first.",
          },
        ]);
      // Another process may have written the file since it was read: start over on its version.
      const now = this.#rawBytes(place.path);
      if (!(now === null ? was === null : was !== null && now.equals(was))) continue;
      if (outcome.list.length === 0) {
        assertWriteAllowed(this.project.root, WRITE_RULE);
        this.#absolute(place.path);
        removeInFolder(this.project, place.path);
      } else writeConfined(this.project, place.path, serialized, WRITE_RULE);
      return outcome.value;
    }
    throw new WalkthroughsError(
      "write_conflict",
      `${this.#shown(place.path)} kept changing while it was being written; try again`,
    );
  }
}

function refuseConflict(place: WalkthroughsPlace): void {
  if (place.conflict !== undefined) throw new WalkthroughsError("walkthroughs_file_conflict", place.conflict);
}

function changed(
  held: Walkthrough,
  expected: number | undefined,
  again: "write" | "delete" = "write",
): WalkthroughsError {
  const read = expected === undefined ? "named no expectedRevision" : `read revision ${expected}`;
  return new WalkthroughsError(
    "walkthrough_changed",
    `walkthrough ${held.id} is at revision ${held.revision} and you ${read}, so nothing was written. Read it as it is now (below), then ${again} it again with expectedRevision ${held.revision}.`,
    { walkthrough: held },
  );
}

/**
 * Whether two stored walkthroughs say the same against the same model: all but
 * revision, author and time. A `commit` newly recorded for a walkthrough that had none counts as a
 * change, so old-version playback (ADR 0034 §3) gains it.
 */
function sameContent(a: Walkthrough, b: Walkthrough): boolean {
  const strip = ({ revision: _r, author: _a, writtenAt: _w, ...rest }: Walkthrough) => rest;
  return JSON.stringify(strip(ordered(a))) === JSON.stringify(strip(ordered(b)));
}
