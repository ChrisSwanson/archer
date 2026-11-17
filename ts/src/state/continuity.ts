/**
 * A project's restart continuity: runtime state that is only useful across a quick restart, kept
 * in its own private file beside the recovery record (`<key>.continuity.json`). The recovery
 * record's parser refuses unknown fields, so an older build started after an upgrade (a failed
 * hand-over, a downgrade) would refuse a record that carried these; a separate file it never
 * names is ignored instead. Unlike the recovery record this file is advisory: any problem with it
 * drops it, and the project opens as it would without it.
 */
import { isViewId } from "../model/index.ts";
import { MAX_SUMMARY_CHARS } from "../service/protocol.ts";

export const MAX_CONTINUITY_BYTES = 4 * 1024 * 1024;
/** Above this many files the baseline is not kept, and the next open takes it from disk. */
export const MAX_BASELINE_FILES = 10_000;
export const MAX_BASELINE_PATH_CHARS = 1024;
export const MAX_CONTINUITY_WRITES = 256;

export type ContinuityFileKind = "diagram" | "note" | "document";
export interface ContinuityFile {
  readonly path: string;
  readonly kind: ContinuityFileKind;
  readonly revision?: string;
}
export interface ContinuityWrite {
  readonly viewId: string;
  readonly at: number;
  readonly summary?: string;
}
export interface ContinuityRecord {
  readonly version: 1;
  readonly root: string;
  /** The `files` cue baseline: the files last announced, and the digest of the discovery policy they were listed under. */
  readonly files?: { readonly policy: string; readonly entries: readonly ContinuityFile[] };
  /** recordWrite announcements not yet seen recompiled, at their absolute time in milliseconds. */
  readonly writes: readonly ContinuityWrite[];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const KINDS: readonly string[] = ["diagram", "note", "document"];
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));

function file(v: unknown): ContinuityFile | null {
  if (
    !object(v) ||
    !only(v, ["path", "kind", "revision"]) ||
    typeof v.path !== "string" ||
    v.path === "" ||
    v.path.length > MAX_BASELINE_PATH_CHARS
  )
    return null;
  if (typeof v.kind !== "string" || !KINDS.includes(v.kind)) return null;
  if (v.revision !== undefined && (typeof v.revision !== "string" || !DIGEST.test(v.revision))) return null;
  return {
    path: v.path,
    kind: v.kind as ContinuityFileKind,
    ...(v.revision === undefined ? {} : { revision: v.revision }),
  };
}

function files(v: unknown): NonNullable<ContinuityRecord["files"]> | null {
  if (
    !object(v) ||
    !only(v, ["policy", "entries"]) ||
    typeof v.policy !== "string" ||
    !DIGEST.test(v.policy) ||
    !Array.isArray(v.entries) ||
    v.entries.length > MAX_BASELINE_FILES
  )
    return null;
  const entries: ContinuityFile[] = [],
    seen = new Set<string>();
  for (const raw of v.entries) {
    const entry = file(raw);
    if (entry === null || seen.has(entry.path)) return null;
    seen.add(entry.path);
    entries.push(entry);
  }
  return { policy: v.policy, entries };
}

function write(v: unknown): ContinuityWrite | null {
  if (
    !object(v) ||
    !only(v, ["viewId", "at", "summary"]) ||
    typeof v.viewId !== "string" ||
    v.viewId.length > MAX_BASELINE_PATH_CHARS ||
    !isViewId(v.viewId)
  )
    return null;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at < 0) return null;
  if (v.summary !== undefined && (typeof v.summary !== "string" || [...v.summary].length > MAX_SUMMARY_CHARS))
    return null;
  return { viewId: v.viewId, at: v.at, ...(v.summary === undefined ? {} : { summary: v.summary }) };
}

/**
 * The continuity record `text` holds for `root`, or null. Never throws: whatever the text, a
 * record that is not exactly this shape, within its bounds, for this root, is dropped. An invalid
 * baseline drops only the baseline; an invalid write drops only that write.
 */
export function parseContinuity(text: unknown, root: string): ContinuityRecord | null {
  try {
    if (
      typeof text !== "string" ||
      text.length > MAX_CONTINUITY_BYTES ||
      Buffer.byteLength(text) > MAX_CONTINUITY_BYTES
    )
      return null;
    const raw: unknown = JSON.parse(text);
    if (
      !object(raw) ||
      raw.version !== 1 ||
      raw.root !== root ||
      !only(raw, ["version", "root", "files", "writes"]) ||
      !Array.isArray(raw.writes) ||
      raw.writes.length > MAX_CONTINUITY_WRITES
    )
      return null;
    const baseline = raw.files === undefined ? null : files(raw.files);
    const writes: ContinuityWrite[] = [],
      seen = new Set<string>();
    for (const value of raw.writes) {
      const entry = write(value);
      if (entry === null || seen.has(entry.viewId)) continue;
      seen.add(entry.viewId);
      writes.push(entry);
    }
    return { version: 1, root, ...(baseline === null ? {} : { files: baseline }), writes };
  } catch {
    return null;
  }
}

/**
 * The record's text within its bounds: a baseline past them is left out (the next open takes it
 * from disk), and so are writes past their count. What is written always parses back as itself.
 */
export function serializeContinuity(record: ContinuityRecord): string {
  const writes = record.writes.slice(-MAX_CONTINUITY_WRITES);
  const lean: ContinuityRecord = { version: 1, root: record.root, writes };
  const baseline = record.files;
  if (
    baseline !== undefined &&
    baseline.entries.length <= MAX_BASELINE_FILES &&
    baseline.entries.every((e) => e.path.length <= MAX_BASELINE_PATH_CHARS)
  ) {
    const text = JSON.stringify({ ...lean, files: baseline });
    if (Buffer.byteLength(text) <= MAX_CONTINUITY_BYTES) return text;
  }
  return JSON.stringify(lean);
}
