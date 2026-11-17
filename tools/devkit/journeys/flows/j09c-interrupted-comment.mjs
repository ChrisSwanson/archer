// J9c interrupted comment: J9's boundaries for a comment being written (user-flows.md §3 G1, §6 promise list:
// reload; closing the tab and reopening it in the same profile; browser offline; storage denied or full), which
// the packet never crossed (review flows-r1 claude-01 / PC-06, codex-01 / codex-03; O82). Not a §6 journey of its
// own: J8's start state ("comment being composed") interrupted the way J9 interrupts an edit, pending the next
// freeze.
//
// `checkout`, the Customer participant: Select → c → type. Then, each a G1 boundary whose read-back is observed (the
// text in the box, the anchor shown, and the target, anchor id and base revision of the draft the page keeps):
//   reload · close the tab and reopen its address in the same profile · offline, a refused Add comment, online,
//   reload · Escape, then c on the same participant (G3: Escape keeps the text)
// and: the draft never appears on another diagram; Discard is explicit and leaves nothing behind; a browser that
// refuses storage is told the text cannot be kept.
//
// A reply being written gets the same boundaries (ruling 2026-11-02 "Comment drafts (G1)", O93), as probes
// outside the pinned trace: on a thread the person adds, a reply typed and then reload · close and reopen · leave for
// another diagram and come back · Escape and reopen the thread from its pin, each read back (the text in the box and
// the thread the kept draft names); Discard leaves nothing; a sent reply is on the thread once and no longer kept.
// An edit of one of the person's own comments being written (the last G1 gap after O93; O111), as probes outside the
// pinned trace: Edit, type, then reload · close and reopen · Escape and reopen the thread from its pin, each read back
// (the text in the box, the thread and comment the kept edit names, and the text it began from); then the comment is
// changed from another device meanwhile: the open tab and, after a reload, the restored editor say so and keep the
// person's text, and only "Save over it" writes it; a Save that meets a change the page has not seen yet is refused
// and turns into "Save over it" (O124); Discard leaves nothing and the comment as it is.
// Two tabs of one profile on one participant (claude-201): neither is given the other's live text, one's Add comment
// leaves the other's text kept, and each text is stored once. Mandatory outcome: the person gets their text back, on that
// target, said as restored, and adds it once.
import { assertFlowChecks } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { compareState } from "../../harness/flows-state.mjs";
import {
  CHECKOUT,
  DISCONNECT_INVARIANTS,
  addComment,
  composeComment,
  g1Comment,
  within,
  reopenTab,
  sessionOf,
} from "./state-lib.mjs";

const RESTORED = /Restored your unsent comment/;
const REPLY_RESTORED = /Restored your unsent reply/;
const UNKEPT = /cannot keep this comment if you reload or close/i;
const ELSEWHERE = /being written in another tab/i;
const EDIT_RESTORED = /Restored your unsaved edit/;
const EDIT_CHANGED = /This comment changed since you started editing it/;
export const meta = {
  name: "flows-j09c-interrupted-comment",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J9c",
    baseline: [
      { action: "click Select mode", class: "essential" },
      { action: "click participant customer", class: "essential" },
      { action: "press c", class: "essential" },
      { action: "type the comment", class: "essential" },
      { action: "reload (F5)", class: "essential" },
      { action: "close the tab (Ctrl+W)", class: "essential" },
      { action: "reopen the closed tab (Ctrl+Shift+T)", class: "essential" },
      { action: "click Add comment (offline)", class: "essential" },
      { action: "reload after reconnecting", class: "essential" },
      { action: "press Escape", class: "essential" },
      { action: "press c again", class: "essential" },
      { action: "click Discard it", class: "essential" },
    ],
  },
};

