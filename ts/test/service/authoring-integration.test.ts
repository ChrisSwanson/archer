import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { revisionOf } from "../../src/project/index.ts";
import { cleanUp, service, http, project } from "./support.ts";
afterEach(cleanUp);
test("entitled browser saves privately, reviews exact bytes, applies once and publishes without clobber", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project(),
      other = project(),
      attached = await client.call("attach", { root });
    await client.call("attach", { root: other });
    const reader = await client.call("issueAccess", { label: "reader" }),
      author = await client.call("issueAuthoringAccess", { label: "author", projectRoots: [root] });
    const origin = new URL(svc.homeUrl).origin,
      slug = attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
    const exchange = await http(author.url),
      cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const readerCookie = ((await http(reader.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const base = `${origin}/p/${slug}/api/authoring`;
    const readerStatus = await http(base, { headers: { cookie: readerCookie } });
    expect(readerStatus.status).toBe(200);
    expect(JSON.parse(readerStatus.body)).toMatchObject({ authorized: true });
    const status = await http(base, { headers: { cookie } });
    expect(status.status, status.body).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ authorized: true, drafts: [], operations: [] });
    const journalGeneration = JSON.parse(status.body).generation;
    const post = async (path: string, body: unknown) => {
      const result = await http(base + path, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(path === "" ? { ...(body as object), journalGeneration } : body),
      });
      expect(result.status, result.body).toBe(200);
      return JSON.parse(result.body);
    };
    const file = join(root, ".archer/flow.mmd"),
      before = readFileSync(file),
      source = before.toString("utf8").replace("Client", "Edited Client");
    const opened = await post("/open", { target: { kind: "view", viewId: "flow" } });
    expect(opened.source).toBe(before.toString("utf8"));
    expect(opened.sourceRevision).toBe(revisionOf(before));
    const preview = await post("/preview", { source });
    expect(preview.envelope.model.nodes[0].label).toBe("Edited Client");
    const saved = await post("", {
      op: "draft.save",
      operationId: "1".repeat(32),
      draftId: "drf_" + "2".repeat(32),
      expectedDraftRevision: null,
      source,
      origin: {
        kind: "document",
        target: { kind: "view", viewId: "flow" },
        expectedTargetRevision: opened.targetRevision,
        expectedSourceRevision: opened.sourceRevision,
      },
    });
    expect(saved).toMatchObject({
      state: "terminal",
      outcome: "saved",
      draft: { draftRevision: 1 },
      review: { state: "queued" },
    });
    expect(readFileSync(file)).toEqual(before);
    const pending = await client.call("listChanges", { root });
    expect(pending.records).toHaveLength(1);
    const detail = await client.call("readChange", { root, changeId: pending.records[0]!.changeId, part: "after" });
    expect(detail.source!.text).toBe(source);
    const request = {
      op: "document.apply",
      operationId: "3".repeat(32),
      target: { kind: "view", viewId: "flow" },
      expectedTargetRevision: opened.targetRevision,
      expectedSourceRevision: opened.sourceRevision,
      source,
    };
    const applied = await post("", request);
    expect(applied).toMatchObject({
      state: "terminal",
      outcome: "applied",
      document: { sourceRevision: revisionOf(Buffer.from(source)) },
    });
    expect(readFileSync(file, "utf8")).toBe(source);
    const afterApply = await client.call("listChanges", { root });
    const appliedChange = afterApply.cumulativeReviews!.reviews[0]!;
    const appliedDetail = await client.call("readReview", { root, reviewId: appliedChange.reviewId });
    expect(appliedDetail.baseline.text).toBe(before.toString("utf8"));
    expect(appliedDetail.latest.text).toBe(source);
    const external = source.replace("Edited Client", "External Client");
    writeFileSync(file, external);
    expect(await post("", request)).toMatchObject({
      operationId: applied.operationId,
      outcome: applied.outcome,
      document: applied.document,
      review: applied.review,
    });
    expect(readFileSync(file, "utf8")).toBe(external);
    const published = await post("", {
      op: "document.publish",
      operationId: "4".repeat(32),
      path: "diagrams/new-diagram.mmd",
      source,
    });
    expect(published).toMatchObject({ outcome: "created" });
    expect(readFileSync(join(root, ".archer/diagrams/new-diagram.mmd"), "utf8")).toBe(source);
    const probe = await http(base + "/operations/" + request.operationId, { headers: { cookie } });
    expect(JSON.parse(probe.body)).toMatchObject({
      operation: {
        operationId: applied.operationId,
        outcome: applied.outcome,
        document: applied.document,
        review: applied.review,
      },
    });
    const serialized = JSON.stringify(JSON.parse((await http(base, { headers: { cookie } })).body));
    expect(serialized).not.toContain(author.token);
    expect(serialized).not.toContain(author.entitlementId);
    const denied = await http(base, {
      method: "POST",
      headers: { authorization: `Bearer ${author.token}`, origin, "content-type": "application/json" },
      body: JSON.stringify({ ...request, operationId: "5".repeat(32) }),
    });
    expect(denied.status).toBe(404);
  } finally {
    client.close();
  }
}, 20000);

test("manual review submission retains observed write evidence across a service restart", async () => {
  const { svc, state } = await service();
  let client = await connectService(svc.socketPath);
  const root = project(),
    manifest = join(root, "archer.toml");
  writeFileSync(manifest, readFileSync(manifest, "utf8") + '\n[feedback]\nchanges = "manual"\n');
  try {
    const attached = await client.call("attach", { root });
    const grant = await client.call("issueAuthoringAccess", { label: "manual author", projectRoots: [root] });
    const origin = new URL(svc.homeUrl).origin,
      slug = attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
    const cookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const base = `${origin}/p/${slug}/api/authoring`,
      file = join(root, ".archer/flow.mmd"),
      before = readFileSync(file),
      source = before.toString("utf8").replace("Client", "Manual client");
    const journalGeneration = JSON.parse((await http(base, { headers: { cookie } })).body).generation;
    const post = async (body: unknown) => {
      const response = await http(base, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ ...(body as object), journalGeneration }),
      });
      expect(response.status, response.body).toBe(200);
      return JSON.parse(response.body);
    };
    const openedResponse = await http(base + "/open", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ target: { kind: "view", viewId: "flow" } }),
    });
    expect(openedResponse.status).toBe(200);
    const opened = JSON.parse(openedResponse.body);
    const operationId = "6".repeat(32),
      applied = await post({
        op: "document.apply",
        operationId,
        target: { kind: "view", viewId: "flow" },
        expectedTargetRevision: opened.targetRevision,
        expectedSourceRevision: revisionOf(before),
        source,
      });
    expect(applied).toMatchObject({ outcome: "applied", review: { mode: "manual", state: "tracked_held" } });
    expect((await client.call("pendingChanges", { root })).records).toEqual([]);
    const sent = await post({ op: "operation.send", operationId: "7".repeat(32), targetOperationId: operationId });
    expect(sent).toMatchObject({ outcome: "sent", review: { state: "tracked" } });
    const reviewId = sent.review.reviewId;
    const beforeRestart = await client.call("readReview", { root, reviewId });
    expect(beforeRestart.latest.text).toBe(source);
    client.close();
    await svc.close();
    const restarted = await service({ stateDir: state });
    client = await connectService(restarted.svc.socketPath);
    const afterRestart = await client.call("readReview", { root, reviewId });
    expect(afterRestart.current.status).toBe("matches_after");
    expect(afterRestart.latest).toMatchObject({ text: source, complete: true });
  } finally {
    client.close();
  }
}, 20000);
