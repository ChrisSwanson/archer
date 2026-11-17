import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CommentsStore, validateCommentsFile } from "../../src/comments/store.ts";
import { getComments } from "../../src/comments/agent.ts";
import { sequenceBlocks } from "../../src/comments/sequence-blocks.ts";
import { scopedIdentitiesOf } from "../../src/comments/scoped-identities.ts";
import { compile } from "../../src/mermaid/index.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { findProject, revisionOf } from "../../src/project/index.ts";
import { call, connect, removeTempDirs, structured, tempDir } from "../mcp/support.ts";

afterEach(removeTempDirs);

const header = "sequenceDiagram\n  participant A\n  participant B\n";
const chosen = "  alt authorized\n    A->>B: Read record\n  else denied\n    B-->>A: Refuse\n  end\n";
const other = "  loop retry\n    A->>B: Try again\n  end\n";

for (const [name, before, after, expectedId, orphaned] of [
  ["inserting an earlier block", chosen, other + chosen, "frag-1", false],
  ["reordering blocks offline", chosen + other, other + chosen, "frag-1", false],
  ["duplicating a block offline", chosen, chosen + chosen, "frag-0", true],
] as const) {
  test(`a block comment never retargets after ${name}, including a process restart`, async () => {
    const root = tempDir({ ".archer/sequence.mmd": header + before });
    const first = await connect({ cwd: root });
    try {
      const thread = structured(
        await call(first.client, "create_comment", {
          target: "view:sequence",
          anchor: { kind: "group", id: "frag-0", label: "untrusted" },
          body: "Review this whole alternative",
        }),
      ) as unknown as Thread;
      expect(thread.anchor).toMatchObject({ kind: "group", id: "frag-0", label: "authorized" });
      const store = new CommentsStore(findProject(root));
      store.reply(thread.id, "Please check", "person");
      store.submit();
    } finally {
      await first.close();
    }
    writeFileSync(join(root, ".archer/sequence.mmd"), header + after);
    const restarted = await connect({ cwd: root });
    try {
      const got = structured(await call(restarted.client, "get_comments")) as unknown as { threads: Thread[] };
      expect(got.threads).toHaveLength(1);
      expect(got.threads[0]?.anchor).toMatchObject({ kind: "group", id: expectedId, label: "authorized" });
      expect(got.threads[0]?.orphaned === true).toBe(orphaned);
    } finally {
      await restarted.close();
    }
  });
}

async function open(root: string, id = "frag-0"): Promise<Thread> {
  const connection = await connect({ cwd: root });
  try {
    const thread = structured(
      await call(connection.client, "create_comment", {
        target: "view:sequence",
        anchor: { kind: "group", id },
        body: "Review the block",
      }),
    ) as unknown as Thread;
    const store = new CommentsStore(findProject(root));
    store.reply(thread.id, "Please check", "person");
    store.submit();
    return thread;
  } finally {
    await connection.close();
  }
}

async function feedback(root: string): Promise<Thread & { references: Record<string, unknown> }> {
  const connection = await connect({ cwd: root });
  try {
    const got = structured(await call(connection.client, "get_comments")) as unknown as {
      threads: (Thread & { references: Record<string, unknown> })[];
    };
    expect(got.threads).toHaveLength(1);
    return got.threads[0]!;
  } finally {
    await connection.close();
  }
}

test("an edited block orphans instead of adopting a different meaning; its unique unchanged content can return", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + chosen });
  await open(root);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + chosen.replace("Read record", "Delete record"));
  const missing = await feedback(root);
  expect(missing.orphaned).toBe(true);
  expect(missing.anchor).toMatchObject({ id: "frag-0", label: "authorized" });
  expect(missing.references).not.toHaveProperty("lines");
  expect(missing.references).not.toHaveProperty("sequenceBlock");
  writeFileSync(join(root, ".archer/sequence.mmd"), header + other + chosen);
  const back = await feedback(root);
  expect(back.anchor).toMatchObject({ id: "frag-1" });
  expect(back.orphaned).not.toBe(true);
});

test("get_comments explains the whole block and every contained message and note, including nested sections", async () => {
  const block =
    "  alt authorized\n    Note over A,B: Security boundary\n    A->>B: Read record\n    opt audit\n      B-->>A: Recorded\n    end\n  else denied\n    B-->>A: Refuse\n  end\n";
  const root = tempDir({ ".archer/sequence.mmd": header + block + other });
  await open(root);
  const got = await feedback(root);
  expect(got.references).not.toHaveProperty("lines");
  expect(got.references.sequenceBlock).toEqual({
    kind: "alt",
    condition: "authorized",
    messageIds: ["msg-0", "msg-1", "msg-2"],
    noteIds: ["note-0"],
    modelRevision: revisionOf(Buffer.from(header + block + other)),
  });
});

test("a nested block does not adopt an identical child of a same-header parent after its parent disappears", async () => {
  const inner = "    opt audit\n      A->>B: Record audit\n    end\n";
  const parent = (message: string) => `  alt authorized\n    A->>B: ${message}\n${inner}  end\n`;
  const root = tempDir({ ".archer/sequence.mmd": header + parent("Read record") + parent("Delete record") });
  await open(root, "frag-1");
  writeFileSync(join(root, ".archer/sequence.mmd"), header + parent("Delete record"));
  const got = await feedback(root);
  expect(got.orphaned).toBe(true);
  expect(got.references).not.toHaveProperty("sequenceBlock");
});

test("observed duplicates stay ambiguous when the original is removed", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + chosen });
  await open(root);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + chosen + chosen);
  expect((await feedback(root)).orphaned).toBe(true);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + chosen);
  expect((await feedback(root)).orphaned).toBe(true);
});

