// J8e response lost after commit, in the chat bubble (codex-202, O100; user-flows.md §3 G5): J8d's boundary for the
// project conversation's chat, which sends its own create, reply and submit. Every try's answer is dropped after it
// commits (ui.dropResponseAfterCommit, times 3: the page's first try and its two resends), so the page is left not
// knowing. G5: exactly one durable effect when the person presses Send again; the final status true (uncertain while
// unknown, then sent; never "Not saved" or "Not sent" over a committed write); the exact first request resent before
// and after a real restart is answered from its receipt. Effects are counted from the service's threads.
//
//   create   a new conversation's first message, its answers lost; Send again.
//   reply    a message on the conversation's thread, its answers lost; Send again.
//   submit   (queued) a message whose submit answers are lost: the page reads back that it was sent.
//   reload   (probe, claude-202) the project conversation's first message, its answers lost; the page reloads; the
//            restored message says it may already have been sent; Send: still one.
// The seeded fault `fresh-operation-identity` (the person's Send again goes out as a new operation) fails the create
// and reply checks; `forget-operation-hold` fails the reload check; `false-chat-status` (the status line says "Not
// sent") fails the submit status check.
import { assertFlowChecks, g5Verdict } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { CHECKOUT, DISCONNECT_INVARIANTS, submissionMode, within } from "./state-lib.mjs";
import { chatBox, chatSays, chatStatus, openChat, sendChat, toProject } from "./chat-lib.mjs";

const BASE = [
  { action: "click the chat bubble", class: "essential" },
  { action: "type the message", class: "essential" },
  { action: "click Send (every answer lost)", class: "essential" },
  { action: "click Send again", class: "essential" },
  { action: "type the reply", class: "essential" },
  { action: "click Send (reply, every answer lost)", class: "essential" },
  { action: "click Send again (reply)", class: "essential" },
];
const QUEUED = [
  ...BASE,
  { action: "type the next message", class: "essential" },
  { action: "click Send (submit, every answer lost)", class: "essential" },
];

export const meta = {
  name: "flows-j08e-chat-lost-response",
  invariants: { ...DISCONNECT_INVARIANTS, "editor-alert": false },
  flow: {
    id: "J8e",
    baseline: BASE,
    baselines: { immediate: BASE, queued: QUEUED },
    matrix: { commentSubmission: ["immediate", "queued"] },
  },
};

const UNCERTAIN = /may have been sent or not/i;
const FALSE_FAILURE = /Not saved|Not sent/;

