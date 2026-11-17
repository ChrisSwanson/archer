// J8 disconnection (user-flows.md §6): `checkout`, a comment being composed on the Customer participant.
// 8a–c: disconnect → Add comment → reconnect → Add comment, while the agent edits the file meanwhile.
// Mandatory outcome: the text kept and not shown as sent; sent once; the agent's edit appears without reload.
// Collectors: G1 (comment text and anchor read back from the page after each boundary), G4/U5 (the indicator is
// present while disconnected, the unsent text is not shown as sent, recovery needs no reload, the pending action
// completes once when repeated). In `queued` mode (sandbox.mjs up --comment-submission queued) Add comment keeps a
// draft and "Send queued comments (1)" sends it.
import { assertFlowChecks } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import {
  CHECKOUT,
  addComment,
  composeComment,
  g1Comment,
  navigationCounter,
  submissionMode,
  within,
} from "./state-lib.mjs";

/** ADR 0015: a foreground stream silent this long is replaced and reported lost; the check asserts it (PC-08). The
 * wait allows STALL_MARGIN_MS more only so a late notice is measured rather than missed. */
export const STALL_BOUND_MS = 45_000;
export const STALL_MARGIN_MS = 5_000;

export const AGENT_EDIT = { from: "Pay by card", to: "Pay by card or wallet" };

/** Baseline trace of 8a–c (the disconnect and reconnect are the environment's, not the person's). */
export const J8_BASELINE = [
  { action: "click Select mode", class: "essential" },
  { action: "click participant customer", class: "essential" },
  { action: "press c", class: "essential" },
  { action: "type the comment", class: "essential" },
  { action: "click Add comment (disconnected)", class: "essential" },
  { action: "click Add comment (reconnected)", class: "essential" },
];
/** The queued cell's extra step: Add comment keeps a draft, and the person sends it. */
export const SEND_QUEUED = { action: "click Send queued comments (1)", class: "essential" };
/**
 * J8a-stall's second part (user-flows v1.1 J8a: the notice "by the first failed read or write"): a second comment,
 * the network stalled just before its Add comment. The participant is Shop API: in view at 1440×900 and clear of the first thread's discussion.
 */
export const STALL_WRITE = { anchorId: "api" };
export const STALL_WRITE_BASELINE = [
  { action: `click participant ${STALL_WRITE.anchorId}`, class: "essential" },
  { action: "press c (second comment)", class: "essential" },
  { action: "type the second comment", class: "essential" },
  { action: "click Add comment (network stalled)", class: "essential" },
  { action: "click Add comment (network back)", class: "essential" },
];
/** The pinned trace of a J8 cell: `mode` as in disconnectJourney, `queued` the cell's comment_submission. */
export function j8Baseline(mode, queued) {
  const first = queued ? [...J8_BASELINE, SEND_QUEUED] : J8_BASELINE;
  if (mode !== "stall") return first;
  return [
    ...first,
    ...STALL_WRITE_BASELINE,
    ...(queued ? [{ ...SEND_QUEUED, action: `${SEND_QUEUED.action} (second comment)` }] : []),
  ];
}
/** Every J8a–c journey runs in both submission modes (rubric §1: "J5 and J8 also queued"). */
export const J8_MATRIX = { commentSubmission: ["immediate", "queued"] };

/** The comment's thread entries the page shows (text of a sent or draft comment, not the composer's own value). */
const shownAsComment = (page, text) =>
  page.getByText(text, { exact: true }).and(page.locator(":not(textarea, input)")).count();

/**
 * One J8 sub-journey. `mode`: "offline" (8a), "stall" (8a, real network loss: user-flows v1.1), "restart" (8b),
 * "both" (8c). The service is stopped for the whole
 * disconnected period in 8b/8c (ui.stopService/startService, the halves of ui.restartService), so the person's
 * Add comment and the agent's edit both happen while it is down.
 */
