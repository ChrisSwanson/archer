// J8d response lost after commit (user-flows.md §6, §3 G5): the request reaches the service and commits, and its
// answer is dropped before the page hears it (ui.dropResponseAfterCommit: route.fetch() then route.abort()).
// G5: exactly one durable effect, with the right target and content, after the same operation is sent again before
// and after a service restart; the final status is true (sent or saved, or the outcome stated as uncertain); a new
// operation with identical content then takes effect (count 2). Effects are counted from the service's threads
// (what get_comments reads) and from the file bytes and change review (list_changes) for a save.
//
// The page resends an unanswered operation by itself (ADR 0016), so the person makes no retry click (the pinned
// trace has none; PC-01, PC-10, codex-04). The retry is proved instead by sending the exact request the page sent
// first (same operation id) again from the page, before and after a real restart: it must be answered from its
// receipt (`replayed: true`) with the count still one. The seeded fault `repeat-effect` (a resend as a new
// operation) is that check's known fail.
//
// Three parts:
//   control   one comment, nothing dropped: one effect. This is the counter's known pass; the seeded fault
//             `repeat-effect` (POST /api/comments sent twice) is its known fail.
//   comment   Add comment with its answer dropped; in the queued cell, Send with its answer dropped too (O83);
//             the same create (and send) resent before the restart and after it; then a new identical comment.
//   save      J6's Save with its answer dropped; the page reconciles by operation id; restart; the file holds the
//             person's version once and the change review counted one save.
import { assertFlowChecks, g5Verdict } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import {
  CHECKOUT,
  DISCONNECT_INVARIANTS,
  FLOW,
  addComment,
  composeComment,
  savedClaim,
  submissionMode,
  within,
} from "./state-lib.mjs";

export const meta = {
  name: "flows-j08d-lost-response",
  invariants: { ...DISCONNECT_INVARIANTS, "editor-alert": false },
  flow: {
    id: "J8d",
    baseline: [
      { action: "click Select mode", class: "essential" },
      { action: "click participant customer", class: "essential" },
      { action: "press c", class: "essential" },
      { action: "type the comment", class: "essential" },
      { action: "click Add comment (answer lost)", class: "essential" },
    ],
    matrix: { commentSubmission: ["immediate", "queued"] },
  },
};
/** The queued cell's pinned trace: the lost comment is a draft until the person sends it (that answer is lost too). */
meta.flow.baselines = {
  immediate: meta.flow.baseline,
  queued: [...meta.flow.baseline, { action: "click Send queued comments (answer lost)", class: "essential" }],
};

const count = async (ui, text) => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).length;
const discussion = async (page) =>
  (
    (await page
      .locator(".primary-floating-discussion")
      .innerText()
      .catch(() => "")) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();

/** What the page says now: its alerts (a refusal or an uncertain outcome) and its last announcement. */
const claims = async (page) =>
  (
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="alert"], .archer-review-announcer')]
        .map((el) => el.textContent ?? "")
        .join(" | "),
    )
  )
    .replace(/\s+/g, " ")
    .trim();

async function sendQueued({ page, step, expect }, title = "click Send queued comments") {
  await step(title, async () => {
    const send = page
      .getByRole("region", { name: "Contextual discussion", exact: true })
      .getByRole("button", { name: /^Send queued comments/ });
    await expect(send).toBeVisible();
    await send.click();
  });
}

