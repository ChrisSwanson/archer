import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { runChangeOperation } from "../../src/application/changes.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, FLOW, project, service } from "../service/support.ts";
import { browserAuthor, cumulativePage } from "./cumulative-review-support.ts";
afterEach(cleanUp);

test("production tools read exact cumulative parts and clear through IPC with summary, CAS and project isolation", async () => {
  const { svc } = await service(),
    admin = await connectService(svc.socketPath),
    root = project(),
    other = project();
  const before = "\uFEFF" + FLOW.replaceAll("\n", "\r\n");
  writeFileSync(join(root, ".archer/flow.mmd"), before);
  const browser = await browserAuthor(svc, admin, root);
  await admin.call("attach", { root: other });
  let starts = 0;
  const app = createApplication({
      cwd: root,
      findService: () => connectService(svc.socketPath),
      ensureService: async () => {
        starts++;
        return connectService(svc.socketPath);
      },
    }),
    foreign = createApplication({ cwd: other, findService: () => connectService(svc.socketPath) });
  try {
    await browser.save(before.replace("Client", "Second"));
    await browser.save(before.replace("Client", "Third"));
    const listing = await app.call("list_changes", {}),
      reviews = cumulativePage(listing.structured.cumulativeReviews).reviews;
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review).toMatchObject({ saveCount: 2, reviewRevision: 2 });
    expect(listing.structured.records).toEqual([]);
    for (const part of ["before", "baseline"])
      expect((await app.call("read_change", { changeId: review.reviewId, part })).structured.source).toMatchObject({
        text: before,
        bytes: Buffer.byteLength(before),
      });
    const latest = readFileSync(join(root, ".archer/flow.mmd"), "utf8");
    for (const part of ["after", "latest"])
      expect((await app.call("read_change", { changeId: review.reviewId, part })).structured.source).toMatchObject({
        text: latest,
        bytes: Buffer.byteLength(latest),
      });
    const detail = await app.call("read_change", { changeId: review.reviewId, part: "diff" });
    expect(detail.structured.diff).toMatchObject({ complete: true, netEffect: "changed" });
    expect(detail.text).not.toContain("flowchart LR");
    await expect(foreign.call("read_change", { changeId: review.reviewId })).rejects.toMatchObject({
      data: { code: "change_not_found" },
    });
    await browser.save(before.replace("Client", "Fourth"));
    await expect(
      app.call("resolve_change", {
        changeId: review.reviewId,
        expectedReviewRevision: 2,
        disposition: "cleared",
        summary: "The client label change is understood; no open clarifications.",
      }),
    ).rejects.toMatchObject({ data: { code: "change_review_conflict" } });
    const cleared = await app.call("resolve_change", {
      reviewId: review.reviewId,
      expectedReviewRevision: 3,
      disposition: "handled",
      summary: "The fourth label is understood; there are no remaining questions.",
    });
    expect(cleared.structured.review).toMatchObject({
      state: "cleared",
      reviewRevision: 4,
      summary: "The fourth label is understood; there are no remaining questions.",
    });
    expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toContain("Fourth");
    await browser.save(before.replace("Client", "Fifth"));
    const next = cumulativePage((await app.call("list_changes", {})).structured.cumulativeReviews).reviews[0]!;
    expect(next.reviewId).not.toBe(review.reviewId);
    expect(
      (await app.call("read_change", { changeId: next.reviewId, part: "baseline" })).structured.source,
    ).toMatchObject({ text: before.replace("Client", "Fourth") });
    const legacy = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "draft", id: "legacy" },
      eventKind: "draft.saved",
      before: null,
      after: Buffer.from("legacy exact\r\n"),
    }).record;
    expect(
      (await app.call("read_change", { changeId: legacy.changeId, part: "after" })).structured.source,
    ).toMatchObject({ text: "legacy exact\r\n" });
    expect(
      (
        await app.call("resolve_change", {
          changeId: legacy.changeId,
          expectedReviewRevision: 1,
          disposition: "declined",
          summary: "Optional application-only context",
        })
      ).structured.record,
    ).toMatchObject({ disposition: "declined" });
    expect(starts).toBe(0);
  } finally {
    app.close();
    foreign.close();
    admin.close();
  }
});

