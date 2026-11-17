import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CommentsStore, validateCommentsFile } from "../../src/comments/store.ts";
import { createComment, getCommentsWithBlocks } from "../../src/comments/agent.ts";
import { findProject } from "../../src/project/index.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { removeTempDirs, tempDir } from "../mcp/support.ts";

afterEach(removeTempDirs);
const header = "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n";
const note = "  Note over A,B: Body MAY be short and stout\n";
const earlier = "  Note right of B: Another annotation\n";
const block = (content: string) => `  opt body\n${content}    A->>B: Send body\n  end\n`;

async function open(root: string, id = "note-0"): Promise<Thread> {
  const project = findProject(root);
  const answer = await createComment(
    project,
    "view:sequence",
    { kind: "node", id, label: "untrusted" },
    "Review this note",
  );
  const thread = answer.structured as unknown as Thread;
  const store = new CommentsStore(project);
  store.reply(thread.id, "Please check", "person");
  store.submit();
  return thread;
}

async function feedback(
  root: string,
): Promise<{ thread: Thread & { references: Record<string, unknown> }; text: string }> {
  const answer = await getCommentsWithBlocks(findProject(root), "view:sequence");
  const threads = answer.structured.threads as (Thread & { references: Record<string, unknown> })[];
  expect(threads).toHaveLength(1);
  return { thread: threads[0]!, text: answer.text };
}

for (const [name, before, after, expectedId] of [
  ["inserting an earlier note", note, earlier + note, "note-1"],
  ["inserting a standalone message", note, "  A->>B: Earlier message\n" + note, "note-0"],
  [
    "reordering standalone messages",
    "  A->>B: Earlier message\n" + note,
    note + "  A->>B: Earlier message\n",
    "note-0",
  ],
  ["reordering standalone notes", note + earlier, earlier + note, "note-1"],
  ["inserting a note inside its block", block(note), block(earlier + note), "note-1"],
  ["reordering notes inside its block", block(note + earlier), block(earlier + note), "note-1"],
] as const) {
  test(`a note comment survives ${name} after reopening the project`, async () => {
    const root = tempDir({ ".archer/sequence.mmd": header + before });
    const opened = await open(root);
    expect(opened.anchor).toEqual({ kind: "node", id: "note-0", label: "Body MAY be short and stout" });
    expect(opened).toHaveProperty("identity");
    writeFileSync(join(root, ".archer/sequence.mmd"), header + after);
    const { thread } = await feedback(root);
    expect(thread.anchor).toEqual({ kind: "node", id: expectedId, label: "Body MAY be short and stout" });
    expect(thread.orphaned).not.toBe(true);
  });
}

test("get_comments names the note, its participants and its enclosing block without claiming a generated source line", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + block(note) });
  await open(root);
  const { thread, text } = await feedback(root);
  expect(thread.references).not.toHaveProperty("lines");
  expect(thread.references.sequenceNote).toMatchObject({
    text: "Body MAY be short and stout",
    position: "over",
    participants: [
      { id: "A", label: "Alice" },
      { id: "B", label: "Bob" },
    ],
    block: { id: "frag-0", kind: "opt", condition: "body" },
  });
  expect(text).toContain('Note "Body MAY be short and stout"');
  expect(text).toContain("Alice (A), Bob (B)");
  expect(text).toContain('opt block "body"');
});

for (const [name, changed] of [
  ["deleted", earlier],
  ["edited", note.replace("short and stout", "long")],
  ["retargeted", note.replace("over A,B", "over A")],
  ["duplicated", note + note],
  ["uncompilable", "  opt unfinished\n"],
] as const) {
  test(`a ${name} note is orphaned and supplies no current note context`, async () => {
    const root = tempDir({ ".archer/sequence.mmd": header + note });
    await open(root);
    writeFileSync(join(root, ".archer/sequence.mmd"), header + changed);
    const { thread } = await feedback(root);
    expect(thread.orphaned).toBe(true);
    expect(thread.anchor).toMatchObject({ label: "Body MAY be short and stout" });
    expect(thread.references).not.toHaveProperty("sequenceNote");
    expect(thread.references).not.toHaveProperty("lines");
    if (name === "duplicated") {
      writeFileSync(join(root, ".archer/sequence.mmd"), header + note);
      expect((await feedback(root)).thread.orphaned).toBe(true);
    }
  });
}

test("a note never adopts an identical annotation in a same-header block with different meaning", async () => {
  const first = block(note);
  const second = block(note).replace("Send body", "Delete body");
  const root = tempDir({ ".archer/sequence.mmd": header + first + second });
  await open(root);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + second);
  expect((await feedback(root)).thread.orphaned).toBe(true);
});

test("sequence-note metadata validates strictly and remains optional for legacy files", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + note });
  await open(root);
  const raw = JSON.parse(readFileSync(join(root, ".archer/sequence.comments.json"), "utf8"));
  expect(raw.version).toBe(6);
  expect(validateCommentsFile(raw)).toMatchObject({ ok: true });
  for (const metadata of [
    null,
    {},
    { ...raw.threads[0].identity, unique: 1 },
    { ...raw.threads[0].identity, extra: true },
  ])
    expect(validateCommentsFile({ ...raw, threads: [{ ...raw.threads[0], identity: metadata }] })).toMatchObject({
      ok: false,
    });
  const legacy = structuredClone(raw);
  legacy.version = 5;
  delete legacy.threads[0].identity;
  expect(validateCommentsFile(legacy)).toMatchObject({ ok: true });
  expect(
    validateCommentsFile({
      ...raw,
      threads: [{ ...raw.threads[0], anchor: { kind: "edge", id: "A", label: "Alice" } }],
    }),
  ).toMatchObject({ ok: false });
});

test("a note id colliding with an authored participant refuses new ambiguous comments and preserves existing participant threads", async () => {
  const source = "sequenceDiagram\n  participant note-0 as Original participant\n  participant B\n";
  const root = tempDir({ ".archer/sequence.mmd": source });
  const project = findProject(root);
  const answer = await createComment(
    project,
    "view:sequence",
    { kind: "node", id: "note-0", label: "" },
    "Participant feedback",
  );
  const original = answer.structured as unknown as Thread;
  const store = new CommentsStore(project);
  store.reply(original.id, "Review participant", "person");
  store.submit();
  writeFileSync(join(root, ".archer/sequence.mmd"), source + "  Note over B: Colliding annotation\n");
  await expect(
    createComment(project, "view:sequence", { kind: "node", id: "note-0", label: "" }, "Ambiguous target"),
  ).rejects.toMatchObject({ code: "invalid_comment" });
  const { thread } = await feedback(root);
  expect(thread.anchor).toEqual({ kind: "node", id: "note-0", label: "Original participant" });
  expect(thread.orphaned).not.toBe(true);
  expect(thread).not.toHaveProperty("identity");
});

test("a saved note orphans if an authored participant later takes its positional id", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + note });
  await open(root);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + "  participant note-0 as Collision\n" + note);
  expect((await feedback(root)).thread.orphaned).toBe(true);
});