export default async ({ ui, step, expect, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  const act = flow.stepFor(meta.flow.baseline);
  await ui.resetProject(CHECKOUT.slug);
  const read = await ui.agent("read_diagram", { viewId: "checkout" });
  const text = `J9c unsent question ${Date.now().toString(36)}`;
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step: act, expect }, text);
  const captured = await a.ui.captureComment();
  ui.flowCheck(
    "G1",
    "typed: the page keeps the text with its target and the revision on screen",
    captured.text === text &&
      captured.target.target === CHECKOUT.target &&
      captured.target.anchorId === CHECKOUT.anchorId &&
      captured.baseRevision === read.modelRevision,
    { captured, modelRevision: read.modelRevision },
  );

  const box = (p) => p.getByRole("textbox", { name: "Comment", exact: true });
  const restoredSaid = async (p) => (await p.getByText(RESTORED).count()) > 0;
  /** Back on the diagram: the composer comes back by itself with the text (bounded wait), said as restored. */
  const back = async (p, u, boundary) => {
    await within(
      p,
      async () =>
        (await box(p).count()) > 0 &&
        (await box(p)
          .inputValue()
          .catch(() => "")) !== "",
    );
    await g1Comment(u, boundary, captured);
    ui.flowCheck("G4", `${boundary}: the restored comment says so`, await restoredSaid(p), {});
  };

  // Boundary 1: reload.
  await act("reload (F5)", () => a.page.reload());
  await back(a.page, a.ui, "reload");

  // Boundary 2: close the tab, reopen its address in the same profile.
  const session = await sessionOf(a.page);
  const address = a.page.url();
  await act("close the tab (Ctrl+W)", () => a.page.close({ runBeforeUnload: false }));
  const b = await reopenTab(ui, session);
  await act("reopen the closed tab (Ctrl+Shift+T)", () => b.page.goto(address));
  await back(b.page, b.ui, "close the tab and reopen it");

  // Another diagram of the same project: the draft is the Customer participant's on checkout, and never shows here.
  await b.ui.openDiagram(CHECKOUT.slug, "diagrams/containers.mmd");
  await b.page.waitForTimeout(800);
  const elsewhere =
    (await box(b.page).count()) > 0
      ? await box(b.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "another diagram: the draft does not appear there",
    elsewhere !== text && (await b.page.getByText(RESTORED).count()) === 0,
    { elsewhere },
  );
  await b.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await back(b.page, b.ui, "back on the diagram it is about");

  // Boundary 3: browser offline; the person tries to add it; back online, they reload.
  await b.ui.setOffline(true);
  await within(b.page, () => b.ui.connection());
  await addComment({ page: b.page, step: act }, "click Add comment (offline)");
  await b.page.waitForTimeout(500);
  await g1Comment(b.ui, "browser offline: after Add comment", captured);
  await b.ui.setOffline(false);
  await within(b.page, async () => (await b.ui.connection()) === null);
  await act("reload after reconnecting", () => b.page.reload());
  await back(b.page, b.ui, "offline, then reload");
  const stored = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text);
  ui.flowCheck("G4", "offline, then reload: the unsent comment is not stored as sent", stored.length === 0, {
    storedThreads: stored.length,
  });

  // Escape closes the composer and keeps the text (G3); asking again on the same participant gives it back.
  await act("press Escape", async () => {
    await box(b.page).press("Escape");
    await expect(box(b.page)).toHaveCount(0);
  });
  // The reload put the pointer back in Hand mode, where a click selects nothing; it passed only when the restored
  // composer had already selected the participant, a race (1 of 3 on flows/fix-r1b-replies, O93). Select first.
  const select = b.page.getByRole("button", { name: "Select mode", exact: true });
  if ((await select.getAttribute("aria-pressed")) !== "true") await select.click();
  await b.page.locator(`g.archer-seq-participant[data-seq-id="${CHECKOUT.anchorId}"]`).first().click();
  await act("press c again", async () => {
    await b.page.keyboard.press("c");
    await expect(box(b.page)).toBeVisible();
  });
  await g1Comment(b.ui, "Escape, then c on the same participant", captured);

  // Discard: explicit, and nothing is kept or offered back afterwards.
  await act("click Discard it", () => b.page.getByRole("button", { name: "Discard it", exact: true }).click());
  await b.page.reload();
  await b.page.waitForTimeout(1500);
  const kept = (await b.ui.storedComments()).filter((d) => d.body === text);
  const reoffered =
    (await box(b.page).count()) > 0
      ? await box(b.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "discard: explicit, the draft gone and not offered back",
    kept.length === 0 && reoffered !== text,
    { kept: kept.length, reoffered },
  );
  await b.page.close({ runBeforeUnload: false });

  // A reply being written (O93): the same boundaries, on a thread the person adds now.
  await replyBoundaries({ ui, step, expect });

  // An edit of an existing comment (O111): the same boundaries, and a change made elsewhere meanwhile.
  await editBoundaries({ ui, step, expect });

  // Two tabs of one profile on the same participant (claude-201, O103).
  await twoTabs({ ui, step, expect });

  // A duplicated tab and a busy owner tab (claude-301, -302, O117).
  await duplicateAndBusy({ ui, step, expect });

  // §6 "storage denied or full (the page must say so)": a tab whose localStorage refuses writes.
  const e = await ui.openContext();
  await e.page.addInitScript(() => {
    const deny = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    try {
      Object.defineProperty(Storage.prototype, "setItem", { value: deny, configurable: true });
    } catch {
      /* already denied */
    }
  });
  await e.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: e.page, step, expect }, "Unkept question", {
    typeExpects: [{ kind: "alert", text: "cannot keep this comment" }],
  });
  const said = (await e.page.getByText(UNKEPT).count()) > 0;
  ui.flowCheck("G1", "storage denied: the page says the comment cannot be kept, before the person relies on it", said, {
    alerts: await e.ui.alerts(),
  });
  await e.page.close({ runBeforeUnload: false });
  await assertFlowChecks({ step, run, flow });
};

