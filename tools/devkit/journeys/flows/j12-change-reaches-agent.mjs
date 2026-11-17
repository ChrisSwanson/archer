// J12 Saved change reaches the agent (user-flows §6, U9): after J6's save (here its setup: Edit → rename a node →
// Save on journeys/diagrams/flow.mmd, not counted as this journey's actions), the agent: list_changes →
// read_change → resolve_change; then a resolve with the stale review revision. Mandatory outcome: read_change equals
// the saved diff; resolved once; the stale call refused. The stale call is applicable: resolve_change takes
// expectedReviewRevision (`archer tools resolve_change`, required), so the §3 NOT APPLICABLE rule does not apply.
// The stale call is a genuine one (PC-04): the review is still pending, and a second save has moved it on from the
// revision the agent read (save 1, read, save 2, resolve with revision 1). It must be refused with
// change_review_conflict and leave the review pending; the current revision then resolves it, once.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { begin } from "./lib.mjs";
const SLUG = "journeys",
  FILE = "diagrams/flow.mmd",
  REL = ".archer/diagrams/flow.mmd";
export const meta = {
  name: "flows-j12-change-reaches-agent",
  flow: { id: "J12", projects: ["pageturner", SLUG], baseline: [] },
};
export default async (ctx) => {
  const { step, expect, ui, log } = ctx;
  const { flow } = await begin(ctx, meta);
  const agent = (op, args) => ui.agent(op, args, { project: SLUG });
  const before = await ui.readProjectFile(SLUG, REL);
  await ui.openDiagram(SLUG, FILE, { edit: true });
  await ui.rename("b", "Orders API");
  await ui.save();
  const after = await ui.readProjectFile(SLUG, REL);
  await step("setup: the save changed only that label", async () => {
    const a = before.split("\n"),
      b = after.split("\n");
    const changed = b.map((line, i) => (line === a[i] ? null : { before: a[i], after: line })).filter(Boolean);
    expect(b.length).toBe(a.length);
    expect(changed).toHaveLength(1);
    expect(changed[0].before.trim()).toBe("b[API]");
    expect(changed[0].after).toMatch(/^\s*b\[?"?Orders API"?\]?$/);
  });
  // The agent's side. Each call is an agent operation (run.agentCalls), none is a person action.
  const listed = await step("agent: list_changes names the saved file", async () => {
    const r = await agent("list_changes", {});
    const review = r.cumulativeReviews.reviews.find((x) => x.subject?.path === REL);
    expect(
      review,
      `a pending review for ${REL} (reviews: ${JSON.stringify(r.cumulativeReviews.reviews.map((x) => x.subject))})`,
    ).toBeTruthy();
    expect(review.netEffect).toBe("changed");
    return review;
  });
  const diff = await step("agent: read_change (diff)", () =>
    agent("read_change", { changeId: listed.reviewId, part: "diff" }),
  );
  const latest = await step("agent: read_change (latest)", () =>
    agent("read_change", { changeId: listed.reviewId, part: "latest" }),
  );
  writeFileSync(ctx.run.dir + "/j12-agent.json", JSON.stringify({ listed, diff, latest }, null, 2));
  await step("agent: read_change equals the saved diff", async () => {
    // The saved diff: the lines the file lost and gained, from the bytes on disk before and after Save.
    const a = before.split("\n"),
      b = after.split("\n");
    const removed = a.filter((l, i) => b[i] !== l),
      added = b.filter((l, i) => a[i] !== l);
    const patch = String(diff.diff?.text ?? "");
    const minus = patch
      .split("\n")
      .filter((l) => /^-(?!--)/.test(l))
      .map((l) => l.slice(1));
    const plus = patch
      .split("\n")
      .filter((l) => /^\+(?!\+\+)/.test(l))
      .map((l) => l.slice(1));
    flow.note("readChange", { removed, added, minus, plus });
    expect(minus, "read_change's removed lines are the saved diff's").toEqual(removed);
    expect(plus, "read_change's added lines are the saved diff's").toEqual(added);
    expect(diff.baseline?.text, "read_change's baseline is the file before the save").toBe(before);
    const latestText = String(latest.latest?.text ?? "");
    expect(latestText, "read_change latest is the file on disk").toBe(after);
    // U9: the revision the agent is told is the one of the bytes the person saved.
    const saved = "sha256:" + createHash("sha256").update(after).digest("hex");
    flow.note("u9", { savedRevision: saved, agentLatest: diff.review?.latestSourceRevision ?? null });
    expect(diff.review?.latestSourceRevision, "the agent's latest revision is the saved file's").toBe(saved);
  });
  // A second save while the review is pending (setup, not a person action of this journey): the agent's read is now stale.
  await ui.openDiagram(SLUG, FILE, { edit: true });
  await ui.rename("b", "Orders API v2");
  await ui.save();
  // The mandatory outcome's other two parts; the journey's goal (a failed step above fails the run).
  await flow.goal("read_change equals the saved diff; resolved once; the stale call refused", async () => {
    const moved = (await agent("list_changes", {})).cumulativeReviews.reviews.find(
      (x) => x.reviewId === listed.reviewId,
    );
    expect(moved, "the second save keeps the same pending review").toBeTruthy();
    expect(moved.reviewRevision, "the second save moved the review to a new revision").not.toBe(listed.reviewRevision);
    const stale = await ui.agent(
      "resolve_change",
      {
        reviewId: listed.reviewId,
        expectedReviewRevision: listed.reviewRevision,
        disposition: "cleared",
        summary: "Renamed API to Orders API; understood.",
      },
      { project: SLUG, refusal: true },
    );
    const pending = (await agent("list_changes", {})).cumulativeReviews.reviews.find(
      (x) => x.reviewId === listed.reviewId,
    );
    flow.note("staleCall", {
      refused: stale.refused === true,
      code: stale.code ?? null,
      stillPending: !!pending,
      read: listed.reviewRevision,
      current: moved.reviewRevision,
    });
    expect(
      stale.refused,
      `a resolve with the read revision ${listed.reviewRevision}, after the review moved to ${moved.reviewRevision}, is refused (got ${JSON.stringify(stale).slice(0, 200)})`,
    ).toBe(true);
    expect(stale.code, "refused as a review conflict").toBe("change_review_conflict");
    expect(pending?.reviewRevision, "the refused call left the review pending, at its current revision").toBe(
      moved.reviewRevision,
    );
    const resolved = await agent("resolve_change", {
      reviewId: listed.reviewId,
      expectedReviewRevision: moved.reviewRevision,
      disposition: "cleared",
      summary: "Renamed API to Orders API v2; understood.",
    });
    flow.note("resolved", { keys: Object.keys(resolved) });
    const after2 = await agent("list_changes", {});
    expect(
      after2.cumulativeReviews.reviews.filter((x) => x.reviewId === listed.reviewId),
      "resolved once: the review is no longer pending",
    ).toHaveLength(0);
    const again = await ui.agent(
      "resolve_change",
      {
        reviewId: listed.reviewId,
        expectedReviewRevision: moved.reviewRevision,
        disposition: "cleared",
        summary: "Again.",
      },
      { project: SLUG, refusal: true },
    );
    expect(again.refused, "a second resolve of the resolved review is refused").toBe(true);
  });
};