export default async ({ ui, step, expect, page, sandbox, run }) => {
  const queued = submissionMode(sandbox) === "queued";
  const baseline = meta.flow.baselines[queued ? "queued" : "immediate"];
  const flow = flowRecorder({ step, run }, { id: meta.flow.id, baseline });
  const act = flow.stepFor(baseline); // the lost comment's actions only; the control, the identical comment and the save are probes
  const stamp = Date.now().toString(36);
  run.flowState.j8d = { submission: queued ? "queued" : "immediate" };
  await ui.resetProject(CHECKOUT.slug);
  await ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);

  // Control: the effect counter on a plain comment.
  const control = `J8d control ${stamp}`;
  await composeComment({ page, step, expect }, control);
  await addComment({ page, step });
  if (queued) await sendQueued({ page, step, expect });
  await step("control: the comment is stored", () =>
    within(page, async () => (await count(ui, control)) >= 1, { timeout: 5000 }),
  );
  await page.waitForTimeout(500); // a second effect (the repeat-effect fault) lands within the same request
  const c0 = g5Verdict({ effects: await count(ui, control), expected: 1, label: "control comment" });
  ui.flowCheck("G5", "control: one comment, one effect", c0.ok, c0);

  // Comment with its answer lost.
  await ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  const text = `J8d lost answer ${stamp}`;
  await composeComment({ page, step: act, expect }, text);
  const drop = await ui.dropResponseAfterCommit("**/api/comments");
  await addComment({ page, step: act }, "click Add comment (answer lost)");
  await step("the request committed and its answer was dropped", async () => {
    await within(page, () => drop.drops.length > 0, { timeout: 5000 });
    expect(drop.drops[0]?.status).toBeLessThan(300);
  });
  await page.waitForTimeout(500);
  const claim1 = await discussion(page);
  const n1 = await count(ui, text);
  ui.flowCheck("G5", "answer lost: the effect committed once", n1 === 1, {
    effects: n1,
    expected: 1,
    droppedStatus: drop.drops[0]?.status ?? null,
  });
  // The page's claim right after: committed, so "could not add" is false; "sent" or "uncertain" are true.
  const saysFailed = /could not add|failed/i.test(claim1),
    saysUncertain = /uncertain|may have|not sure|check/i.test(claim1);
  ui.flowCheck(
    "G4",
    "answer lost: the page's claim is true (sent, or uncertain), not failed",
    !saysFailed || saysUncertain,
    { claim: claim1.slice(0, 300) },
  );
  // Queued: the person sends it, and that answer is lost too (PC-02, O83). The page resends the same send itself.
  const sendDrop = queued ? await ui.dropResponseAfterCommit("**/api/comments/submit") : null;
  if (queued) {
    await sendQueued({ page, step: act, expect }, "click Send queued comments (answer lost)");
    await step("the send committed and its answer was dropped", async () => {
      await within(page, () => sendDrop.drops.length > 0, { timeout: 5000 });
      expect(sendDrop.drops[0]?.status).toBeLessThan(300);
    });
    await page.waitForTimeout(2000); // the page's own resends (250 ms, then 1 s) and its read-back
    const said = await claims(page);
    const sent = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text);
    ui.flowCheck(
      "G4",
      "send answer lost: the page does not say it could not send",
      !/could not send|failed to fetch/i.test(said),
      { claim: said.slice(0, 300), statuses: sent.map((t) => t.status) },
    );
    // True: it says what was sent, or that the outcome is uncertain; the service holds it sent, once.
    ui.flowCheck(
      "G4",
      "send answer lost: the final status is true",
      sent.length === 1 && sent[0].status === "sent" && /sent 1 thread|may have been sent/i.test(said),
      { claim: said.slice(0, 300), statuses: sent.map((t) => t.status) },
    );
  }
  // The retry, really executed: the exact first request (same operation id) sent again from the page.
  const replay = async (when) => {
    const again = await ui.resendInPage(drop.drops[0]);
    const n = await count(ui, text);
    ui.flowCheck(
      "G5",
      `answer lost, the same operation resent ${when}: answered from its receipt, one effect`,
      again.status === 200 && again.json?.replayed === true && n === 1,
      {
        status: again.status,
        replayed: again.json?.replayed ?? null,
        operation: again.operationId,
        effects: n,
        expected: 1,
      },
    );
    if (!queued) return;
    const send = await ui.resendInPage(sendDrop.drops[0]);
    const sent = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text);
    ui.flowCheck(
      "G5",
      `send answer lost, the same send resent ${when}: answered from its receipt, sent once`,
      send.status === 200 &&
        send.json?.replayed === true &&
        send.json?.submitted === 1 &&
        sent.length === 1 &&
        sent[0].status === "sent",
      {
        status: send.status,
        replayed: send.json?.replayed ?? null,
        submitted: send.json?.submitted ?? null,
        operation: send.operationId,
        statuses: sent.map((t) => t.status),
      },
    );
  };
  await replay("before restart");
  await ui.restartService();
  await within(page, async () => (await ui.connection()) === null);
  await replay("after restart");
  const threads = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text);
  const v3 = g5Verdict({ effects: threads.length, expected: 1, label: "comment resent before and after restart" });
  ui.flowCheck("G5", "answer lost, resent before and after restart: one effect", v3.ok, {
    ...v3,
    anchors: threads.map((t) => t.anchor?.id),
    statuses: threads.map((t) => t.status),
  });
  ui.flowCheck(
    "G5",
    "answer lost: the effect has the right target and content",
    threads.length >= 1 && threads.every((t) => t.anchor?.id === CHECKOUT.anchorId),
    { anchors: threads.map((t) => t.anchor?.id) },
  );
  const shown = await page.getByText(text, { exact: true }).and(page.locator(":not(textarea, input)")).count();
  // `shown` is evidence only: the node's discussion lists one thread and badges the count.
  ui.flowCheck(
    "G4",
    "answer lost: the final status is true",
    shown >= 1 && threads.length >= 1 && threads.every((t) => t.status === "sent"),
    {
      shown,
      stored: threads.length,
      statuses: threads.map((t) => t.status),
      discussion: (await discussion(page)).slice(0, 300),
    },
  );

  // A new operation with identical content takes effect.
  await ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page, step, expect }, text);
  await addComment({ page, step }, "click Add comment (new, identical text)");
  if (queued) await sendQueued({ page, step, expect });
  await within(page, async () => (await count(ui, text)) >= threads.length + 1, { timeout: 5000 });
  const n4 = await count(ui, text);
  ui.flowCheck("G5", "a new identical comment takes effect (count +1)", n4 === threads.length + 1, {
    effects: n4,
    expected: threads.length + 1,
    ...(threads.length === 1 ? {} : { note: "the retries above already left more than one" }),
  });

  // Lost, then reload (claude-202, PC-201, O102): every try of a new comment is answered and dropped, so the page is
  // left uncertain; then the page itself is reloaded (the harness resends nothing). The restored comment says it may
  // already have been sent, and the person's Add comment is answered from the receipt: one comment. The seeded fault
  // `forget-operation-hold` (the identity dropped at reload) is this check's known fail.
  await ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  const reloaded = `J8d lost then reload ${stamp}`;
  await composeComment({ page, step, expect }, reloaded);
  const allLost = await ui.dropResponseAfterCommit("**/api/comments", { times: 3 });
  await addComment({ page, step }, "click Add comment (every answer lost)");
  await within(page, async () => /may have been sent/i.test(await discussion(page)), { timeout: 5000 });
  await allLost.off();
  await step("reload after the lost answer", () => page.reload());
  const box = page.getByRole("textbox", { name: "Comment", exact: true });
  await within(page, async () => (await box.count()) > 0 && (await box.inputValue().catch(() => "")) === reloaded);
  const restoredSays = await discussion(page);
  ui.flowCheck(
    "G4",
    "lost, then reload: the restored comment says it may already have been sent",
    /may already have been sent/i.test(restoredSays) && !/Restored your unsent comment/i.test(restoredSays),
    { said: restoredSays.slice(0, 300) },
  );
  await addComment({ page, step }, "click Add comment (after the reload)");
  if (queued) await sendQueued({ page, step, expect });
  await within(
    page,
    async () => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, reloaded)).some((t) => t.status === "sent"),
    { timeout: 5000 },
  );
  await page.waitForTimeout(500);
  const afterReload = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, reloaded);
  const vr = g5Verdict({ effects: afterReload.length, expected: 1, label: "lost answer, page reloaded, added again" });
  ui.flowCheck(
    "G5",
    "lost, then reload: the page's own resend is the same comment, one effect",
    vr.ok && afterReload.every((t) => t.comments.filter((c) => c.body === reloaded).length === 1),
    {
      ...vr,
      operations: [
        ...new Set(
          allLost.drops.map((d) => {
            try {
              return JSON.parse(d.request).operation.id;
            } catch {
              return null;
            }
          }),
        ),
      ],
      statuses: afterReload.map((t) => t.status),
    },
  );

  // Two tabs, the same words (codex-301, O114).
  await twoTabsSameWords({ ui, step, expect, queued, stamp });

  // Save with its answer lost.
  await ui.resetProject(FLOW.slug);
  const before = ui.fileState(FLOW.slug, FLOW.file);
  const reviewBefore = await ui.archerCall(FLOW.slug, "list_changes", {});
  const savesOf = (r) =>
    (r?.cumulativeReviews?.reviews ?? [])
      .filter((x) => x.subject?.path === FLOW.file)
      .reduce((n, x) => n + (x.saveCount ?? 0), 0);
  await ui.openDiagram(FLOW.slug, FLOW.path);
  await ui.enterEdit();
  await ui.rename(FLOW.node, "Lost answer");
  const captured = await ui.captureEditor(FLOW.slug, ui);
  const saveDrop = await ui.dropResponseAfterCommit("**/api/authoring", {
    when: (r) => /"op":"document\.apply"/.test(r.postData() ?? ""),
  });
  await step(
    "click Save (answer lost)",
    async () => {
      await page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true }).click();
      await within(page, () => saveDrop.drops.length > 0, { timeout: 5000 });
      // The save committed but its answer was dropped, so the dirty-navigation invariant (savedInStep: a POST
      // api/authoring answered < 400) cannot see it and took the page leaving the saved editor for a silent
      // discard (O??). Whether leaving was right is judged by the G4/G5 checks below: the file holds the person's
      // version, and one save was recorded.
    },
    { leavesEditor: true },
  );
  // The page asks the service for the operation's outcome by its id; give it the harness timeout to do so.
  const settled = await within(page, async () => {
    const s = await ui.editorState();
    return s && (!s.editing || s.recovery || /uncertain|unresolved/i.test(s.status ?? "")) ? s : null;
  });
  const after = ui.fileState(FLOW.slug, FLOW.file);
  ui.flowCheck("G5", "save answer lost: the file holds the person's version", after.text === captured.text, {
    diskRevision: after.revision,
    baseRevision: before.revision,
  });
  // True status, said (PC-03): the editor closed onto a page that says the person saved it (J6's "Saved · HH:MM" in
  // their voice), or the editor is still open saying the outcome is uncertain. Closing alone is not a claim.
  const saved =
    settled !== null && settled.editing === false
      ? await savedClaim(page)
      : { saidSaved: false, claim: null, voice: null };
  const uncertainSaid =
    settled !== null && settled.editing === true && /uncertain|unresolved/i.test(settled.status ?? "");
  ui.flowCheck(
    "G4",
    "save answer lost: the final status is true (saved, or uncertain)",
    settled !== null && (saved.saidSaved || uncertainSaid),
    {
      editing: settled?.editing ?? null,
      status: settled?.status ?? null,
      recovery: settled?.recovery ?? null,
      claim: saved.claim,
      voice: saved.voice,
    },
  );
  await ui.restartService();
  const reviewAfter = await ui.archerCall(FLOW.slug, "list_changes", {});
  const saves = savesOf(reviewAfter) - savesOf(reviewBefore);
  const vs = g5Verdict({ effects: saves, expected: 1, label: "save with a lost answer, then a restart" });
  ui.flowCheck(
    "G5",
    "save answer lost, after restart: one save recorded, file unchanged since",
    vs.ok && ui.fileState(FLOW.slug, FLOW.file).text === captured.text,
    { ...vs, droppedStatus: saveDrop.drops[0]?.status ?? null },
  );
  await saveDrop.off();
  await drop.off();
  await sendDrop?.off();
  await assertFlowChecks({ step, run, flow });
};