/** The reply half of J9c: a thread to answer, a reply typed, then each boundary read back from the page and its draft. */
async function replyBoundaries({ ui, step, expect }) {
  const host = `J9c thread ${Date.now().toString(36)}`,
    text = `J9c unsent reply ${Date.now().toString(36)}`;
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step, expect }, host);
  await addComment({ page: a.page, step });
  const replyBox = (p) => p.getByRole("textbox", { name: "Your reply", exact: true }).first();
  await step("type a reply on the new thread", async () => {
    await expect(replyBox(a.page)).toBeVisible();
    await replyBox(a.page).fill(text);
  });
  const [thread] = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, host);
  const captured = await a.ui.captureReply();
  ui.flowCheck(
    "G1",
    "reply typed: the page keeps the text with its thread",
    captured.text === text && captured.target.threadId === thread?.id && captured.target.target === CHECKOUT.target,
    { captured, threadId: thread?.id ?? null },
  );
  /** Back on the diagram: the thread opens by itself with the reply in its box (bounded wait), said as restored. */
  const back = async (p, u, boundary) => {
    await within(
      p,
      async () =>
        (await replyBox(p).count()) > 0 &&
        (await replyBox(p)
          .inputValue()
          .catch(() => "")) !== "",
    );
    const readBack = await u.captureReply();
    const diffs = compareState(captured, readBack, ["text", "target"]);
    ui.flowCheck("G1", `reply: ${boundary}`, diffs.length === 0, {
      captured,
      readBack,
      diffs,
      problems: diffs.map((d) => `${d.field} differs`),
    });
    ui.flowCheck(
      "G4",
      `reply: ${boundary}: the restored reply says so`,
      (await p.getByText(REPLY_RESTORED).count()) > 0,
      {},
    );
  };

  await step("reply: reload (F5)", () => a.page.reload());
  await back(a.page, a.ui, "reload");

  const session = await sessionOf(a.page);

  const address = a.page.url();
  await step("reply: close the tab", () => a.page.close({ runBeforeUnload: false }));
  const b = await reopenTab(ui, session);
  await step("reply: reopen the closed tab", () => b.page.goto(address));
  await back(b.page, b.ui, "close the tab and reopen it");

  await b.ui.openDiagram(CHECKOUT.slug, "diagrams/containers.mmd");
  await b.page.waitForTimeout(800);
  const elsewhere =
    (await replyBox(b.page).count()) > 0
      ? await replyBox(b.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "reply: another diagram: the reply does not appear there",
    elsewhere !== text && (await b.page.getByText(REPLY_RESTORED).count()) === 0,
    { elsewhere },
  );
  await b.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await back(b.page, b.ui, "leave the diagram and come back");

  // Escape closes the discussion; the thread's pin opens it again with the reply.
  await step("reply: press Escape", async () => {
    await replyBox(b.page).press("Escape");
    await b.page.keyboard.press("Escape");
    await expect(replyBox(b.page)).toHaveCount(0);
  });
  await step("reply: open the thread from its pin", async () => {
    await b.page.locator(`[data-pin-thread="${thread?.id}"]`).first().click();
    await expect(replyBox(b.page)).toBeVisible();
  });
  const afterEscape = await b.ui.captureReply();
  const escDiffs = compareState(captured, afterEscape, ["text", "target"]);
  ui.flowCheck("G1", "reply: Escape, then the thread's pin", escDiffs.length === 0, {
    readBack: afterEscape,
    diffs: escDiffs,
    problems: escDiffs.map((d) => `${d.field} differs`),
  });

  // Discard: explicit, nothing kept or offered back.
  await step("reply: click Discard it", () => b.page.getByRole("button", { name: "Discard it", exact: true }).click());
  await b.page.reload();
  await b.page.waitForTimeout(1500);
  const kept = (await b.ui.storedComments()).filter((d) => d.body === text);
  const reoffered =
    (await replyBox(b.page).count()) > 0
      ? await replyBox(b.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "reply: discard: explicit, the draft gone and not offered back",
    kept.length === 0 && reoffered !== text,
    { kept: kept.length, reoffered },
  );

  // Sent: on the thread once, and no longer kept.
  const sent = `${text} sent`;
  await step("reply: open the thread, type and send a reply", async () => {
    await b.page.locator(`[data-pin-thread="${thread?.id}"]`).first().click();
    await replyBox(b.page).fill(sent);
    await b.page
      .getByRole("region", { name: "Contextual discussion", exact: true })
      .getByRole("button", { name: "Reply", exact: true })
      .click();
  });
  const on = await within(b.page, async () => {
    const t = (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, host))[0];
    return t?.comments.some((c) => c.body === sent) ? t : null;
  });
  await b.page.waitForTimeout(300);
  const left = (await b.ui.storedComments()).filter((d) => d.threadId !== null);
  ui.flowCheck(
    "G1",
    "reply: a sent reply is on its thread once and no longer kept",
    (on?.comments ?? []).filter((c) => c.body === sent).length === 1 && left.length === 0,
    { onThread: (on?.comments ?? []).filter((c) => c.body === sent).length, keptReplies: left.length },
  );
  await b.page.close({ runBeforeUnload: false });
}

