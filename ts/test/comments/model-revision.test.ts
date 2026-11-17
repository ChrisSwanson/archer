// A thread names the diagram revision it was written on (U9, J11): `modelRevision`, the view's compiled model when
// the thread was created, the same value read_diagram and present_diagram name, so an agent can tell whether the
// drawing changed since. Older threads, notes and the project conversation have none.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { OperationAck, Thread } from "../../src/comments/contract.ts";
import { CommentsStore, elementsOf, type Place } from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { call, connect, FLOW, removeTempDirs, structured, tempDir } from "../mcp/support.ts";
import { apiBase, cleanUp, commentOperation, http, project, service } from "../service/support.ts";

afterEach(removeTempDirs);
afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

test("the page's comment names the revision the page was presented at, and get_comments returns it", async () => {
  const { svc } = await service({}, { comments: "queued" });
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const root = project();
  const page = apiBase((await c.call("attach", { root })).url as string);
  await c.call("present", { root, viewId: "flow" });
  const presented = (JSON.parse((await http(`${page}api/bootstrap`)).body) as { presentation: { revision: string } })
    .presentation.revision;
  const origin = `http://127.0.0.1:${svc.port}`;
  const operation = {
    id: randomBytes(16).toString("hex"),
    issuedAt: Date.now(),
    name: "comment.create",
    target: "view:flow",
  };
  const reply = await http(`${page}api/comments`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ operation, payload: { target: "view:flow", anchor: { kind: "view" }, body: "Here?" } }),
  });
  expect(reply.status, reply.body).toBe(200);
  expect((JSON.parse(reply.body) as OperationAck).thread?.modelRevision).toBe(presented);
  // What the agent reads: the file, through get_comments, after the person sends it.
  const submitted = await http(`${page}api/comments/submit`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(commentOperation.submit()),
  });
  expect(submitted.status, submitted.body).toBe(200);
  const mcp = await connect({ cwd: root });
  try {
    const got = structured(await call(mcp.client, "get_comments")) as unknown as { threads: Thread[] };
    expect(got.threads.map((t) => t.modelRevision)).toEqual([presented]);
    expect(
      (structured(await call(mcp.client, "read_diagram", { viewId: "flow" })) as { modelRevision: string })
        .modelRevision,
    ).toBe(presented);
  } finally {
    await mcp.close();
  }
}, 20_000);

test("the agent's create_comment names it too; a note thread and an older thread have none, and stay version 2", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW, ".archer/auth.md": "# Auth\n\nTokens.\n" });
  const { client, close } = await connect({ cwd: root });
  try {
    const read = structured(await call(client, "read_diagram", { viewId: "flow" })) as { modelRevision: string };
    const created = structured(
      await call(client, "create_comment", { target: "view:flow", anchor: { kind: "view" }, body: "Look here." }),
    ) as unknown as Thread;
    expect(created.modelRevision).toBe(read.modelRevision);
    expect(
      (JSON.parse(readFileSync(join(root, ".archer/flow.comments.json"), "utf8")) as { version: number }).version,
    ).toBe(5);
    const note = structured(
      await call(client, "create_comment", { target: "note:auth.md", anchor: { kind: "view" }, body: "And here." }),
    ) as unknown as Thread;
    expect(note).not.toHaveProperty("modelRevision");
  } finally {
    await close();
  }
  // A thread made without a model revision (before 0.10.0, or a view that did not compile) has none, and its file
  // keeps the version an older Archer reads.
  const other = tempDir({ ".archer/flow.mmd": FLOW });
  const store = new CommentsStore(findProject(other));
  const view: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements: elementsOf({ type: "freeform-graph", nodes: [], edges: [], groups: [] }) },
  };
  expect(store.create(view, { anchor: { kind: "view" }, body: "Old style" }).value).not.toHaveProperty("modelRevision");
  expect(
    (JSON.parse(readFileSync(join(findProject(other).folder, "flow.comments.json"), "utf8")) as { version: number })
      .version,
  ).toBe(2);
});
