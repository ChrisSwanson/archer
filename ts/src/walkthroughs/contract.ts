// Walkthroughs (ADR 0034): named, ordered steps over one graph diagram, kept
// in `<name>.walkthroughs.json` beside it. This file is the contract: the
// shapes, the limits and the field order, as constants. The store validates
// and writes against it, resolution reads it, and the slice-2 tool schema is
// generated from it, as emphasis's is from emphasis.ts.
//
// Decisions it carries (ADR 0034 §1-§2):
// - A step names model ids only. Labels, edge ends and the walkthrough's
//   revision, model revision, commit, author and time are Archer's, never the
//   caller's: a request may carry them, and they are ignored.
// - Text is counted in characters and refused when too long, never cut.
// - Resolution against the current model is derived on read and never
//   written back; the file changes only on an explicit write.
// - `deeper` (§7) and an edge's `anchor` (sequence hosts, open question 5)
//   are reserved: refused with their own reason until their slice.
// - The answers (2026-10-23): a step may name boxes and messages
//   with no line between them, which the page says as "No line in this
//   diagram" (open question 1); "archived" is derived, never written (open
//   question 2); sequence and journey hosts are refused (open question 5).

import type { Diagnostic } from "../mermaid/diagnostics.ts";
import type { DiagramEnvelope } from "../model/index.ts";

export const WALKTHROUGHS_SCHEMA_VERSION = 1;

/** ADR 0034 §1 "Limits". */
export const LIMITS = {
  walkthroughs: 12,
  steps: 20,
  nodes: 8,
  edges: 8,
  messages: 3,
  code: 4,
  /** A walkthrough's starting open set (ADR 0029): container ids. */
  open: 32,
  fileBytes: 256 * 1024,
} as const;

/** Every text field's bound, in characters (and words where the ADR gives one). */
export const TEXT_LIMITS = {
  title: { words: 6, chars: 48 },
  description: { words: Infinity, chars: 140 },
  stepTitle: { words: Infinity, chars: 48 },
  what: { words: Infinity, chars: 200 },
  why: { words: Infinity, chars: 200 },
  /** The edge-label bound. */
  messageLabel: { words: Infinity, chars: 28 },
} as const;

