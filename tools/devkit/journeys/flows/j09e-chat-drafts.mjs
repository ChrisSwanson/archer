// J9e interrupted chat message (codex-201, O101; user-flows.md §3 G1, §6 promise list): J9c's boundaries for the
// chat bubble's box, a separate surface from the node comments J9c covers. Not a §6 journey of its own, pending the
// next freeze: J8's "comment being composed" start state, written in the project conversation's chat.
//
// `checkout`: the chat bubble → type. Then, each a G1 boundary read back from the page and the draft it keeps (the
// text in the box, and the chat draft's target, conversation anchor and thread):
//   reload · close the tab and reopen its address in the same profile · Escape and reopen the bubble ·
//   leave for another project's diagram (where it must not appear) and come back
// and: Discard is explicit and leaves nothing behind. As probes outside the pinned trace: a reply being written on the
// conversation's thread gets the reload boundary and names its thread; a second open tab is not given this tab's
// live text and says it is being written elsewhere (claude-201, O103); a browser that refuses storage says so.
// Mandatory outcome: the person gets their text back, in that conversation, said as restored, and sends it once.
import { assertFlowChecks, compareState } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { CHECKOUT, DISCONNECT_INVARIANTS, within, reopenTab, sessionOf } from "./state-lib.mjs";
import { chatBox, chatButton, openChat, sendChat } from "./chat-lib.mjs";

const RESTORED = /Restored your unsent message/;
const UNKEPT = /cannot keep this message if you reload or close/i;
const ELSEWHERE = /being written in another tab/i;
const OTHER = { slug: "journeys", path: "diagrams/flow.mmd" };

export const meta = {
  name: "flows-j09e-chat-drafts",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J9e",
    baseline: [
      { action: "click the chat bubble", class: "essential" },
      { action: "type the message", class: "essential" },
      { action: "reload (F5)", class: "essential" },
      { action: "click the chat bubble (after the reload)", class: "essential" },
      { action: "close the tab (Ctrl+W)", class: "essential" },
      { action: "reopen the closed tab (Ctrl+Shift+T)", class: "essential" },
      { action: "click the chat bubble (reopened tab)", class: "essential" },
      { action: "press Escape", class: "essential" },
      { action: "click the chat bubble (after Escape)", class: "essential" },
      { action: "click Discard it", class: "essential" },
    ],
  },
};

