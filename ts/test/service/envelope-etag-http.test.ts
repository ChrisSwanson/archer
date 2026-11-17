// api/diagrams/<id> carries a strong ETag of its bytes; a matching If-None-Match answers 304 so a
// page polling the open view skips an unchanged body. Still no-store (ADR 0014), and only after
// authentication: without a credential the validator is never compared.
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { apiBase, cleanUp, events, exactly, FLOW2, http, project, service, write } from "./support.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

test("an unchanged envelope answers 304 to its ETag; an edit changes the tag", async () => {
  const { svc } = await service({ prefetchThumbnails: false });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = project();
  const url = apiBase((await client.call("attach", { root })).url);
  const first = await http(`${url}api/diagrams/flow`);
  expect(first.status).toBe(200);
  expect(first.headers["cache-control"]).toBe("no-store");
  const etag = first.headers["etag"] as string;
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect((await http(`${url}api/diagrams/flow`)).headers["etag"]).toBe(etag);

  const unchanged = await http(`${url}api/diagrams/flow`, { headers: { "if-none-match": `"other", ${etag}` } });
  expect(unchanged.status).toBe(304);
  expect(unchanged.body).toBe("");
  expect(unchanged.headers["etag"]).toBe(etag);
  expect(unchanged.headers["cache-control"]).toBe("no-store");
  expect((await http(`${url}api/diagrams/flow`, { headers: { "if-none-match": '"other"' } })).status).toBe(200);

  // Without a credential the tag is not looked at: the bare 404.
  const anonymous = await exactly(`${url}api/diagrams/flow`, {
    headers: { "if-none-match": etag },
  });
  expect(anonymous.status).toBe(404);
  expect(anonymous.body).toBe("");

  const stream = await events(`${url}api/events`);
  try {
    write(root, ".archer/flow.mmd", FLOW2);
    await stream.next("change");
  } finally {
    stream.close();
  }
  const edited = await http(`${url}api/diagrams/flow`, { headers: { "if-none-match": etag } });
  expect(edited.status).toBe(200);
  expect(edited.headers["etag"]).not.toBe(etag);
  expect(JSON.parse(edited.body)).toMatchObject({ view: { id: "flow" } });
});
