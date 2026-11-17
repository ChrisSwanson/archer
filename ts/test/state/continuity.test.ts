// The continuity file is advisory restart state (src/state/continuity.ts): its parser is a trust
// boundary that never throws, and the store drops an unsafe or invalid file instead of failing the
// project's open. Seeded inputs, so a failure reproduces.
import { chmodSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AccountStateStore, PersistenceError } from "../../src/state/account.ts";
import {
  MAX_BASELINE_FILES,
  MAX_CONTINUITY_WRITES,
  parseContinuity,
  serializeContinuity,
  type ContinuityRecord,
} from "../../src/state/continuity.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

const ROOT = "/project";
const REV = `sha256:${"a".repeat(64)}`;
const valid: ContinuityRecord = {
  version: 1,
  root: ROOT,
  files: {
    policy: REV,
    entries: [
      { path: ".archer/flow.mmd", kind: "diagram", revision: REV },
      { path: "docs/x.md", kind: "document" },
    ],
  },
  writes: [
    { viewId: "flow", at: 1_700_000_000_000, summary: "named it" },
    { viewId: "notes/n.md#plan", at: 1 },
  ],
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS: unknown[] = [
  null,
  true,
  0,
  -1,
  1.5,
  2 ** 60,
  "",
  "flow",
  "../x",
  REV,
  "sha256:zz",
  "diagram",
  "note",
  "x".repeat(300),
  ROOT,
  "/other",
  [],
  {},
];
const KEYS = [
  "version",
  "root",
  "files",
  "writes",
  "policy",
  "entries",
  "path",
  "kind",
  "revision",
  "viewId",
  "at",
  "summary",
  "extra",
];

function value(next: () => number, depth: number): unknown {
  const r = next();
  if (depth > 4 || r < 0.4) return ATOMS[Math.floor(next() * ATOMS.length)];
  if (r < 0.7) return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
  return Object.fromEntries(
    Array.from({ length: Math.floor(next() * 5) }, () => [
      KEYS[Math.floor(next() * KEYS.length)]!,
      value(next, depth + 1),
    ]),
  );
}

/** A valid record with one field somewhere replaced by a random value. */
function mutated(next: () => number): unknown {
  const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  const targets: [Record<string, unknown>, string][] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      targets.push([v as Record<string, unknown>, k]);
      walk(child);
    }
  };
  walk(copy);
  const [holder, key] = targets[Math.floor(next() * targets.length)]!;
  holder[key] = value(next, 2);
  return copy;
}

function check(text: string): void {
  let parsed: ContinuityRecord | null = null;
  expect(
    () => {
      parsed = parseContinuity(text, ROOT);
    },
    text.slice(0, 200),
  ).not.toThrow();
  if (parsed === null) return;
  const record = parsed as ContinuityRecord;
  expect(record.root).toBe(ROOT);
  expect(record.writes.length).toBeLessThanOrEqual(MAX_CONTINUITY_WRITES);
  // What is accepted round-trips exactly through the writer.
  expect(parseContinuity(serializeContinuity(record), ROOT)).toEqual(record);
}

test("the parser never throws and accepts only bounded records for its root", () => {
  const next = random(0x5eed);
  for (let i = 0; i < 2_000; i++) {
    const r = next();
    const text =
      r < 0.2
        ? Array.from({ length: Math.floor(next() * 40) }, () => String.fromCharCode(Math.floor(next() * 128))).join("")
        : JSON.stringify(r < 0.6 ? value(next, 0) : mutated(next));
    check(text);
  }
  for (const odd of [undefined, 42, "[".repeat(100_000), '"' + "x".repeat(5 * 1024 * 1024) + '"'])
    expect(() => parseContinuity(odd, ROOT)).not.toThrow();
  expect(parseContinuity(JSON.stringify(valid), ROOT)).toEqual(valid);
  expect(parseContinuity(JSON.stringify(valid), "/other")).toBeNull();
}, 30_000);

test("an invalid baseline drops only the baseline, an invalid write only that write", () => {
  const badFiles = {
    ...valid,
    files: { ...valid.files!, entries: [...valid.files!.entries, valid.files!.entries[0]!] },
  };
  expect(parseContinuity(JSON.stringify(badFiles), ROOT)).toEqual({ version: 1, root: ROOT, writes: valid.writes });
  const badWrite = { ...valid, writes: [...valid.writes, { viewId: "../x", at: 3 }] };
  expect(parseContinuity(JSON.stringify(badWrite), ROOT)).toEqual(valid);
});

test("a baseline past its bounds is not written, and the rest is", () => {
  const entries = Array.from({ length: MAX_BASELINE_FILES + 1 }, (_, i) => ({
    path: `n${i}.md`,
    kind: "note" as const,
  }));
  expect(parseContinuity(serializeContinuity({ ...valid, files: { policy: REV, entries } }), ROOT)).toEqual({
    version: 1,
    root: ROOT,
    writes: valid.writes,
  });
});

test("the store reads back what it saved, and drops an unsafe, foreign or invalid file without throwing", () => {
  const store = new AccountStateStore(tempDir());
  expect(store.continuity(ROOT)).toBeNull();
  store.saveContinuity(ROOT, serializeContinuity(valid));
  expect(store.continuity(ROOT)).toEqual(valid);
  expect(() => store.saveContinuity(ROOT, "{}")).toThrow(PersistenceError);
  const file = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".continuity.json"))!);
  chmodSync(file, 0o644);
  expect(store.continuity(ROOT)).toBeNull();
  chmodSync(file, 0o600);
  writeFileSync(file, "{broken");
  expect(store.continuity(ROOT)).toBeNull();
  unlinkSync(file);
  const elsewhere = join(tempDir(), "x.json");
  writeFileSync(elsewhere, serializeContinuity(valid), { mode: 0o600 });
  symlinkSync(elsewhere, file);
  expect(store.continuity(ROOT)).toBeNull();
});