export default async ({ ui, step, expect, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  const act = flow.stepFor(meta.flow.baseline);
  await ui.resetProject(CHECKOUT.slug);
  // The other project's diagram as the corpus has it: J9d, before, leaves journeys/diagrams/flow.mmd deleted or moved.
  await ui.resetProject(OTHER.slug);
  const text = `J9e unsent chat ${Date.now().toString(36)}`;
  const a = await ui.openContext();
  await a.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await act("click the chat bubble", () => openChat({ page: a.page, expect }));
  await act("type the message", () => chatBox(a.page).fill(text));
  const captured = await a.ui.captureChat();
  ui.flowCheck(
    "G1",
    "chat typed: the page keeps the text with its conversation",
    captured.text === text &&
      captured.target.target === CHECKOUT.target &&
      captured.target.anchorId === "view" &&
      captured.target.threadId === null,
    { captured },
  );

  /** The bubble opened again: the text is back (bounded wait), in this conversation, said as restored. */
  const back = async (p, u, boundary, { restored = true } = {}) => {
    await within(
      p,
      async () =>
        (await chatBox(p).count()) > 0 &&
        (await chatBox(p)
          .inputValue()
          .catch(() => "")) !== "",
    );
    const readBack = await u.captureChat();
    const diffs = compareState(captured, readBack, ["text", "target"]);
    ui.flowCheck("G1", `chat: ${boundary}`, diffs.length === 0, {
      captured,
      readBack,
      diffs,
      problems: diffs.map((d) => `${d.field} differs`),
    });
    if (restored)
      ui.flowCheck(
        "G4",
        `chat: ${boundary}: the restored message says so`,
        (await p.getByText(RESTORED).count()) > 0,
        {},
      );
  };

  await act("reload (F5)", () => a.page.reload());
  await act("click the chat bubble (after the reload)", () => openChat({ page: a.page, expect }));
  await back(a.page, a.ui, "reload");

  const session = await sessionOf(a.page);

  const address = a.page.url();
  await act("close the tab (Ctrl+W)", () => a.page.close({ runBeforeUnload: false }));
  const b = await reopenTab(ui, session);
  await act("reopen the closed tab (Ctrl+Shift+T)", () => b.page.goto(address));
  await act("click the chat bubble (reopened tab)", () => openChat({ page: b.page, expect }));
  await back(b.page, b.ui, "close the tab and reopen it");

  await act("press Escape", async () => {
    await chatBox(b.page).press("Escape");
    await expect(chatBox(b.page)).toHaveCount(0);
  });
  await act("click the chat bubble (after Escape)", () => openChat({ page: b.page, expect }));
  await back(b.page, b.ui, "Escape, then the bubble again", { restored: false });

  // Leave for another project's diagram: the text is this project's conversation's, and never shows there.
  await b.ui.openDiagram(OTHER.slug, OTHER.path);
  await step("open the chat on another project's diagram", () => openChat({ page: b.page, expect }));
  await b.page.waitForTimeout(500);
  const elsewhereText = await chatBox(b.page)
    .inputValue()
    .catch(() => "");
  ui.flowCheck(
    "G1",
    "chat: another project: the message does not appear there",
    elsewhereText !== text && (await b.page.getByText(RESTORED).count()) === 0,
    { elsewhere: elsewhereText },
  );
  await b.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await step("open the chat back on its diagram", () => openChat({ page: b.page, expect }));
  await back(b.page, b.ui, "leave for another project and come back");

  // A second open tab (claude-201): not given this tab's live text, and told it is being written elsewhere.
  const c = await ui.openContext();
  await c.ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  await step("second tab: open the chat", () => openChat({ page: c.page, expect }));
  await within(c.page, async () => (await c.page.getByText(ELSEWHERE).count()) > 0, { timeout: 3000 });
  const inC = await chatBox(c.page)
    .inputValue()
    .catch(() => "");
  ui.flowCheck(
    "G1",
    "chat: a second open tab is not given the first tab's text, and is told where it is",
    inC !== text && (await c.page.getByText(ELSEWHERE).count()) > 0,
    { inSecondTab: inC, toldElsewhere: (await c.page.getByText(ELSEWHERE).count()) > 0 },
  );
  await c.page.close({ runBeforeUnload: false });

  // A duplicated tab (claude-301, O117): window.open copies the session, and with it the owner id. It is not given the
  // first tab's live message and is told where it is. The seeded fault `shared-owner-id` fails this check.
  const dup = await ui.duplicateTab(b.page);
  await within(dup.page, async () => (await chatButton(dup.page).count()) > 0, { timeout: 10_000 });
  await step("duplicated tab: open the chat", () => openChat({ page: dup.page, expect }));
  await within(
    dup.page,
    async () =>
      (await dup.page.getByText(ELSEWHERE).count()) > 0 ||
      (await chatBox(dup.page)
        .inputValue()
        .catch(() => "")) !== "",
    { timeout: 5000 },
  );
  const inDup = await chatBox(dup.page)
    .inputValue()
    .catch(() => "");
  const offeredDup = (await dup.page.getByRole("button", { name: "Use it here", exact: true }).count()) > 0;
  ui.flowCheck(
    "G1",
    "chat: a duplicated tab is not given the first tab's text, and is told where it is",
    inDup !== text && !offeredDup && (await dup.page.getByText(ELSEWHERE).count()) > 0,
    { inDuplicate: inDup, offered: offeredDup, toldElsewhere: (await dup.page.getByText(ELSEWHERE).count()) > 0 },
  );
  await dup.page.close({ runBeforeUnload: false });

  // Discard: explicit, and nothing is kept or offered back afterwards.
  await act("click Discard it", () => b.page.getByRole("button", { name: "Discard it", exact: true }).click());
  await b.page.reload();
  await step("open the chat after Discard and a reload", () => openChat({ page: b.page, expect }));
  await b.page.waitForTimeout(500);
  const kept = (await b.ui.storedComments()).filter((d) => d.kind === "chat" && d.body === text);
  const reoffered = await chatBox(b.page)
    .inputValue()
    .catch(() => "");
  ui.flowCheck(
    "G1",
    "chat: discard: explicit, the draft gone and not offered back",
    kept.length === 0 && reoffered !== text,
    { kept: kept.length, reoffered },
  );

  // A reply being written in the chat (the conversation has a thread now): reload, and it names its thread.
  const first = `${text} sent`,
    reply = `${text} reply`;
  await step("send a first message", async () => {
    await chatBox(b.page).fill(first);
    await sendChat(b.page);
  });
  const thread = await within(
    b.page,
    async () => (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, first))[0] ?? null,
  );
  await step("type a reply in the chat", () => chatBox(b.page).fill(reply));
  const replyCaptured = await b.ui.captureChat();
  ui.flowCheck(
    "G1",
    "chat reply typed: kept with its thread",
    replyCaptured.text === reply && replyCaptured.target.threadId === (thread?.id ?? "?"),
    { captured: replyCaptured, threadId: thread?.id ?? null },
  );
  await b.page.reload();
  await step("open the chat after a reload (reply)", () => openChat({ page: b.page, expect }));
  await within(
    b.page,
    async () =>
      (await chatBox(b.page)
        .inputValue()
        .catch(() => "")) !== "",
  );
  const replyBack = await b.ui.captureChat();
  const rd = compareState(replyCaptured, replyBack, ["text", "target"]);
  ui.flowCheck("G1", "chat reply: reload", rd.length === 0, {
    captured: replyCaptured,
    readBack: replyBack,
    diffs: rd,
    problems: rd.map((d) => `${d.field} differs`),
  });
  ui.flowCheck(
    "G4",
    "chat reply: reload: the restored message says so",
    (await b.page.getByText(RESTORED).count()) > 0,
    {},
  );
  await step("send the reply", () => sendChat(b.page));
  const on = await within(b.page, async () => {
    const t = (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, first))[0];
    return t?.comments.some((x) => x.body === reply) ? t : null;
  });
  await b.page.waitForTimeout(300);
  const left = (await b.ui.storedComments()).filter((d) => d.kind === "chat" && d.body === reply);
  ui.flowCheck(
    "G5",
    "chat reply: sent once and no longer kept",
    (on?.comments ?? []).filter((x) => x.body === reply).length === 1 && left.length === 0,
    { onThread: (on?.comments ?? []).filter((x) => x.body === reply).length, kept: left.length },
  );
  await b.page.close({ runBeforeUnload: false });

  // §6 "storage denied or full (the page must say so)".
  const e = await ui.openContext({ fresh: true });
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
  await step(
    "storage denied: open the chat and type",
    async () => {
      await chatButton(e.page).click();
      await chatBox(e.page).fill("Unkept chat");
    },
    { expects: [{ kind: "alert", text: "cannot keep this message" }] },
  ); // the storage this part denies, said by the page (errors.mjs)
  ui.flowCheck(
    "G1",
    "chat: storage denied: the page says the message cannot be kept, before the person relies on it",
    (await e.page.getByText(UNKEPT).count()) > 0,
    { alerts: await e.ui.alerts() },
  );
  await e.page.close({ runBeforeUnload: false });
  await assertFlowChecks({ step, run, flow });
};