export async function disconnectJourney({ ui, step, expect, page, sandbox, run }, { mode, id }) {
  const offline = mode === "offline" || mode === "both",
    restart = mode === "restart" || mode === "both",
    stall = mode === "stall";
  const queued = submissionMode(sandbox) === "queued";
  const baseline = j8Baseline(mode, queued);
  const flow = flowRecorder({ step, run }, { id, baseline });
  const act = flow.stepFor(baseline); // the person's actions; every other step is the environment or a check
  run.flowState.j8 = { mode, submission: queued ? "queued" : "immediate" };
  await ui.resetProject(CHECKOUT.slug);
  if (stall) await ui.prepareStall();
  const disk0 = ui.fileState(CHECKOUT.slug, CHECKOUT.file);
  const text = `J8 ${mode} ${queued ? "queued" : "immediate"} question ${Date.now().toString(36)}`;
  await ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page, step: act, expect }, text);
  const captured = await ui.captureComment();
  await step("captured: the comment text on the Customer participant, kept with its target and revision", () => {
    expect(captured.text).toBe(text);
    expect(captured.target.anchor).toMatch(/Customer/);
    expect(captured.target.target, "the page keeps the draft for its view").toBe(CHECKOUT.target);
    expect(captured.target.anchorId).toBe(CHECKOUT.anchorId);
    expect(captured.baseRevision, "the kept draft names the revision it was written against").toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  // When the notice first shows, by the page's clock (PC-08: the stall bound is asserted from this, not from polling).
  if (stall)
    await page.evaluate(() => {
      window.__archerLostNoticeAt = null;
      const seen = () => {
        if (window.__archerLostNoticeAt === null && document.querySelector("[data-connection]"))
          window.__archerLostNoticeAt = Date.now();
      };
      new MutationObserver(seen).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-connection"],
      });
    });
  // Disconnect.
  if (offline) await ui.setOffline(true);
  if (restart) await ui.stopService();
  if (stall) await ui.stallNetwork(true);
  const lostAt = Date.now();
  const boundary =
    mode === "offline"
      ? "browser offline"
      : mode === "stall"
        ? "network stalled"
        : mode === "restart"
          ? "service down (restart)"
          : "browser offline and service down";
  // A stalled stream with no traffic says nothing until ADR 0015's silent-stall bound, 45 s. The wait allows a margin
  // only so a late notice is measured and reported; the check asserts the bound itself, from the stall (PC-08).
  const indicator = stall
    ? await step("the page shows it is disconnected (no traffic: ≤45 s silent-stall bound)", () =>
        within(page, () => ui.connection(), { timeout: STALL_BOUND_MS + STALL_MARGIN_MS }),
      )
    : await step("the page shows it is disconnected (≤10 s)", () => within(page, () => ui.connection()));
  const shownAt = stall ? await page.evaluate(() => window.__archerLostNoticeAt).catch(() => null) : null;
  const noticeMs = (shownAt ?? Date.now()) - lostAt;
  run.flowState.j8.noticeMs = noticeMs;
  const inBound = !stall || (shownAt !== null && noticeMs <= STALL_BOUND_MS);
  ui.flowCheck("G4", `${boundary}: disconnection indicator present`, Boolean(indicator) && inBound, {
    indicator: indicator ?? null,
    noticeMs,
    ...(stall
      ? {
          boundMs: STALL_BOUND_MS,
          marginMs: STALL_MARGIN_MS,
          measuredFromPage: shownAt !== null,
          ...(inBound
            ? {}
            : { problem: `the notice took ${noticeMs} ms from the stall; the bound is ${STALL_BOUND_MS} ms` }),
        }
      : {}),
    text: indicator
      ? await page
          .locator("[data-connection]")
          .first()
          .textContent()
          .catch(() => null)
      : null,
  });
  await g1Comment(ui, `${boundary}: before Add comment`, captured);

  // The agent edits the diagram meanwhile.
  await ui.agentWrite(CHECKOUT.slug, CHECKOUT.file, disk0.text.replace(AGENT_EDIT.from, AGENT_EDIT.to), {
    settleMs: 300,
  });

  await addComment({ page, step: act }, "click Add comment (disconnected)");
  await page.waitForTimeout(500); // let the refused request settle; the claims below are read after it
  const afterTry = await g1Comment(ui, `${boundary}: after Add comment while disconnected`, captured);
  const shown = await shownAsComment(page, text);
  const stored = restart ? null : (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).length;
  ui.flowCheck(
    "G4",
    `${boundary}: the unsent comment is not shown as sent`,
    shown === 0 && afterTry.text === text && (stored === null || stored === 0),
    { shownAsComment: shown, kept: afterTry.text === text, storedThreads: stored, alerts: await ui.alerts() },
  );

  // Reconnect without reloading.
  const nav = navigationCounter(page);
  if (restart) await ui.startService();
  if (offline) await ui.setOffline(false);
  if (stall) await ui.stallNetwork(false);
  const cleared = await step("the indicator clears once reconnected (≤10 s)", () =>
    within(page, async () => (await ui.connection()) === null),
  );
  ui.flowCheck("G4", "reconnected: the indicator clears without a reload", Boolean(cleared), {
    indicator: await ui.connection(),
  });
  await g1Comment(ui, "reconnected", captured);
  const caughtUp = await step("the agent's edit made meanwhile appears without a reload (≤10 s)", () =>
    within(page, async () => (await page.getByText(AGENT_EDIT.to, { exact: true }).count()) > 0),
  );
  ui.flowCheck(
    "G4",
    "reconnected: the change made meanwhile appears without a reload",
    Boolean(caughtUp) && nav.count === 0,
    { appeared: Boolean(caughtUp), navigations: nav.count },
  );

  // The pending action completes once when the person repeats it.
  await addComment({ page, step: act }, "click Add comment (reconnected)");
  if (queued) await sendQueued({ page, expect, step: act }, SEND_QUEUED.action);
  const threads = await step("the comment is stored once, sent, on the Customer participant", async () => {
    await within(page, async () =>
      (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).some((t) => t.status === "sent"),
    );
    return ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text);
  });
  const one = threads?.length === 1 ? threads[0] : null;
  ui.flowCheck("G5", "repeated after reconnect: one durable effect", threads?.length === 1, {
    effects: threads?.length ?? null,
    expected: 1,
  });
  ui.flowCheck(
    "G1",
    "sent: the service holds the captured text on the captured target",
    one !== null && one.anchor?.id === CHECKOUT.anchorId && one.comments.some((c) => c.body === text),
    { anchor: one?.anchor ?? null, status: one?.status ?? null },
  );
  // What the page announced about it: a sent comment is not "saved as a draft" (the queued mode's draft is).
  const said = (await page.locator(".primary-floating-discussion, [role=status], [aria-live]").allTextContents())
    .join(" ")
    .replace(/\s+/g, " ");
  const callsItDraft = /saved as a draft/i.test(said) && one?.status === "sent" && !queued;
  ui.flowCheck("G4", "sent: the page does not announce a sent comment as a draft", !callsItDraft, {
    status: one?.status ?? null,
    said: said.match(/[^.]*saved as a draft[^.]*\./i)?.[0] ?? null,
  });
  ui.flowCheck(
    "G4",
    "sent: the page shows it once, and as sent",
    one?.status === "sent" && (await shownAsComment(page, text)) === 1,
    { status: one?.status ?? null, shown: await shownAsComment(page, text) },
  );
  if (stall) await stalledWrite({ ui, step, act, expect, page, queued, text });
  nav.stop();
  run.flowState.j8.navigations = nav.count;
  await assertFlowChecks({ step, run, flow });
}

