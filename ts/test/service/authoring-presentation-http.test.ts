import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, service, project, http } from "./support.ts";
afterEach(cleanUp);
test("explicit layout Save is project/source/target bound and survives independent browser reads", async () => {
  const { svc } = await service(),
    client = await connectService(svc.socketPath);
  try {
    const root = project(),
      attached = await client.call("attach", { root }),
      grant = await client.call("issueAuthoringAccess", { label: "layout", projectRoots: [root] }),
      origin = new URL(svc.homeUrl).origin,
      slug = attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!,
      base = `${origin}/p/${slug}/api/authoring`,
      cookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!,
      headers = { cookie, origin, "content-type": "application/json" },
      post = (path: string, body: unknown) =>
        http(base + path, { method: "POST", headers, body: JSON.stringify(body) }),
      opened = JSON.parse((await post("/open", { target: { kind: "view", viewId: "flow" } })).body),
      identity = {
        target: opened.target,
        expectedTargetRevision: opened.targetRevision,
        sourceRevision: opened.sourceRevision,
      },
      before = readFileSync(join(root, ".archer/flow.mmd"));
    const initial = await post("/presentation", { op: "read", ...identity });
    expect(initial.status, initial.body).toBe(200);
    expect(JSON.parse(initial.body)).toEqual({ presentation: null });
    const saved = await post("/presentation", {
      op: "save",
      ...identity,
      expectedRevision: null,
      positions: { a: { x: 420, y: 130 }, b: { x: 650, y: 300 } },
    });
    expect(saved.status, saved.body).toBe(200);
    const receipt = JSON.parse(saved.body);
    expect(receipt.presentation.positions.a).toEqual({ x: 420, y: 130 });
    const secondCookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const independent = await http(base + "/presentation", {
      method: "POST",
      headers: { ...headers, cookie: secondCookie },
      body: JSON.stringify({ op: "read", ...identity }),
    });
    expect(JSON.parse(independent.body)).toEqual(receipt);
    const stale = await post("/presentation", {
      op: "save",
      ...identity,
      sourceRevision: "sha256:" + "f".repeat(64),
      expectedRevision: receipt.presentation.revision,
      positions: { a: { x: 1, y: 2 } },
    });
    expect(stale.status).toBe(409);
    const unknown = await post("/presentation", {
      op: "save",
      ...identity,
      expectedRevision: receipt.presentation.revision,
      positions: { ghost: { x: 1, y: 2 } },
    });
    expect(unknown.status).toBe(422);
    expect(readFileSync(join(root, ".archer/flow.mmd"))).toEqual(before);
  } finally {
    client.close();
  }
});
test("a layout read leaves out saved positions for nodes the source no longer has", async () => {
  const { svc } = await service(),
    client = await connectService(svc.socketPath);
  try {
    const root = project(),
      attached = await client.call("attach", { root }),
      grant = await client.call("issueAuthoringAccess", { label: "layout", projectRoots: [root] }),
      origin = new URL(svc.homeUrl).origin,
      slug = attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!,
      base = `${origin}/p/${slug}/api/authoring`,
      cookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!,
      headers = { cookie, origin, "content-type": "application/json" },
      post = async (path: string, body: unknown) => {
        const r = await http(base + path, { method: "POST", headers, body: JSON.stringify(body) });
        expect(r.status, r.body).toBe(200);
        return JSON.parse(r.body);
      },
      identity = (o: { target: unknown; targetRevision: string; sourceRevision: string }) => ({
        target: o.target,
        expectedTargetRevision: o.targetRevision,
        sourceRevision: o.sourceRevision,
      });
    const opened = await post("/open", { target: { kind: "view", viewId: "flow" } });
    const saved = (
      await post("/presentation", {
        op: "save",
        ...identity(opened),
        expectedRevision: null,
        positions: { a: { x: 420, y: 130 }, b: { x: 650, y: 300 } },
      })
    ).presentation;
    // The file changes outside the editor (an agent edit or a revert): b is gone.
    writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\n  a[Client]\n");
    const reopened = await post("/open", { target: { kind: "view", viewId: "flow" } });
    const read = (await post("/presentation", { op: "read", ...identity(reopened) })).presentation;
    expect(read.positions).toEqual({ a: { x: 420, y: 130 } });
    // The revision stays the saved one: it is the compare-and-set token for the next save.
    expect(read.revision).toBe(saved.revision);
    const next = (
      await post("/presentation", {
        op: "save",
        ...identity(reopened),
        expectedRevision: read.revision,
        positions: read.positions,
      })
    ).presentation;
    expect(next.positions).toEqual({ a: { x: 420, y: 130 } });
  } finally {
    client.close();
  }
});
