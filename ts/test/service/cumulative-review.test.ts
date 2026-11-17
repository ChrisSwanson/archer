import { afterEach, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthoringStore, type JournalIntent } from "../../src/authoring/store.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, tempDir, service, project, FLOW, http } from "./support.ts";
import { blockWriters } from "../project/support.ts";
import { findProject } from "../../src/project/project.ts";
afterEach(cleanUp);
function seed(stateDir: string, root: string) {
  const store = new AuthoringStore({ stateDir, serviceName: "default", assertOwner() {} });
  let before = FLOW;
  for (let n = 1; n <= 2; n++) {
    const next = FLOW.replace("Client", "Client " + n),
      operationId = n.toString().repeat(32),
      request: JournalIntent = {
        operationId,
        payloadDigest: revisionOf(Buffer.from(String(n))),
        op: "document.apply",
        projectRoot: root,
        authority: { grantId: "grant", entitlementId: "ent" },
        feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: revisionOf(Buffer.from("policy")) },
        target: { kind: "document", path: ".archer/flow.mmd" },
        expected: { sourceRevision: revisionOf(Buffer.from(before)) },
        base: store.putSnapshot(Buffer.from(before)),
        candidate: store.putSnapshot(Buffer.from(next)),
      };
    store.beginOperation(request);
    store.completeSourceOperation(operationId, request.payloadDigest, {
      outcome: "applied",
      document: { path: ".archer/flow.mmd", sourceRevision: revisionOf(Buffer.from(next)), modelRevision: null },
      review: { mode: "on_save", configRevision: request.feedback.effectiveRevision, state: "admission_pending" },
      evidence: "observed",
    });
    writeFileSync(join(root, ".archer/flow.mmd"), next);
    before = next;
  }
  return store.listReviews(root)[0]!;
}
test("independent agent reads one cumulative review and cannot clear a newer unseen Save", async () => {
  const state = tempDir(),
    root = project(),
    review = seed(state, root);
  const { svc } = await service({ stateDir: state });
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root });
    const detail = await client.call("readReview", { root, reviewId: review.reviewId, part: "latest" });
    expect(detail.review).toMatchObject({ reviewRevision: 2, saveCount: 2 });
    expect(detail.baseline.text).toBe(FLOW);
    expect(detail.latest.text).toBe(FLOW.replace("Client", "Client 2"));
    const summary = await client.call("pendingChanges", { root });
    expect(summary.cumulativeReviews?.reviews).toHaveLength(1);
    await expect(
      client.call("clearReview", {
        root,
        reviewId: review.reviewId,
        expectedReviewRevision: 1,
        summary: "Understood the original revision",
      }),
    ).rejects.toMatchObject({ error: { code: "change_review_conflict" } });
    const cleared = await client.call("clearReview", {
      root,
      reviewId: review.reviewId,
      expectedReviewRevision: 2,
      summary: "Understood both edits; no clarification needed.",
    });
    expect(cleared.review.state).toBe("cleared");
    expect((await client.call("pendingChanges", { root })).cumulativeReviews?.reviews ?? []).toEqual([]);
    expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toBe(FLOW.replace("Client", "Client 2"));
  } finally {
    client.close();
  }
});

test("attach and restart regenerate missing derived diffs from durable private state", async () => {
  const state = tempDir(),
    root = project();
  seed(state, root);
  const first = await service({ stateDir: state });
  let client = await connectService(first.svc.socketPath);
  try {
    await client.call("attach", { root });
    const directory = join(root, ".archer/.review");
    await expect
      .poll(() => existsSync(directory) && readdirSync(directory).some((name) => name.endsWith(".diff")))
      .toBe(true);
    client.close();
    await first.svc.close();
    rmSync(directory, { recursive: true });
    const restarted = await service({ stateDir: state });
    client = await connectService(restarted.svc.socketPath);
    await expect
      .poll(() => existsSync(directory) && readdirSync(directory).some((name) => name.endsWith(".diff")))
      .toBe(true);
    const name = readdirSync(directory).find((name) => name.endsWith(".diff"))!;
    expect(readFileSync(join(directory, name), "utf8")).toContain("Client 2");
  } finally {
    client.close();
  }
}, 15000);