test("independent cumulative pagination includes held items and keeps legacy cursor fields explicit", async () => {
  const { svc } = await service(),
    admin = await connectService(svc.socketPath),
    root = project();
  writeFileSync(
    join(root, "archer.toml"),
    readFileSync(join(root, "archer.toml"), "utf8") + '\n[feedback]\nchanges = "manual"\n',
  );
  const browser = await browserAuthor(svc, admin, root),
    app = createApplication({ cwd: root, findService: () => connectService(svc.socketPath) });
  try {
    await browser.save(FLOW.replace("Client", "Held"));
    await browser.publish("diagrams/second.mmd", FLOW.replace("Client", "Second"));
    await browser.publish("diagrams/third.mmd", FLOW.replace("Client", "Third"));
    for (let i = 0; i < 2; i++)
      svc.changes.admit({
        operationId: randomBytes(16).toString("hex"),
        projectRoot: root,
        format: "mermaid",
        origin: "browser_editor",
        target: { kind: "draft", id: "page-" + i },
        eventKind: "draft.saved",
        before: null,
        after: Buffer.from("legacy"),
      });
    const first = await app.call("list_changes", { limit: 1 }),
      page = cumulativePage(first.structured.cumulativeReviews);
    expect(page.reviews[0]).toMatchObject({ delivery: "held" });
    expect(page.hasMore).toBe(true);
    expect(first.text).toContain("held");
    const second = await app.call("list_changes", { reviewCursor: page.nextCursor, limit: 1 }),
      next = cumulativePage(second.structured.cumulativeReviews);
    expect(next.reviews[0]!.reviewId).not.toBe(page.reviews[0]!.reviewId);
    expect(second.structured.records).toEqual(first.structured.records);
    const advanced = await app.call("list_changes", {
      cursor: first.structured.nextCursor,
      reviewCursor: page.nextCursor,
      limit: 1,
    });
    expect(advanced.structured.records).not.toEqual(first.structured.records);
    expect(cumulativePage(advanced.structured.cumulativeReviews).reviews).toEqual(next.reviews);
    await expect(
      app.call("list_changes", { reviewCursor: first.structured.nextCursor, limit: 1 }),
    ).rejects.toMatchObject({ data: { code: "change_cursor_invalid" } });
    expect((await admin.call("pendingChanges", { root })).cumulativeReviews?.reviews).toEqual([]);
  } finally {
    app.close();
    admin.close();
  }
});
test("a closed real IPC connection does not retry or clear a cumulative source review", async () => {
  const { svc } = await service(),
    admin = await connectService(svc.socketPath),
    root = project(),
    browser = await browserAuthor(svc, admin, root);
  await browser.save(FLOW.replace("Client", "Pending"));
  const review = (await admin.call("listChanges", { root })).cumulativeReviews!.reviews[0]!,
    closed = await connectService(svc.socketPath);
  closed.close();
  let acquisitions = 0,
    disconnects = 0;
  try {
    await expect(
      runChangeOperation(
        "resolve_change",
        {
          changeId: review.reviewId,
          expectedReviewRevision: 1,
          disposition: "cleared",
          summary: "Read and understood; no clarifications outstanding.",
        },
        {
          cwd: root,
          acquire: async (start) => {
            expect(start).toBe(false);
            acquisitions++;
            return closed;
          },
          disconnect() {
            disconnects++;
          },
        },
      ),
    ).rejects.toMatchObject({ data: { code: "io_failure" } });
    expect(acquisitions).toBe(1);
    expect(disconnects).toBe(1);
    expect((await admin.call("listChanges", { root })).cumulativeReviews!.reviews).toEqual([
      expect.objectContaining({ reviewId: review.reviewId, reviewRevision: 1 }),
    ]);
  } finally {
    admin.close();
  }
});