/** The edit half of J9c (O111): a thread of the person's, its comment edited, each boundary read back. */
async function editBoundaries({ ui, step, expect }) {
  const stamp = Date.now().toString(36);
  const host = `J9c edit host ${stamp}`,
    text = `J9c edited, unsaved ${stamp}`,
    other = `J9c changed on another device ${stamp}`;
  const region = (p) => p.getByRole("region", { name: "Contextual discussion", exact: true });
  const editBox = (p) => p.getByRole("textbox", { name: "Edit your comment", exact: true }).first();
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step, expect }, host);
  await addComment({ page: a.page, step });
  const thread = await within(
    a.page,
    async () => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, host))[0] ?? null,
  );
  const comment = thread?.comments?.find((c) => c.body === host);
  const bodyNow = async () =>
    (await ui.threads(CHECKOUT.slug, CHECKOUT.target))
      .find((t) => t.id === thread?.id)
      ?.comments?.find((c) => c.id === comment?.id)?.body ?? null;
  await step("edit: click Edit on the comment", async () => {
    await region(a.page).getByRole("button", { name: "Edit", exact: true }).first().click();
    await expect(editBox(a.page)).toBeVisible();
  });
  await step("edit: type the change", () => editBox(a.page).fill(text));
  const captured = await a.ui.captureEdit();
  ui.flowCheck(
    "G1",
    "edit typed: the page keeps the text with its thread, comment and the text it began from",
    captured.text === text &&
      captured.target.threadId === thread?.id &&
      captured.target.commentId === comment?.id &&
      captured.target.target === CHECKOUT.target &&
      captured.base === host,
    { captured, threadId: thread?.id ?? null, commentId: comment?.id ?? null },
  );
  /**
   * The edit box back with the person's text (bounded wait): read back against what was captured. An edit box opens
   * on the comment's own words and takes the kept edit over once the other tabs have answered (draft-tabs.ts, 150 ms),
   * so a box that holds the comment's text, as it reads now or before, is not yet a read-back (O113).
   */
  const untouched = new Set([host, other]);
  const readBack = async (p, u, boundary, { restored = true } = {}) => {
    await within(
      p,
      async () =>
        (await editBox(p).count()) > 0 &&
        !untouched.has(
          await editBox(p)
            .inputValue()
            .catch(() => host),
        ) &&
        (await editBox(p)
          .inputValue()
          .catch(() => "")) !== "",
    );
    const got = await u.captureEdit();
    const diffs = compareState(captured, got, ["text", "target", "base"]);
    ui.flowCheck("G1", `edit: ${boundary}`, diffs.length === 0, {
      captured,
      readBack: got,
      diffs,
      problems: diffs.map((d) => `${d.field} differs`),
    });
    if (restored)
      ui.flowCheck(
        "G4",
        `edit: ${boundary}: the restored edit says so`,
        (await p.getByText(EDIT_RESTORED).count()) > 0,
        {},
      );
    return got;
  };

  await step("edit: reload (F5)", () => a.page.reload());
  await readBack(a.page, a.ui, "reload");
  const session = await sessionOf(a.page);
  const address = a.page.url();
  await step("edit: close the tab", () => a.page.close({ runBeforeUnload: false }));
  const b = await reopenTab(ui, session);
  await step("edit: reopen the closed tab", () => b.page.goto(address));
  await readBack(b.page, b.ui, "close the tab and reopen it");
  await step("edit: press Escape", async () => {
    await editBox(b.page).press("Escape");
    await expect(editBox(b.page)).toHaveCount(0);
  });
  // claude-309: closing the editor with text kept says so, under the comment.
  const keptSaid = region(b.page)
    .getByText(/Your unsaved edit of this comment is kept in this browser/)
    .first();
  ui.flowCheck("G4", "edit: Escape says the unsaved edit is kept", await keptSaid.isVisible().catch(() => false), {
    said: await keptSaid.textContent({ timeout: 500 }).catch(() => null),
  });
  await step("edit: press Escape again", async () => {
    await b.page.keyboard.press("Escape");
    await expect(editBox(b.page)).toHaveCount(0);
  });
  await step("edit: open the thread from its pin", async () => {
    await b.page.locator(`[data-pin-thread="${thread?.id}"]`).first().click();
    await expect(editBox(b.page)).toBeVisible();
  });
  await readBack(b.page, b.ui, "Escape, then the thread's pin");
  ui.flowCheck("G1", "edit: nothing is saved by crossing the boundaries", (await bodyNow()) === host, {
    onService: await bodyNow(),
  });

  // Another device (a fresh profile) edits the same comment and saves it while this tab still holds its change.
  const c = await ui.openContext({ fresh: true });
  await c.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await step("other device: open the thread, edit and save", async () => {
    await c.page.locator(`[data-pin-thread="${thread?.id}"]`).first().click();
    await region(c.page).getByRole("button", { name: "Edit", exact: true }).first().click();
    await editBox(c.page).fill(other);
    await region(c.page).getByRole("button", { name: "Save", exact: true }).click();
  });
  const landed = await within(c.page, async () => (await bodyNow()) === other);
  await c.page.close({ runBeforeUnload: false });
  /** The change made elsewhere is said, visibly, and only "Save over it" would write the person's text. */
  const changedSaid = async (p) => {
    const note = p.getByText(EDIT_CHANGED).first();
    const visible = (await note.count()) > 0 && (await note.isVisible().catch(() => false));
    const names = (await note.textContent().catch(() => "")) ?? "";
    const overIt = (await region(p).getByRole("button", { name: "Save over it", exact: true }).count()) > 0;
    return {
      ok: visible && names.includes(other) && overIt,
      visible,
      namesTheChange: names.includes(other),
      saveOverIt: overIt,
    };
  };
  for (const [boundary, reload] of [
    ["changed meanwhile, tab open", false],
    ["changed meanwhile, then reload", true],
  ]) {
    if (reload) await step("edit: reload after the other change", () => b.page.reload());
    await within(b.page, async () => (await changedSaid(b.page)).ok, { timeout: 5000 });
    await readBack(b.page, b.ui, boundary, { restored: reload });
    const said = await changedSaid(b.page);
    ui.flowCheck(
      "G4",
      `edit: ${boundary}: said, with what the comment reads now, and Save says it replaces it`,
      landed && said.ok,
      { landed, ...said },
    );
  }
  ui.flowCheck(
    "G1",
    "edit: changed meanwhile: the other change is not written over before the person chooses",
    (await bodyNow()) === other,
    { onService: await bodyNow() },
  );
  // Save over it with its answer lost after commit (codex-303, O115): the page reads the comment back.
  const revisionOf = async () =>
    (await ui.threads(CHECKOUT.slug, CHECKOUT.target)).find((t) => t.id === thread?.id)?.revision ?? null;
  const said = async (p) =>
    (
      await p.evaluate(() =>
        [...document.querySelectorAll('[role="alert"], .archer-review-announcer')]
          .map((el) => el.textContent ?? "")
          .join(" | "),
      )
    )
      .replace(/\s+/g, " ")
      .trim();
  /** After a Save whose answer was lost: the editor closed on the person's text, nothing false said, edited once. */
  const lostSave = async (p, boundary, want, revisionBefore, drop) => {
    await within(p, () => drop.drops.length > 0, { timeout: 5000 });
    const closed = await within(p, async () => (await editBox(p).count()) === 0, { timeout: 5000 }).catch(() => false);
    const words = await said(p);
    const shown = (await region(p).getByText(want, { exact: true }).count()) > 0;
    const revisionAfter = await revisionOf();
    ui.flowCheck(
      "G4",
      `edit: ${boundary}, its answer lost: the final status is true (saved), not "Could not save"`,
      drop.drops[0]?.status === 200 &&
        Boolean(closed) &&
        shown &&
        !/could not save|failed to fetch/i.test(words) &&
        (await bodyNow()) === want,
      {
        droppedStatus: drop.drops[0]?.status ?? null,
        closed: Boolean(closed),
        shown,
        said: words.slice(0, 300),
        onService: await bodyNow(),
      },
    );
    ui.flowCheck(
      "G5",
      `edit: ${boundary}, its answer lost: edited once`,
      revisionBefore !== null && revisionAfter === revisionBefore + 1,
      { revisionBefore, revisionAfter },
    );
    await drop.off();
  };
  const r0 = await revisionOf();
  const overDrop = await b.ui.dropResponseAfterCommit("**/api/comments/*/*", { method: "PATCH" });
  await step("edit: click Save over it (answer lost)", () =>
    region(b.page)
      .getByRole("button", { name: /^Save( over it)?$/ })
      .first()
      .click(),
  );
  const saved = await within(b.page, async () => (await bodyNow()) === text);
  await lostSave(b.page, "Save over it", text, r0, overDrop);
  await b.page.waitForTimeout(300);
  const leftAfterSave = (await b.ui.storedComments()).filter((d) => d.kind === "edit");
  ui.flowCheck(
    "G1",
    "edit: Save over it writes the person's text, and nothing is kept after",
    saved && leftAfterSave.length === 0,
    { onService: await bodyNow(), keptEdits: leftAfterSave.length },
  );

  // An ordinary Save with its answer lost.
  const plain = `${text} again`;
  await step("edit: click Edit, type a change", async () => {
    await region(b.page).getByRole("button", { name: "Edit", exact: true }).first().click();
    await editBox(b.page).fill(plain);
  });
  const r1 = await revisionOf();
  const plainDrop = await b.ui.dropResponseAfterCommit("**/api/comments/*/*", { method: "PATCH" });
  await step("edit: click Save (answer lost)", () =>
    region(b.page).getByRole("button", { name: "Save", exact: true }).first().click(),
  );
  await lostSave(b.page, "Save", plain, r1, plainDrop);

  // A Save that meets a change this page has not seen yet (O124): another device's edit lands while the Save is on its
  // way, so only the revision the edit names stands between the person's text and that change. Refused: the other
  // change is not written over, and the editor shows what the comment reads with "Save over it", which then saves.
  const unseen = `${plain}, saved over a change it had not seen`;
  const elsewhere = `${other}, changed again before the page heard`;
  await step("edit: click Edit, type a change (another device's change on its way)", async () => {
    await region(b.page).getByRole("button", { name: "Edit", exact: true }).first().click();
    await editBox(b.page).fill(unseen);
  });
  let interposed = false;
  const interpose = async (route) => {
    const req = route.request();
    if (req.method() !== "PATCH" || interposed) return route.fallback();
    interposed = true;
    // The other device's edit, sent as an older page sends it (no expected revision), lands first.
    await b.page.request.fetch(req.url(), {
      method: "PATCH",
      headers: { origin: new URL(req.url()).origin, "content-type": "application/json" },
      data: JSON.stringify({ body: elsewhere }),
    });
    return route.fallback();
  };
  await b.page.route("**/api/comments/*/*", interpose);
  await step(
    "edit: click Save (a change it has not seen lands first)",
    () => region(b.page).getByRole("button", { name: "Save", exact: true }).first().click(),
    {
      expects: [
        { kind: "http", status: 409 },
        { kind: "alert", text: "changed elsewhere" },
      ],
    },
  ); // the conflict this part seeds (errors.mjs)
  const overItNow = async () => {
    const note = b.page.getByText(EDIT_CHANGED).first();
    const names = (await note.count()) > 0 ? ((await note.textContent().catch(() => "")) ?? "") : "";
    return (
      names.includes(elsewhere) &&
      (await region(b.page).getByRole("button", { name: "Save over it", exact: true }).count()) > 0
    );
  };
  await within(b.page, async () => interposed && ((await overItNow()) || (await bodyNow()) === unseen), {
    timeout: 5000,
  });
  await b.page.unroute("**/api/comments/*/*", interpose);
  const unseenBody = await bodyNow(),
    offeredOver = await overItNow();
  ui.flowCheck(
    "G2",
    "edit: a change the page had not seen: refused, not written over, and Save over it offered with what it reads",
    interposed &&
      unseenBody === elsewhere &&
      offeredOver &&
      (await editBox(b.page)
        .inputValue()
        .catch(() => "")) === unseen,
    { interposed, onService: unseenBody, saveOverIt: offeredOver },
  );
  if (offeredOver)
    await step("edit: click Save over it (the change it had not seen)", () =>
      region(b.page).getByRole("button", { name: "Save over it", exact: true }).first().click(),
    );
  const overSaved = await within(b.page, async () => (await bodyNow()) === unseen, { timeout: 5000 }).catch(
    () => false,
  );
  ui.flowCheck(
    "G1",
    "edit: a change the page had not seen: Save over it then writes the person's text",
    Boolean(overSaved),
    { onService: await bodyNow() },
  );
  const finalText = await bodyNow();

  // Discard: explicit; nothing kept or offered back, and the comment reads as saved.
  const dropped = `${finalText} then discarded`;
  await step("edit: click Edit, type, reload", async () => {
    await region(b.page).getByRole("button", { name: "Edit", exact: true }).first().click();
    await editBox(b.page).fill(dropped);
    await b.page.reload();
    await within(b.page, async () => (await editBox(b.page).count()) > 0);
  });
  await step("edit: click Discard it", () =>
    region(b.page).getByRole("button", { name: "Discard it", exact: true }).click(),
  );
  await b.page.reload();
  await b.page.waitForTimeout(1500);
  const kept = (await b.ui.storedComments()).filter((d) => d.kind === "edit");
  const reoffered =
    (await editBox(b.page).count()) > 0
      ? await editBox(b.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "edit: discard: explicit, the edit gone and not offered back, the comment unchanged",
    kept.length === 0 && reoffered !== dropped && (await bodyNow()) === finalText,
    { kept: kept.length, reoffered, onService: await bodyNow() },
  );
  await b.page.close({ runBeforeUnload: false });
}