// B2: each refresh of a review whose source another writer held waited the
// whole lock bound on the event loop, once per review, during attach.
test("attach with a held review source neither stalls the event loop nor gives up the refresh", async () => {
  const state = tempDir(),
    root = project();
  seed(state, root);
  const release = blockWriters(findProject(root), "flow.mmd");
  const first = await service({ stateDir: state });
  const client = await connectService(first.svc.socketPath);
  const directory = join(root, ".archer/.review");
  try {
    let last = performance.now(),
      worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    await client.call("attach", { root });
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // past the first retry
    clearInterval(tick);
    expect(worst).toBeLessThan(250);
    expect(existsSync(directory) && readdirSync(directory).some((name) => name.endsWith(".diff"))).toBe(false);
    release();
    await expect
      .poll(() => existsSync(directory) && readdirSync(directory).some((name) => name.endsWith(".diff")), {
        timeout: 5_000,
      })
      .toBe(true);
  } finally {
    release();
    client.close();
  }
}, 15000);

test("HTTP status isolates an unprobeable uncertain source and refuses resolution without blocking another diagram", async () => {
  const state = tempDir(),
    root = project(),
    store = new AuthoringStore({ stateDir: state, serviceName: "default", assertOwner() {} }),
    before = store.putSnapshot(Buffer.from(FLOW));
  const operationId = "a".repeat(32),
    candidate = store.putSnapshot(Buffer.from(FLOW.replace("Client", "Uncertain")));
  store.beginOperation({
    operationId,
    payloadDigest: revisionOf(Buffer.from("uncertain")),
    op: "document.apply",
    projectRoot: root,
    authority: { grantId: "old", entitlementId: "old" },
    feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: revisionOf(Buffer.from("policy")) },
    target: { kind: "document", path: ".archer/flow.mmd" },
    expected: { sourceRevision: before.revision },
    base: before,
    candidate,
  });
  const peer = join(root, ".archer/peer.mmd");
  writeFileSync(peer, FLOW);
  unlinkSync(join(root, ".archer/flow.mmd"));
  symlinkSync(peer, join(root, ".archer/flow.mmd"));
  const { svc } = await service({ stateDir: state }),
    client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root }),
      grant = await client.call("issueAuthoringAccess", { label: "Probe isolation", projectRoots: [root] }),
      origin = new URL(svc.homeUrl).origin,
      base = origin + "/p/" + attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]! + "/api/authoring",
      cookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const status = await http(base, { headers: { cookie } });
    expect(status.status, status.body).toBe(200);
    const parsed = JSON.parse(status.body);
    expect(parsed.operations[0]).toMatchObject({ operationId, state: "uncertain", probeUnavailable: true });
    const lookup = await http(base + "/operations/" + operationId, { headers: { cookie } });
    expect(lookup.status).toBe(200);
    expect(JSON.parse(lookup.body).operation.probeUnavailable).toBe(true);
    const post = (suffix: string, input: unknown) =>
      http(base + suffix, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    const refused = await post("", {
      op: "operation.resolve_uncertain",
      operationId: "b".repeat(32),
      targetOperationId: operationId,
      resolution: "abandon",
      journalGeneration: parsed.generation,
    });
    expect(refused.status, refused.body).toBe(409);
    expect(JSON.parse(refused.body).error.code).toBe("authoring_probe_unavailable");
    const opened = JSON.parse((await post("/open", { target: { kind: "view", viewId: "peer" } })).body),
      source = FLOW.replace("Client", "Independent");
    const saved = await post("", {
      op: "document.apply",
      operationId: "c".repeat(32),
      journalGeneration: parsed.generation,
      target: opened.target,
      expectedTargetRevision: opened.targetRevision,
      expectedSourceRevision: opened.sourceRevision,
      source,
    });
    expect(saved.status, saved.body).toBe(200);
    expect(readFileSync(peer, "utf8")).toBe(source);
  } finally {
    client.close();
  }
}, 15000);
