// One access link holds at most a share of the live event streams (server review S14: one link
// holder could take all 32 and lock every other page out).

import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { MAX_EVENT_STREAMS, MAX_EVENT_STREAMS_PER_GRANT } from "../../src/service/streams.ts";
import { cleanUp, events, http, project, service, slugOf, type Sse } from "./support.ts";

afterEach(cleanUp);

test("a grant past its share of streams is refused, and other grants still open theirs", async () => {
  expect(MAX_EVENT_STREAMS_PER_GRANT).toBeLessThan(MAX_EVENT_STREAMS);
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const open: Sse[] = [];
  try {
    const attached = await client.call("attach", { root: project() });
    const [one, two] = [
      await client.call("issueAccess", { label: "One" }),
      await client.call("issueAccess", { label: "Two" }),
    ];
    const url = `${new URL(svc.homeUrl).origin}/p/${slugOf(attached.url)}/api/events`;
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    for (let i = 0; i < MAX_EVENT_STREAMS_PER_GRANT; i++) open.push(await events(url, as(one.token)));
    expect(open.every((s) => s.status === 200)).toBe(true);
    const refused = await http(url, { headers: as(one.token) });
    expect([refused.status, JSON.parse(refused.body).error.code]).toEqual([503, "too_many_connections"]);
    const other = await events(url, as(two.token));
    open.push(other);
    expect(other.status).toBe(200);
    // A closed stream gives its share back.
    open.shift()!.close();
    await expect
      .poll(async () => {
        const s = await events(url, as(one.token));
        open.push(s);
        return s.status;
      })
      .toBe(200);
  } finally {
    for (const s of open) s.close();
    client.close();
  }
}, 30_000);