/**
 * Two tabs (claude-201, O103), as probes: tab A types a comment on Customer; tab B opens checkout. B is not given A's
 * live text (it is told a comment is being written in another tab) and types its own; A adds its comment; B reloads
 * and gets its own text back; B adds it. Each text is stored once. The seeded fault `ignore-open-tabs` (B cannot
 * see A is open, so it takes A's draft as its own) is the first check's known fail.
 */
async function twoTabs({ ui, step, expect }) {
  const stamp = Date.now().toString(36),
    textA = `J9c tab A ${stamp}`,
    textB = `J9c tab B ${stamp}`;
  const box = (p) => p.getByRole("textbox", { name: "Comment", exact: true });
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step, expect }, textA);
  const b = await ui.openContext();
  await b.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  // B's composer opens by itself on the participant A writes about; give it the channel's wait to decide.
  await within(b.page, async () => (await box(b.page).count()) > 0, { timeout: 5000 });
  await within(
    b.page,
    async () =>
      (await b.page.getByText(ELSEWHERE).count()) > 0 ||
      (await box(b.page)
        .inputValue()
        .catch(() => "")) !== "",
    { timeout: 3000 },
  );
  const inB =
    (await box(b.page).count()) > 0
      ? await box(b.page)
          .inputValue()
          .catch(() => "")
      : "";
  const told = (await b.page.getByText(ELSEWHERE).count()) > 0;
  ui.flowCheck(
    "G1",
    "two tabs: the second tab is not given the first tab's live text, and is told where it is",
    inB !== textA && told,
    { inSecondTab: inB, told },
  );
  await step("tab B: type its own comment", () => box(b.page).fill(textB));
  await addComment({ page: a.page, step }, "tab A: click Add comment");
  await within(a.page, async () => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, textA)).length > 0, {
    timeout: 5000,
  });
  await step("tab B: reload", () => b.page.reload());
  await within(
    b.page,
    async () =>
      (await box(b.page).count()) > 0 &&
      (await box(b.page)
        .inputValue()
        .catch(() => "")) !== "",
    { timeout: 5000 },
  );
  const afterReload =
    (await box(b.page).count()) > 0
      ? await box(b.page)
          .inputValue()
          .catch(() => "")
      : null;
  ui.flowCheck(
    "G1",
    "two tabs: the first tab's Add comment leaves the second tab's text, and its reload gives it back",
    afterReload === textB,
    { afterReload },
  );
  await addComment({ page: b.page, step }, "tab B: click Add comment");
  await within(b.page, async () => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, textB)).length > 0, {
    timeout: 5000,
  });
  await b.page.waitForTimeout(300);
  const nA = (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, textA)).length,
    nB = (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, textB)).length;
  ui.flowCheck("G5", "two tabs: each tab's text is stored once", nA === 1 && nB === 1, { tabA: nA, tabB: nB });
  await a.page.close({ runBeforeUnload: false });
  await b.page.close({ runBeforeUnload: false });
}

