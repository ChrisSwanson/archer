// A comment edit's expected revision over HTTP (O124): `PATCH api/comments/<thread>/<comment>` may carry
// `expectedRevision`, the thread revision the page last saw; once the thread moved past it the edit is refused
// with `thread_changed` (409) and the thread as it is now, so "Save over it" never writes over a change the
// page did not see. A body without it (an older page) is taken as before; any other key is still refused.
import { afterEach, expect, test } from "vitest";
import type { Thread } from "../../src/comments/contract.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { apiBase, cleanUp, pageWrites, project, service, type Reply } from "../service/support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

async function attached() {
  const { svc } = await service({}, { comments: "queued" });
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const url = (await c.call("attach", { root: project() })).url as string;
  const origin = `http://127.0.0.1:${svc.port}`;
  const page = apiBase(url);
  // As the page sends them: a create as its operation (ADR 0016), read as its receipt's thread.
  const send: (method: string, path: string, body: unknown) => Promise<Reply> = pageWrites(page, origin);
  return { send };
}

const parsed = <T>(reply: Reply): T => JSON.parse(reply.body) as T;

test("PATCH with a stale expectedRevision is refused thread_changed with the thread now; current, or none, is taken", async () => {
  const { send } = await attached();
  const thread = parsed<Thread>(
    await send("POST", "api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "first" }),
  );
  const at = `api/comments/${thread.id}/${thread.comments[0]!.id}`;
  const other = await send("PATCH", at, { body: "another tab's words", expectedRevision: thread.revision });
  expect(other.status, other.body).toBe(200);
  const stale = await send("PATCH", at, { body: "mine", expectedRevision: thread.revision });
  expect(stale.status, stale.body).toBe(409);
  const refusal = parsed<{ error: { code: string; details?: { revision: number; comments: { body: string }[] } } }>(
    stale,
  );
  expect(refusal.error.code).toBe("thread_changed");
  expect(refusal.error.details).toMatchObject({
    revision: thread.revision + 1,
    comments: [{ body: "another tab's words" }],
  });
  const current = await send("PATCH", at, { body: "mine", expectedRevision: thread.revision + 1 });
  expect(parsed<Thread>(current).comments[0]!.body).toBe("mine");
  const older = await send("PATCH", at, { body: "older page" });
  expect(older.status, older.body).toBe(200);
  const extra = await send("PATCH", at, { body: "x", other: 1 });
  expect([extra.status, parsed<{ error: { code: string } }>(extra).error.code]).toEqual([422, "invalid_comment"]);
  const bad = await send("PATCH", at, { body: "x", expectedRevision: "2" });
  expect([bad.status, parsed<{ error: { code: string } }>(bad).error.code]).toEqual([422, "invalid_comment"]);
});