/** Send queued comments (1): queued mode's Add comment keeps a draft; this sends it. */
const sendQueued = ({ page, expect, step }, title) =>
  step(title, async () => {
    const send = page
      .getByRole("region", { name: "Contextual discussion", exact: true })
      .getByRole("button", { name: /^Send queued comments \(1\)$/ });
    await expect(send).toBeVisible();
    await send.click();
  });

/**
 * J8a-stall, second part: the network stalls with the page idle, and the person's Add comment is the first request
 * to fail. The notice must come from that failed write (one check of api/connection, http-connection.ts), within
 * the harness timeout, and before any read has failed: neither the 45 s silent-stall watchdog nor a later read
 * may be what brought it. Then: the text kept and not shown as sent, nothing stored; back online, sent once.
 */
async function stalledWrite({ ui, step, act, expect, page, queued, text: first }) {
  const text = `${first} — second, written while stalled`;
  await act(
    `click participant ${STALL_WRITE.anchorId}`,
    () => page.locator(`g.archer-seq-participant[data-seq-id="${STALL_WRITE.anchorId}"]`).first().click(),
    { selectionMayChange: true },
  );
  const box = page.getByRole("textbox", { name: "Comment", exact: true });
  await act("press c (second comment)", async () => {
    await page.keyboard.press("c");
    await expect(box).toBeVisible();
  });
  await act("type the second comment", () => box.fill(text));
  const captured = await ui.captureComment();
  await step("captured: the second comment's text on its participant", () => {
    expect(captured.text).toBe(text);
    expect(captured.target.anchor).toMatch(/Shop API/);
  });
  await page.waitForTimeout(1000); // the page idle: the reads after the first comment's send have settled
  // When the notice first shows, by the page's clock (Date.now, the same clock as the failures below).
  await page.evaluate(() => {
    window.__archerNoticeAt = null;
    const seen = () => {
      if (window.__archerNoticeAt === null && document.querySelector("[data-connection]"))
        window.__archerNoticeAt = Date.now();
    };
    new MutationObserver(seen).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-connection"],
    });
  });
  const failed = [];
  const onFailed = (r) =>
    failed.push({
      at: Date.now(),
      method: r.method(),
      path: new URL(r.url()).pathname,
      error: r.failure()?.errorText ?? null,
    });
  page.on("requestfailed", onFailed);
  await ui.stallNetwork(true);
  const stalledAt = Date.now();
  await act("click Add comment (network stalled)", () =>
    page.getByRole("button", { name: "Add comment", exact: true }).click(),
  );
  const wroteAt = Date.now();
  const indicator = await step("the page shows it is disconnected after the failed write (≤10 s)", () =>
    within(page, () => ui.connection()),
  );
  const noticeAt = await page.evaluate(() => window.__archerNoticeAt);
  page.off("requestfailed", onFailed);
  const before = failed.filter((f) => noticeAt !== null && f.at <= noticeAt);
  // Evidence that would have brought the notice without the write: a failed data read (a GET of the page's api/
  // other than the connection check itself and the event stream, which the page closes as it reports "lost").
  const isWrite = (f) => f.method === "POST" && /\/api\/comments(\/|$)/.test(f.path);
  const isRead = (f) => f.method === "GET" && /\/api\//.test(f.path) && !/\/api\/(connection|events)$/.test(f.path);
  const byWrite = before.some(isWrite) && !before.some(isRead);
  const writeNoticeMs = noticeAt === null ? null : noticeAt - wroteAt;
  ui.flowCheck(
    "G4",
    "network stalled, first failed write: disconnection indicator present",
    Boolean(indicator) && byWrite,
    {
      indicator: indicator ?? null,
      writeNoticeMs,
      sinceStallMs: noticeAt === null ? null : noticeAt - stalledAt,
      byWrite,
      failedBeforeNotice: before.map((f) => `${f.method} ${f.path.replace(/^.*\/api\//, "api/")} ${f.error}`),
    },
  );
  // The page retries an unanswered operation a few times by itself (useReview OPERATION_RETRY_DELAYS_MS); the network
  // stays stalled until it has given up and said what it knows, so the person's repeat below is what sends it.
  const said = await step("the page says the comment may not have been sent (≤10 s)", () =>
    within(page, async () => {
      const t = (await page.locator(".primary-floating-discussion").allTextContents()).join(" ").replace(/\s+/g, " ");
      return t.match(/[^.]*(may have been sent|could not add|was not sent)[^.]*\./i)?.[0] ?? null;
    }),
  );
  ui.flowCheck(
    "G4",
    "network stalled, failed write: the page says it may not have been sent, not that it failed or was sent",
    Boolean(said) && !/could not add/i.test(said ?? ""),
    { said: said ?? null },
  );
  const afterTry = await g1Comment(ui, "network stalled: after the failed Add comment", captured);
  const shown = await page.getByText(text, { exact: true }).and(page.locator(":not(textarea, input)")).count();
  const stored = (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).length;
  ui.flowCheck(
    "G4",
    "network stalled, failed write: the comment is not shown as sent",
    shown === 0 && afterTry.text === text && stored === 0,
    { shownAsComment: shown, kept: afterTry.text === text, storedThreads: stored, alerts: await ui.alerts() },
  );
  await ui.stallNetwork(false);
  const cleared = await step("the indicator clears once the network is back (≤10 s)", () =>
    within(page, async () => (await ui.connection()) === null),
  );
  ui.flowCheck("G4", "network back after the failed write: the indicator clears", Boolean(cleared), {
    indicator: await ui.connection(),
  });
  await act("click Add comment (network back)", () =>
    page.getByRole("button", { name: "Add comment", exact: true }).click(),
  );
  if (queued) await sendQueued({ page, expect, step: act }, `${SEND_QUEUED.action} (second comment)`);
  const threads = await step("the second comment is stored once, sent", async () => {
    await within(page, async () =>
      (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).some((t) => t.status === "sent"),
    );
    return ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text);
  });
  ui.flowCheck(
    "G5",
    "failed write, repeated after the network is back: one durable effect",
    threads?.length === 1 && threads[0].status === "sent" && threads[0].anchor?.id === STALL_WRITE.anchorId,
    {
      effects: threads?.length ?? null,
      expected: 1,
      status: threads?.[0]?.status ?? null,
      anchor: threads?.[0]?.anchor ?? null,
    },
  );
  return { writeNoticeMs };
}
