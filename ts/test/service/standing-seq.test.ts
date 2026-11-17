// The adopted connect read (ui host-bridge `checkAdopted`): a page reads the standing state and opens
// its stream at once, and keeps that read for the stream when nothing was published in between. The
// service numbers what it publishes per project: every project read is answered with the count it
// was read at (`x-archer-event-seq`), and a stream starts with a `standing` event naming the count it
// was taken at. A change published between the two is then visible as a larger count.
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, events, ownerFetch, project, service } from "./support.ts";

afterEach(cleanUp);

test("reads carry the publication count, a stream starts from it, and a change between them shows", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const root = project();
  const { url } = await client.call("attach", { root });
  try {
    const read = await ownerFetch(`${apiBase(url)}api/bootstrap`);
    expect(read.headers.get("x-archer-event-seq")).toMatch(/^\d+$/);
    const seq = Number(read.headers.get("x-archer-event-seq"));
    expect(Number.isSafeInteger(seq)).toBe(true);
    // The agent presents after the page's read and before its stream.
    await client.call("present", { root, viewId: "flow", openBrowser: false });
    const stream = await events(`${apiBase(url)}api/events`);
    try {
      const standing = (await stream.next("standing")) as { seq: number };
      expect(standing.seq).toBeGreaterThan(seq);
      // A read now is answered at the count the stream started from.
      const again = await ownerFetch(`${apiBase(url)}api/diagrams`);
      expect(Number(again.headers.get("x-archer-event-seq"))).toBe(standing.seq);
    } finally {
      stream.close();
    }
  } finally {
    client.close();
  }
}, 20_000);

test("a project detached and attached again keeps counting up: its stream is not taken for older than the page's read (Codex review)", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const root = project();
  const { url } = await client.call("attach", { root });
  try {
    await client.call("present", { root, viewId: "flow", openBrowser: false });
    await client.call("present", { root, viewId: "flow", openBrowser: false });
    const read = await ownerFetch(`${apiBase(url)}api/bootstrap`);
    const seq = Number(read.headers.get("x-archer-event-seq"));
    expect(seq).toBeGreaterThan(0);
    await client.call("detach", { root });
    const again = await client.call("attach", { root });
    const stream = await events(`${apiBase(again.url)}api/events`);
    try {
      expect(((await stream.next("standing")) as { seq: number }).seq).toBeGreaterThan(seq);
    } finally {
      stream.close();
    }
  } finally {
    client.close();
  }
}, 20_000);
