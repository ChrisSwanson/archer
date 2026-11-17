import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  MAX_NOTE_EMPHASIS_PASSAGES,
  MAX_NOTE_EMPHASIS_GROUPS,
  MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
} from "../../../../shared/note-emphasis.mts";
import { NoteEmphasisStore } from "../../../src/notes/emphasis.ts";
import { findProject, MAX_NOTE_BYTES } from "../../../src/project/index.ts";

const root = mkdtempSync(join(tmpdir(), "archer-note-emphasis-clock-"));
try {
  const folder = join(root, ".archer");
  mkdirSync(folder);
  // Every `a` is a quote match, but only the last has the recorded `b`
  // suffix. This is the maximum valid note size and one valid repeated
  // anchor in all 256 allowed passage slots.
  const source = `${"a".repeat(MAX_NOTE_BYTES - 1)}b`;
  writeFileSync(join(folder, "note.md"), source);
  const passage = { kind: "passage", quote: "a", prefix: "", suffix: "b" };
  const groups = Array.from(
    { length: MAX_NOTE_EMPHASIS_PASSAGES / MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP },
    (_, index) => ({
      id: `g${index}`,
      label: `Group ${index}`,
      passages: Array.from({ length: MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP }, () => passage),
    }),
  );
  const store = new NoteEmphasisStore(findProject(root));
  const began = performance.now();
  // Three groups per named set (ADR 0030): the 256 slots take two sets.
  store.upsert(
    { notePath: "note.md", id: "maximum", groups: groups.slice(0, MAX_NOTE_EMPHASIS_GROUPS), expectedRevision: 0 },
    "agent",
  );
  const written = store.upsert(
    { notePath: "note.md", id: "rest", groups: groups.slice(MAX_NOTE_EMPHASIS_GROUPS), expectedRevision: 1 },
    "agent",
  );
  const upsertMs = performance.now() - began;
  const readBegan = performance.now();
  const read = store.read("note.md");
  const readMs = performance.now() - readBegan;
  console.log(
    JSON.stringify({
      fixtureBytes: Buffer.byteLength(source),
      passages: written.snapshot.emphases.reduce(
        (total, entry) => total + entry.groups.reduce((count, group) => count + group.passages.length, 0),
        0,
      ),
      revision: written.snapshot.revision,
      orphans: read.orphans.length,
      upsertMs,
      readMs,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