/**
 * A duplicated tab and a busy tab (claude-301, -302, O117), as probes. Tab A types a comment on Customer, then is
 * duplicated (window.open copies its session, and with it its owner id): the duplicate is not given A's live text and
 * is told it is written in another tab; A adds it, and it is stored once. Then A types again and is busy for 3 s (a
 * long task) while a new tab opens: A is still open, so the new tab is told so, and neither offered nor given A's text.
 * Seeded faults: `shared-owner-id` (the duplicate keeps A's id) fails the first check; `threshold-takeover` (a tab
 * counts as open only if it answers within 150 ms) fails the busy check.
 */
async function duplicateAndBusy({ ui, step, expect }) {
  const stamp = Date.now().toString(36),
    text = `J9c duplicated ${stamp}`,
    busyText = `J9c busy ${stamp}`;
  const box = (p) => p.getByRole("textbox", { name: "Comment", exact: true });
  const told = async (p) => (await p.getByText(ELSEWHERE).count()) > 0;
  const offered = async (p) => (await p.getByRole("button", { name: "Use it here", exact: true }).count()) > 0;
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step, expect }, text);
  const d = await ui.duplicateTab(a.page);
  await within(d.page, async () => (await box(d.page).count()) > 0, { timeout: 10_000 });
  await within(
    d.page,
    async () =>
      (await told(d.page)) ||
      (await box(d.page)
        .inputValue()
        .catch(() => "")) !== "",
    { timeout: 5000 },
  );
  const inD =
    (await box(d.page).count()) > 0
      ? await box(d.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "duplicated tab: not given the first tab's live text, and told it is written in another tab",
    inD !== text && (await told(d.page)) && !(await offered(d.page)),
    { inDuplicate: inD, told: await told(d.page), offered: await offered(d.page) },
  );
  await addComment({ page: a.page, step }, "tab A: click Add comment");
  if (inD.trim() !== "") await addComment({ page: d.page, step }, "duplicated tab: click Add comment");
  await within(a.page, async () => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).length > 0, {
    timeout: 5000,
  });
  await a.page.waitForTimeout(500);
  const n = (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, text)).length;
  ui.flowCheck("G5", "duplicated tab: the comment is stored once", n === 1, { stored: n });
  await d.page.close({ runBeforeUnload: false });

  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await composeComment({ page: a.page, step, expect }, busyText);
  const busy = a.page
    .evaluate(() => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        /* a long task */
      }
    })
    .catch(() => {});
  const c = await ui.openContext();
  await c.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await within(c.page, async () => (await box(c.page).count()) > 0, { timeout: 10_000 });
  await within(
    c.page,
    async () =>
      (await told(c.page)) ||
      (await offered(c.page)) ||
      (await box(c.page)
        .inputValue()
        .catch(() => "")) !== "",
    { timeout: 5000 },
  );
  const inC =
    (await box(c.page).count()) > 0
      ? await box(c.page)
          .inputValue()
          .catch(() => "")
      : "";
  ui.flowCheck(
    "G1",
    "busy tab: a tab busy for seconds is still open: a new tab is told, not offered or given its text",
    inC !== busyText && (await told(c.page)) && !(await offered(c.page)),
    { inNewTab: inC, told: await told(c.page), offered: await offered(c.page) },
  );
  await busy;
  await c.page.close({ runBeforeUnload: false });
  await a.page.close({ runBeforeUnload: false });
}
