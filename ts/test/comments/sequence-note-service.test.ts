import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { OperationAck, ThreadList } from "../../src/comments/contract.ts";
import { connectService } from "../../src/service/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../mcp/support.ts";
import { apiBase, cleanUp, commentOperation, http, json, service } from "../service/support.ts";

afterEach(cleanUp);
afterEach(removeTempDirs);
const header = "sequenceDiagram\n  participant A\n  participant B\n";
const note = "  Note over A,B: Available additions SHOULD accompany 406\n";

test("page-created note identity survives restart, reorders its pin safely and rejects a stale composer", async () => {
  const root = tempDir({ ".archer/sequence.mmd": header + note });
  const first = await service();
  const client = await connectService(first.svc.socketPath);
  const page = apiBase((await client.call("attach", { root })).url);
  const payload = {
    target: "view:sequence",
    anchor: { kind: "node", id: "note-0", label: "untrusted" },
    body: "Why this note?",
    expectedModelRevision: revisionOf(Buffer.from(header + note)),
  };
  const operation = commentOperation.create(payload);
  const reply = await http(`${page}api/comments`, { method: "POST", body: JSON.stringify(operation) });
  expect(reply.status, reply.body).toBe(200);
  const opened = (JSON.parse(reply.body) as OperationAck).thread;
  expect(opened?.identity).toMatchObject({ version: 1, unique: true });
  expect(opened?.anchor).toMatchObject({ label: "Available additions SHOULD accompany 406" });
  client.close();
  await first.svc.close();
  writeFileSync(join(root, ".archer/sequence.mmd"), header + "  Note right of A: Earlier note\n" + note);
  const second = await service();
  const restarted = await connectService(second.svc.socketPath);
  try {
    const again = apiBase((await restarted.call("attach", { root })).url);
    const list = (await json(`${again}api/comments?target=view:sequence`)) as ThreadList;
    expect(list.threads[0]).toMatchObject({
      id: opened?.id,
      anchor: { id: "note-1" },
      identity: opened?.identity,
    });
    expect(list.threads[0]?.orphaned).not.toBe(true);
    const stale = await http(`${again}api/comments`, {
      method: "POST",
      body: JSON.stringify(commentOperation.create(payload)),
    });
    expect(stale.status, stale.body).toBe(409);
    const replay = await http(`${again}api/comments`, { method: "POST", body: JSON.stringify(operation) });
    expect(JSON.parse(replay.body)).toMatchObject({
      replayed: true,
      thread: { id: opened?.id, anchor: { id: "note-1" } },
    });
  } finally {
    restarted.close();
  }
});