/**
 * Two tabs of one profile, the same words (codex-301, O114), as probes: tab A types a comment on Customer; tab B
 * opens checkout, is told A is writing there, and types the same words itself. Every answer to A's Add comment is lost
 * after commit, so A says it may have been sent and keeps its text; B adds its own; then A adds again, answered from
 * its receipt. Two separately written comments: two stored, each once. The seeded fault `content-keyed-identity` (an
 * identity made from the words, as before codex-301: B's Add comment repeats A's operation) is this check's known fail.
 */
async function twoTabsSameWords({ ui, step, expect, queued, stamp }) {
  const same = `J8d same words ${stamp}`;
  const box = (p) => p.getByRole("textbox", { name: "Comment", exact: true });
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step, expect }, same);
  const b = await ui.openContext();
  await b.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await within(b.page, async () => (await box(b.page).count()) > 0, { timeout: 5000 });
  await within(b.page, async () => /being written in another tab/i.test(await discussion(b.page)), { timeout: 3000 });
  await step("tab B: type the same words", () => box(b.page).fill(same));
  const lost = await a.ui.dropResponseAfterCommit("**/api/comments", { times: 3 });
  await addComment({ page: a.page, step }, "tab A: click Add comment (every answer lost)");
  await within(a.page, async () => /may have been sent/i.test(await discussion(a.page)), { timeout: 5000 });
  await lost.off();
  const sentB = [];
  b.page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/comments$/.test(new URL(r.url()).pathname)) {
      try {
        sentB.push(JSON.parse(r.postData() ?? "").operation?.id ?? null);
      } catch {
        sentB.push(null);
      }
    }
  });
  await addComment({ page: b.page, step }, "tab B: click Add comment");
  await within(
    b.page,
    async () =>
      (await box(b.page)
        .inputValue()
        .catch(() => "")) === "",
    { timeout: 5000 },
  );
  await addComment({ page: a.page, step }, "tab A: click Add comment again");
  await within(
    a.page,
    async () =>
      (await box(a.page)
        .inputValue()
        .catch(() => "")) === "",
    { timeout: 5000 },
  );
  if (queued) {
    // Both are drafts until sent; the person sends them from either tab.
    const send = b.page
      .getByRole("region", { name: "Contextual discussion", exact: true })
      .getByRole("button", { name: /^Send queued comments/ });
    await step("tab B: click Send queued comments", async () => {
      await expect(send).toBeVisible();
      await send.click();
    });
  }
  await a.page.waitForTimeout(500);
  const threads = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, same);
  const opA = (() => {
    try {
      return JSON.parse(lost.drops[0]?.request ?? "").operation?.id ?? null;
    } catch {
      return null;
    }
  })();
  const each = threads.every(
    (t) => t.comments.filter((c) => c.body === same).length === 1 && t.anchor?.id === CHECKOUT.anchorId,
  );
  const v = g5Verdict({ effects: threads.length, expected: 2, label: "two tabs, the same words, A's answers lost" });
  ui.flowCheck(
    "G5",
    "two tabs, the same words, A's answers lost: two comments, each once",
    v.ok && each && (!queued || threads.every((t) => t.status === "sent")),
    {
      ...v,
      operationA: opA,
      operationsB: sentB,
      distinct: opA !== null && !sentB.includes(opA),
      statuses: threads.map((t) => t.status),
    },
  );
  await a.page.close({ runBeforeUnload: false });
  await b.page.close({ runBeforeUnload: false });
}