/** A walkthrough id: unique in its file, and safe in `?walkthrough=` (ADR 0034 §6). */
export const WALKTHROUGH_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** A step id (ADR 0034 §9): unique in its walkthrough, kept across rewrites so a comment follows its step. Same shape as a walkthrough id. */
export const STEP_ID = WALKTHROUGH_ID;
/** A full commit id, SHA-1 or SHA-256. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The ADR 0033 §5 reference grammar: `a/b.ts`, `a/`, `a/b.ts#name`, `a/b.ts:12@c4e1a07` (as `bodyRefs`). */
export const CODE_REFERENCE = /^[\w.@-]+(?:\/[\w.@-]*)+(?:#[\w$.-]+)?(?::\d+(?:@[0-9a-f]{7,64})?)?$/;
export const MAX_CODE_REFERENCE_CHARS = 512;
export const MAX_NOTE_PATH_CHARS = 1024;

export const AUTHORS = ["agent", "person"] as const;
export const STEP_KINDS = ["sends", "does"] as const;
/** `group` because a flowchart subgraph and a node may share an id (ADR 0029 §3). */
export const NODE_KINDS = ["node", "group"] as const;
export type Author = (typeof AUTHORS)[number];
export type StepKind = (typeof STEP_KINDS)[number];
export type NodeKind = (typeof NODE_KINDS)[number];

/** Model types that cannot host a walkthrough in v1, and why (ADR 0034 §2). */
export const REFUSED_HOSTS: Readonly<Record<string, string>> = {
  "sequence-trace":
    "walkthroughs are on graph diagrams; a sequence diagram's messages have positional ids, so it cannot host one yet",
  "user-journey": "walkthroughs are on graph diagrams; a journey has no lines to walk",
};

// Field order: how a file is written, so a rewrite of an unchanged walkthrough is byte-identical.
export const FILE_KEYS = ["schemaVersion", "target", "walkthroughs"] as const;
export const WALKTHROUGH_KEYS = [
  "id",
  "title",
  "description",
  "revision",
  "modelRevision",
  "commit",
  "author",
  "writtenAt",
  "note",
  "open",
  "steps",
] as const;
export const STEP_KEYS = ["id", "title", "kind", "what", "why", "code", "nodes", "edges", "messages"] as const;
export const NODE_REF_KEYS = ["kind", "id", "label"] as const;
export const EDGE_REF_KEYS = ["id", "source", "target", "label"] as const;
export const MESSAGE_KEYS = ["from", "to", "label"] as const;
/** Written by Archer; a request may carry them (an echo of a listed walkthrough) and they are ignored. */
export const SERVER_WALKTHROUGH_KEYS = ["revision", "modelRevision", "commit", "author", "writtenAt"] as const;
export const SERVER_REF_KEYS = ["label", "source", "target"] as const;
/** Reserved fields, refused with their own reason until the slice that adds them. */
export const RESERVED: Readonly<Record<string, string>> = {
  deeper: '"Go deeper" (ADR 0034 §7) is not supported yet; remove `deeper`',
  anchor: "an edge anchor is reserved for sequence hosts (ADR 0034 §2), which are not supported yet; remove `anchor`",
};

export interface NodeRef {
  readonly kind: NodeKind;
  readonly id: string;
  /** The model's label when written: what an out-of-date step used to point at. */
  readonly label: string;
}

export interface EdgeRef {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** Absent when the line had no label. */
  readonly label?: string;
}

/** An arrow for the Sequence tab; it needs no drawn line between its ends (open question 1). */
export interface Message {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface Step {
  /** Stable within the walkthrough: comments anchor on it (ADR 0034 §9). */
  readonly id: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly what: string;
  readonly why?: string;
  readonly code?: readonly string[];
  readonly nodes?: readonly NodeRef[];
  readonly edges?: readonly EdgeRef[];
  readonly messages?: readonly Message[];
}

export interface Walkthrough {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** +1 per write of this walkthrough: the CAS counter. */
  readonly revision: number;
  /** The model it was written against (ADR 0002). */
  readonly modelRevision: string;
  /** A full commit whose blob has that revision. */
  readonly commit?: string;
  readonly author: Author;
  readonly writtenAt: string;
  /** A related note, folder-relative. */
  readonly note?: string;
  readonly open?: readonly string[];
  readonly steps: readonly Step[];
}

export interface WalkthroughsFile {
  readonly schemaVersion: typeof WALKTHROUGHS_SCHEMA_VERSION;
  /** `view:<view id>`, as comments name a target. */
  readonly target: `view:${string}`;
  readonly walkthroughs: readonly Walkthrough[];
}

/** What a caller sends: the walkthrough's content, ids only. */
export interface DraftStep {
  /** Optional in a request: a stored step with the same title keeps its id, else the title is slugged. */
  readonly id?: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly what: string;
  readonly why?: string;
  readonly code?: readonly string[];
  readonly nodes: readonly { readonly kind: NodeKind; readonly id: string }[];
  readonly edges: readonly { readonly id: string }[];
  readonly messages: readonly Message[];
}

export interface DraftWalkthrough {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly note?: string;
  readonly open?: readonly string[];
  readonly steps: readonly DraftStep[];
}

/** A refusal's entries, as `invalid_emphasis`'s: one retry can fix them all. */
export interface Issue {
  readonly where: string;
  readonly problem: string;
  readonly fix: string;
}

// --------------------------------------------------------------- resolution

/**
 * current      the id exists, and an edge joins the same ends
 * changed      the id exists, but its label is not the one stored: the step plays, its text may be stale
 * out-of-date  the id is gone, or an edge id now joins other ends
 */
export const REF_STATUSES = ["current", "changed", "out-of-date"] as const;
export type RefStatus = (typeof REF_STATUSES)[number];

/**
 * current             every step is current or changed
 * partly-out-of-date  some steps are out of date
 * archived            no step resolves: derived, so it reverses when the diagram changes back
 */
export const WALKTHROUGH_STATUSES = ["current", "partly-out-of-date", "archived"] as const;
export type WalkthroughStatus = (typeof WALKTHROUGH_STATUSES)[number];

export interface RefResolution {
  readonly status: RefStatus;
  /** The model's label now, when the reference is changed. */
  readonly label?: string;
}

export interface StepResolution {
  /** Its worst reference. */
  readonly status: RefStatus;
  readonly nodes: readonly RefResolution[];
  readonly edges: readonly RefResolution[];
  readonly messages: readonly RefResolution[];
}

export interface Resolution {
  readonly id: string;
  readonly status: WalkthroughStatus;
  /** 1-based step numbers. */
  readonly outOfDate: readonly number[];
  readonly changed: readonly number[];
  readonly steps: readonly StepResolution[];
}

/**
 * GET api/walkthroughs?viewId=<id>: the view's walkthroughs as stored, and
 * each one's resolution against the view's current model (null when the view
 * has never compiled). `deadCode` lists, per step, the code references that no
 * longer resolve (ADR 0033 §5), as 1-based step numbers with the references.
 */
export interface WalkthroughsForView {
  readonly schemaVersion: typeof WALKTHROUGHS_SCHEMA_VERSION;
  readonly viewId: string;
  readonly walkthroughs: readonly Walkthrough[];
  readonly resolution: readonly Resolution[] | null;
  readonly deadCode: readonly {
    readonly id: string;
    readonly step: number;
    readonly ref: string;
    readonly reason: string;
  }[];
  /** Set when the view's family cannot host walkthroughs (ADR 0034 §2). */
  readonly unsupported?: string;
}

/**
 * GET api/walkthroughs/old?viewId=<id>&id=<walkthrough id>: the diagram as it was when the walkthrough was
 * written (ADR 0034 §3), found from the recorded `commit` (`how: "recorded"`) or by searching the file's last
 * 200 commits (`"search"`). `found`: `envelope` is the compiled old model, drawn read-only and marked
 * "Old version · <committedAt>". `refused`: the old source no longer compiles with today's compiler
 * (`diagnostics`; show the walkthrough as text). `not-in-history`: no such revision in Git (no repository, a
 * shallow clone, or never committed); show the text only.
 */
export interface OldVersionResponse {
  readonly schemaVersion: typeof WALKTHROUGHS_SCHEMA_VERSION;
  readonly viewId: string;
  readonly id: string;
  readonly status: "found" | "refused" | "not-in-history";
  readonly how?: "recorded" | "search";
  readonly commit?: string;
  readonly committedAt?: string;
  readonly envelope?: DiagramEnvelope;
  readonly diagnostics?: readonly Diagnostic[];
  readonly reason?: "not_found" | "git_unavailable";
}

/** The `walkthroughs` server-sent event: a view's walkthroughs or their resolution changed. */
export interface WalkthroughsChanged {
  readonly viewId: string;
}
