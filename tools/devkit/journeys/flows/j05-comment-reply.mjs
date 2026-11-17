// J5 Comment and the agent's reply (user-flows §6): `checkout`, Explore → select node → `c` → type → send
// (queued: then Send queued) → agent get_comments → reply_comment → Notifications → the row.
// Mandatory outcome: the reply is on that node's thread, and the row lands on it.
//
// Select mode is overhead: the canvas opens in Hand mode, where a click pans and selects nothing, so `c` has no
// node to comment on; the goal itself does not need a mode switch (a right-click on the node opens the composer
// directly). It is kept in the baseline because it is the path the rubric names (select node → c).
//
// The queued cell (comment_submission = "queued") runs against a sandbox started with
// `sandbox.mjs up --comment-submission queued` (run.mjs --queued-sandbox).
import { begin, at, cellOf, CHECKOUT } from "./lib.mjs";
import { FLOW_INVARIANTS } from "./state-lib.mjs";

const BODY = "Does the Shop API retry a failed payment session?";
const REPLY = "Yes: once, two seconds later, then the order is marked Payment Failed.";
const NODE = { id: "api", label: "Shop API" };

export const meta = {
  name: "flows-j05-comment-reply",
  invariants: {
    // Owned by performance (S3 request counts), not deducted here (§1): sending one comment re-reads
    // api/comments/pending ×4 and api/comments?target=view:checkout ×3 in that step, and the queued cell reaches 42
    // requests on the diagram's view (api/comments ×21) by Send queued comments (O79). Kept visible as warnings.
    ...FLOW_INVARIANTS,
    "duplicate-requests": {
      severity: "warn",
      reason: "performance-owned: a comment send re-reads comments/pending and comments?target several times",
    },
  },
  flow: {
    id: "J5",
    matrix: { commentSubmission: ["immediate", "queued"] },
    baseline: [
      { action: "press Select mode", class: "overhead" },
      { action: "select node Shop API", class: "essential" },
      { action: "press c", class: "essential" },
      { action: "type the comment", class: "essential" },
      { action: "send (Add comment)", class: "essential" },
      // queued cell only: { action: "Send queued comments", class: "essential" }
      { action: "open Notifications", class: "essential" },
      { action: "open the thread's row", class: "essential" },
    ],
  },
};

export default async (ctx) => {
  const { page, step, expect, ui } = ctx;
  // The queued cell's pinned trace has one more essential action, after the send.
  const queued = cellOf(ctx, meta).commentSubmission === "queued";
  const baseline = queued
    ? [
        ...meta.flow.baseline.slice(0, 5),
        { action: "Send queued comments", class: "essential" },
        ...meta.flow.baseline.slice(5),
      ]
    : meta.flow.baseline;
  const { flow, rt, O } = await begin(ctx, { ...meta, flow: { ...meta.flow, baseline } });
  const node = page
    .getByRole("group", { name: "Sequence diagram canvas" })
    .getByRole("button", { name: NODE.label, exact: true });
  const discussion = page.getByRole("region", { name: "Contextual discussion" });

  await step("start: checkout, Explore", async () => {
    await page.goto(at(O, CHECKOUT));
    await expect(page.locator("g.archer-seq-participant").first()).toBeVisible();
    await expect(page.locator(".archer-diagram-panel[data-mode]")).toHaveAttribute("data-mode", "explore");
  });
  await rt.visit("checkout, Explore", { cue: { project: "Pageturner", document: "Checkout" } });

  await flow.act("press Select mode", "overhead", () =>
    page.getByRole("button", { name: "Select mode", exact: true }).click(),
  );
  await flow.act("select node Shop API", "essential", async () => {
    await node.click();
    await expect(page.locator(".archer-seq-selected")).not.toHaveCount(0);
  });
  await flow.act(
    "press c",
    "essential",
    async () => {
      await page.keyboard.press("c");
      await expect(discussion.getByRole("textbox", { name: "Comment" })).toBeVisible();
      await expect(discussion).toContainText(`Node: ${NODE.label}`);
    },
    { kind: "key" },
  );
  await flow.act(
    "type the comment",
    "essential",
    () => discussion.getByRole("textbox", { name: "Comment" }).fill(BODY),
    { kind: "type" },
  );
  await flow.act("send (Add comment)", "essential", async () => {
    await discussion.getByRole("button", { name: "Add comment" }).click();
    await expect(discussion.getByText(BODY)).toBeVisible();
  });
  if (queued) {
    await flow.act("Send queued comments", "essential", async () => {
      await page.getByRole("button", { name: /^Send queued comments/ }).click();
      await expect(page.getByRole("button", { name: /^Send queued comments/ })).toHaveCount(0);
    });
  }

  // The agent's side: the comment it reads names the node the person commented on.
  const thread = await step("agent: get_comments names the node's thread", async () => {
    const got = await ui.agent("get_comments", { target: "view:checkout" });
    const t = got.threads.find((x) => x.comments.some((c) => c.body === BODY));
    if (!t) throw new Error(`get_comments has no thread with the comment (threads: ${got.threads.length})`);
    expect(t.target).toBe("view:checkout");
    expect(t.anchor).toMatchObject({ kind: "node", id: NODE.id, label: NODE.label });
    expect(t.status).toBe("sent");
    return t;
  });
  await step("agent: reply_comment", async () => {
    const r = await ui.agent("reply_comment", { threadId: thread.id, body: REPLY, expectedRevision: thread.revision });
    expect(r.id).toBe(thread.id);
    expect(r.status).toBe("answered");
  });

  await step("the page shows the reply on that node's thread", async () => {
    await expect(discussion.getByText(REPLY)).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
  });
  await flow.act("open Notifications", "essential", async () => {
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
  });
  const review = page.getByRole("region", { name: "Project Review" });
  const row = review
    .getByRole("region", { name: /^Checkout\b/ })
    .getByRole("button", { name: new RegExp(`^Node: ${NODE.label}\\b`) });
  await flow.act("open the thread's row", "essential", () =>
    rt.inboxRow(row, { threadId: thread.id, anchor: NODE.label, label: "Notifications row for Node: Shop API" }),
  );

  await flow.goal("the reply is on that node's thread, and the row lands on it", async () => {
    const card = page.locator(`#primary-inbox-card-${thread.id}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(BODY);
    await expect(card).toContainText(REPLY);
  });
  await rt.visit("checkout after the row", { fields: ["path", "h1", "params"] });
  await rt.check();
};