export default async ({ ui, step, expect, page, sandbox, run }) => {
  const queued = submissionMode(sandbox) === "queued";
  const baseline = queued ? QUEUED : BASE;
  const flow = flowRecorder({ step, run }, { id: meta.flow.id, baseline });
  const act = flow.stepFor(baseline);
  const stamp = Date.now().toString(36);
  await ui.resetProject(CHECKOUT.slug);
  await ui.openDiagram(CHECKOUT.slug, CHECKOUT.path);
  const onThread = async (body) =>
    (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, body)).reduce(
      (n, t) => n + t.comments.filter((c) => c.body === body).length,
      0,
    );

  /** One lost write, then Send again: the claim while unknown, the effect count, the status after. */
  const lostThenAgain = async (part, body, pattern, { type, lost, again }) => {
    await act(type, () => chatBox(page).fill(body));
    const drop = await ui.dropResponseAfterCommit(pattern, { times: 3 });
    await act(lost, () => sendChat(page));
    await within(page, async () => drop.drops.length >= 3 || UNCERTAIN.test(await chatSays(page)), { timeout: 6000 });
    const said =
      (await within(
        page,
        async () => {
          const s = await chatSays(page);
          return UNCERTAIN.test(s) ? s : null;
        },
        { timeout: 4000 },
      )) ?? (await chatSays(page));
    await drop.off();
    const n1 = await onThread(body);
    ui.flowCheck("G5", `chat ${part} answer lost: the effect committed once`, n1 === 1, {
      effects: n1,
      expected: 1,
      droppedStatus: drop.drops.map((d) => d.status),
    });
    ui.flowCheck(
      "G4",
      `chat ${part} answer lost: the chat says it may have been sent, not that it failed`,
      UNCERTAIN.test(said) && !FALSE_FAILURE.test(said) && (await chatBox(page).inputValue()) === body,
      { said: said.slice(0, 300) },
    );
    await act(again, () => sendChat(page));
    await within(
      page,
      async () =>
        (await chatBox(page).inputValue()) === "" &&
        (await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, body)).some((t) => t.status === "sent"),
      { timeout: 6000 },
    );
    await page.waitForTimeout(500);
    const n2 = await onThread(body);
    const v = g5Verdict({ effects: n2, expected: 1, label: `chat ${part}: lost, then Send again` });
    ui.flowCheck("G5", `chat ${part} answer lost, Send again: the same operation, one effect`, v.ok, v);
    const status = await chatStatus(page),
      threads = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, body);
    ui.flowCheck(
      "G4",
      `chat ${part}, Send again: the final status is true`,
      threads.length >= 1 &&
        threads.every((t) => t.status === "sent") &&
        !FALSE_FAILURE.test(status) &&
        !/May not/.test(status),
      { status, statuses: threads.map((t) => t.status) },
    );
    return drop;
  };

  await act("click the chat bubble", () => openChat({ page, expect }));
  const created = `J8e chat lost create ${stamp}`;
  const createDrop = await lostThenAgain("create", created, "**/api/comments", {
    type: "type the message",
    lost: "click Send (every answer lost)",
    again: "click Send again",
  });
  const replied = `J8e chat lost reply ${stamp}`;
  const replyDrop = await lostThenAgain("reply", replied, "**/api/comments/*/replies", {
    type: "type the reply",
    lost: "click Send (reply, every answer lost)",
    again: "click Send again (reply)",
  });

  // Queued: the submit's answers are lost; the page reads back what Archer holds, so it says sent, truly.
  let submitDrop = null;
  const next = `J8e chat lost submit ${stamp}`;
  if (queued) {
    await act("type the next message", () => chatBox(page).fill(next));
    submitDrop = await ui.dropResponseAfterCommit("**/api/comments/submit", { times: 3 });
    await act("click Send (submit, every answer lost)", () => sendChat(page));
    await within(page, async () => submitDrop.drops.length >= 3, { timeout: 6000 });
    await page.waitForTimeout(1000); // the read-back after the last try
    await submitDrop.off();
    const said = await chatSays(page),
      threads = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, next);
    // True: sent (read back), or said as uncertain; never "Not sent" over a sent message.
    ui.flowCheck(
      "G4",
      "chat submit answer lost: the final status is true (sent, read back), not Not sent",
      threads.length === 1 && threads[0].status === "sent" && !FALSE_FAILURE.test(said),
      { said: said.slice(0, 300), statuses: threads.map((t) => t.status) },
    );
    ui.flowCheck("G5", "chat submit answer lost: the message is on its thread once", (await onThread(next)) === 1, {
      effects: await onThread(next),
    });
  }

  // The retry, really executed by the service: the exact first request of each, again, before and after a restart.
  const replay = async (when) => {
    for (const [part, drop, body] of [
      ["create", createDrop, created],
      ["reply", replyDrop, replied],
    ]) {
      const again = await ui.resendInPage(drop.drops[0]);
      const n = await onThread(body);
      ui.flowCheck(
        "G5",
        `chat ${part} answer lost, the same operation resent ${when}: answered from its receipt, one effect`,
        again.status === 200 && again.json?.replayed === true && n === 1,
        { status: again.status, replayed: again.json?.replayed ?? null, operation: again.operationId, effects: n },
      );
    }
    if (submitDrop !== null) {
      const again = await ui.resendInPage(submitDrop.drops[0]);
      const threads = await ui.threadsWith(CHECKOUT.slug, CHECKOUT.target, next);
      ui.flowCheck(
        "G5",
        `chat submit answer lost, the same submit resent ${when}: answered from its receipt, sent once`,
        again.status === 200 && again.json?.replayed === true && threads.length === 1 && threads[0].status === "sent",
        {
          status: again.status,
          replayed: again.json?.replayed ?? null,
          submitted: again.json?.submitted ?? null,
          statuses: threads.map((t) => t.status),
        },
      );
    }
  };
  await replay("before restart");
  await ui.restartService();
  await within(page, async () => (await ui.connection()) === null);
  await replay("after restart");

  // Lost, then the page reloads (claude-202): the project conversation's first message.
  const project = `J8e chat lost then reload ${stamp}`;
  await step("talk about the whole project", () => toProject(page));
  await step("type the project message", () => chatBox(page).fill(project));
  const lost = await ui.dropResponseAfterCommit("**/api/comments", { times: 3 });
  await step("click Send (project, every answer lost)", () => sendChat(page));
  await within(page, async () => UNCERTAIN.test(await chatSays(page)), { timeout: 6000 });
  await lost.off();
  await step("reload after the lost answer", () => page.reload());
  await step("open the chat after the reload", () => openChat({ page, expect }));
  await step("talk about the whole project (after the reload)", () => toProject(page));
  await within(
    page,
    async () =>
      (await chatBox(page)
        .inputValue()
        .catch(() => "")) === project,
  );
  const restoredSays = await chatSays(page);
  ui.flowCheck(
    "G4",
    "chat lost, then reload: the restored message says it may already have been sent",
    /may already have been sent/i.test(restoredSays) && !/Restored your unsent/i.test(restoredSays),
    { said: restoredSays.slice(0, 300) },
  );
  await step("click Send (after the reload)", () => sendChat(page));
  await within(
    page,
    async () => (await ui.threadsWith(CHECKOUT.slug, "project:", project)).some((t) => t.status === "sent"),
    { timeout: 6000 },
  );
  await page.waitForTimeout(500);
  const p = await ui.threadsWith(CHECKOUT.slug, "project:", project);
  // Counted as comments, not threads: a Send that forgot its identity replies to the thread the lost create made.
  const copies = p.reduce((n, t) => n + t.comments.filter((c) => c.body === project).length, 0);
  const vp = g5Verdict({ effects: copies, expected: 1, label: "chat lost answer, page reloaded, sent again" });
  const accepted =
    (await chatBox(page)
      .inputValue()
      .catch(() => null)) === "";
  ui.flowCheck(
    "G5",
    "chat lost, then reload: Send is the same message, one effect",
    vp.ok && accepted && p.every((t) => t.status === "sent"),
    { ...vp, sendAccepted: accepted, statuses: p.map((t) => t.status) },
  );
  await assertFlowChecks({ step, run, flow });
};