test("a comment on a duplicate is preserved as an orphan and never attaches after either copy is removed", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + chosen + chosen });
  await open(root, "frag-1");
  expect((await feedback(root)).orphaned).toBe(true);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + chosen);
  expect((await feedback(root)).orphaned).toBe(true);
});

for (const changed of [false, true] as const) {
  test(`legacy block comments ${changed ? "orphan after offline edits" : "upgrade only on their exact original revision"}`, async () => {
    const root = tempDir({ ".archer/sequence.mmd": header + chosen });
    await open(root);
    const path = join(root, ".archer/sequence.comments.json");
    const old = JSON.parse(readFileSync(path, "utf8"));
    old.version = 5;
    delete old.threads[0].identity;
    writeFileSync(path, JSON.stringify(old));
    if (changed) writeFileSync(join(root, ".archer/sequence.mmd"), header + other + chosen);
    const got = await feedback(root);
    expect(got.orphaned === true).toBe(changed);
    if (changed) {
      expect(got.anchor).toMatchObject({ id: "frag-0", label: "authorized" });
      expect(got).not.toHaveProperty("identity");
      expect(got.references).not.toHaveProperty("lines");
    } else expect(got.identity).toMatchObject({ version: 1, unique: true });
  });
}

for (const unreadable of ["invalid", "deleted"] as const) {
  test(`legacy block comments make no current scope claims when the source is ${unreadable}`, async () => {
    const root = tempDir({ ".archer/sequence.mmd": header + chosen });
    await open(root);
    const path = join(root, ".archer/sequence.comments.json");
    const old = JSON.parse(readFileSync(path, "utf8"));
    old.version = 5;
    delete old.threads[0].identity;
    writeFileSync(path, JSON.stringify(old));
    if (unreadable === "deleted") rmSync(join(root, ".archer/sequence.mmd"));
    else writeFileSync(join(root, ".archer/sequence.mmd"), header + "  alt broken\n");
    const got = await feedback(root);
    expect(got.orphaned).toBe(true);
    expect(got.references).not.toHaveProperty("sequenceBlock");
    expect(got.references).not.toHaveProperty("lines");
  });
}

test("version-6 identity validates strictly and stays optional for older sidecars", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + chosen });
  const original = await open(root);
  const raw = JSON.parse(readFileSync(join(root, ".archer/sequence.comments.json"), "utf8"));
  expect(validateCommentsFile(raw)).toMatchObject({ ok: true, file: { version: 6 } });
  expect(original.identity).toMatchObject({ version: 1, unique: true });
  for (const metadata of [
    null,
    [],
    {},
    { ...original.identity, version: 2 },
    { ...original.identity, fingerprint: "sha256:no" },
    { ...original.identity, unique: 1 },
    { ...original.identity, extra: true },
  ]) {
    expect(
      validateCommentsFile({ ...raw, threads: [{ ...raw.threads[0], identity: metadata }] }),
      JSON.stringify(metadata),
    ).toMatchObject({ ok: false });
  }
  for (const version of [2, 3, 4, 5]) {
    const older = structuredClone(raw);
    older.version = version;
    delete older.threads[0].identity;
    if (version < 5) delete older.threads[0].modelRevision;
    expect(validateCommentsFile(older), String(version)).toMatchObject({ ok: true });
  }
  expect(validateCommentsFile({ ...raw, version: 5 })).toMatchObject({ ok: false });
  expect(
    validateCommentsFile({
      ...raw,
      threads: [{ ...raw.threads[0], identity: { ...original.identity, unique: false }, orphaned: undefined }],
    }),
  ).toMatchObject({ ok: false });
});

test("an agent's older compiled snapshot never supplies descendants for a newer thread with the same positional id", async () => {
  const snapshot = await compile(header + chosen);
  expect(snapshot.model?.type).toBe("sequence-trace");
  if (snapshot.model?.type !== "sequence-trace") throw new Error("sequence did not compile");
  const root = tempDir({ ".archer/sequence.mmd": header + other + chosen });
  await open(root);
  const answer = getComments(findProject(root), "view:sequence", {
    scopes: new Map([
      [
        "view:sequence",
        {
          sequence: {
            blocks: sequenceBlocks(snapshot.model),
            notes: [],
            identities: scopedIdentitiesOf(snapshot.model),
          },
          threadIds: new Set<string>(),
        },
      ],
    ]),
  });
  const got = (answer.structured.threads as (Thread & { references: Record<string, unknown> })[])[0]!;
  expect(got.orphaned).toBe(true);
  expect(got.references).not.toHaveProperty("sequenceBlock");
  expect(got.references).not.toHaveProperty("lines");
});

test("an earlier standalone message cannot make an older scope snapshot claim shifted child ids for a new thread", async () => {
  const snapshot = await compile(header + chosen);
  expect(snapshot.model?.type).toBe("sequence-trace");
  if (snapshot.model?.type !== "sequence-trace") throw new Error("sequence did not compile");
  const root = tempDir({ ".archer/sequence.mmd": header + "  A->>B: Earlier message\n" + chosen });
  await open(root);
  const answer = getComments(findProject(root), "view:sequence", {
    scopes: new Map([
      [
        "view:sequence",
        {
          sequence: {
            blocks: sequenceBlocks(snapshot.model),
            notes: [],
            identities: scopedIdentitiesOf(snapshot.model),
          },
          threadIds: new Set<string>(),
        },
      ],
    ]),
  });
  const got = (answer.structured.threads as (Thread & { references: Record<string, unknown> })[])[0]!;
  expect(got.orphaned).toBe(true);
  expect(got.references).not.toHaveProperty("sequenceBlock");
  expect(got.references).not.toHaveProperty("lines");
});
