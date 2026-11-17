import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { OperationAck, ThreadList } from "../../src/comments/contract.ts";
import { connectService } from "../../src/service/index.ts";
import { findProject, revisionOf } from "../../src/project/index.ts";
import { createComment } from "../../src/comments/agent.ts";
import { removeTempDirs, tempDir } from "../mcp/support.ts";
import { apiBase, cleanUp, commentOperation, http, json, service } from "../service/support.ts";

afterEach(cleanUp);
afterEach(removeTempDirs);

const header = "sequenceDiagram\n  participant A\n  participant B\n";
const block = "  alt authorized\n    A->>B: Read record\n  end\n";

test("page-created block identity and operation receipts survive service restart and earlier insertion", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + block });
  const first = await service();
  const client = await connectService(first.svc.socketPath);
  const page = apiBase((await client.call("attach", { root })).url);
  const payload = {
    target: "view:sequence",
    anchor: { kind: "group", id: "frag-0", label: "untrusted" },
    body: "Why this condition?",
    expectedModelRevision: revisionOf(Buffer.from(header + block)),
  };
  const operation = commentOperation.create(payload);
  const reply = await http(`${page}api/comments`, { method: "POST", body: JSON.stringify(operation) });
  expect(reply.status, reply.body).toBe(200);
  const opened = (JSON.parse(reply.body) as OperationAck).thread;
  expect(opened?.identity).toMatchObject({ version: 1, unique: true });
  const disk = JSON.parse(readFileSync(join(root, ".archer/sequence.comments.json"), "utf8"));
  expect(disk.version).toBe(6);
  expect(disk.receipts.entries).toHaveLength(1);
  client.close();
  await first.svc.close();
  writeFileSync(join(root, ".archer/sequence.mmd"), header + "  loop retry\n    A->>B: Try again\n  end\n" + block);
  const second = await service();
  const restarted = await connectService(second.svc.socketPath);
  try {
    const again = apiBase((await restarted.call("attach", { root })).url);
    const list = (await json(`${again}api/comments?target=view:sequence`)) as ThreadList;
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]).toMatchObject({
      id: opened?.id,
      anchor: { kind: "group", id: "frag-1", label: "authorized" },
      identity: opened?.identity,
    });
    expect(list.threads[0]?.orphaned).not.toBe(true);
    const stale = await http(`${again}api/comments`, {
      method: "POST",
      body: JSON.stringify(commentOperation.create({ ...payload, expectedModelRevision: opened?.modelRevision })),
    });
    expect(stale.status, stale.body).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ error: { code: "write_conflict" } });
    expect(((await json(`${again}api/comments?target=view:sequence`)) as ThreadList).threads).toHaveLength(1);
    const replay = await http(`${again}api/comments`, { method: "POST", body: JSON.stringify(operation) });
    expect(replay.status, replay.body).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({
      replayed: true,
      thread: { id: opened?.id, anchor: { id: "frag-1" } },
    });
  } finally {
    restarted.close();
  }
  await second.svc.close();
  writeFileSync(join(root, ".archer/sequence.mmd"), header + "  A->>B: No blocks remain\n");
  const third = await service();
  const noBlock = await connectService(third.svc.socketPath);
  try {
    const again = apiBase((await noBlock.call("attach", { root })).url);
    const replay = await http(`${again}api/comments`, { method: "POST", body: JSON.stringify(operation) });
    expect(replay.status, replay.body).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true, thread: { id: opened?.id, orphaned: true } });
    const invalid = await http(`${again}api/comments`, {
      method: "POST",
      body: JSON.stringify(commentOperation.create({ ...payload, expectedModelRevision: "sha256:no" })),
    });
    expect(invalid.status, invalid.body).toBe(422);
  } finally {
    noBlock.close();
  }
});

test("restart on invalid sequence source orphans a retained block instead of exposing a stale pin", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + block });
  const first = await service();
  const initial = await connectService(first.svc.socketPath);
  const page = apiBase((await initial.call("attach", { root })).url);
  const payload = { target: "view:sequence", anchor: { kind: "group", id: "frag-0" }, body: "Original block" };
  const created = await http(`${page}api/comments`, {
    method: "POST",
    body: JSON.stringify(commentOperation.create(payload)),
  });
  expect(created.status, created.body).toBe(200);
  initial.close();
  await first.svc.close();
  writeFileSync(join(root, ".archer/sequence.mmd"), header + "  alt broken\n");
  const second = await service();
  const restarted = await connectService(second.svc.socketPath);
  try {
    const again = apiBase((await restarted.call("attach", { root })).url);
    const list = (await json(`${again}api/comments?target=view:sequence`)) as ThreadList;
    expect(list.threads[0]?.orphaned).toBe(true);
  } finally {
    restarted.close();
  }
});

test("reading an externally restored legacy sidecar reconciles identity even when the sequence source did not move", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + block });
  await createComment(findProject(root), "view:sequence", { kind: "group", id: "frag-0", label: "" }, "Original block");
  const path = join(root, ".archer/sequence.comments.json");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  legacy.version = 5;
  delete legacy.threads[0].identity;
  rmSync(path);
  writeFileSync(join(root, ".archer/sequence.mmd"), header + "  loop retry\n    A->>B: Earlier block\n  end\n" + block);
  const running = await service();
  const client = await connectService(running.svc.socketPath);
  try {
    const page = apiBase((await client.call("attach", { root })).url);
    writeFileSync(path, JSON.stringify(legacy));
    const list = (await json(`${page}api/comments?target=view:sequence`)) as ThreadList;
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]?.orphaned).toBe(true);
    expect(list.threads[0]?.anchor).toMatchObject({ id: "frag-0", label: "authorized" });
    expect(list.threads[0]).not.toHaveProperty("identity");
  } finally {
    client.close();
  }
});
