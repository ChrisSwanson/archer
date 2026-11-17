// J7b conflict, two coordinated saves (user-flows.md §6, §8 G2): two fresh signed-in contexts edit the same diagram
// from one base revision and both Save through the production path. Run twice: one after the other, then both at
// once (a race). G2 for the save that loses: refused before it takes effect (the service's conflict answer, file
// bytes unchanged by it); afterwards the winner's version is on disk and the loser's version is in its editor.
import { assertFlowChecks, g2Verdict } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { FLOW, FLOW_INVARIANTS, clickSave, savesAnswered, trackAuthoring } from "./state-lib.mjs";

export const meta = {
  name: "flows-j07b-coordinated-saves",
  invariants: { ...FLOW_INVARIANTS, "editor-alert": false },
  flow: {
    id: "J7b",
    baseline: [
      { action: "person one: click Edit", class: "essential" },
      { action: "person one: double-click node a", class: "essential" },
      { action: "person one: type the new label", class: "essential" },
      { action: "person one: press Enter", class: "essential" },
      { action: "person two: click Edit", class: "essential" },
      { action: "person two: double-click node b", class: "essential" },
      { action: "person two: type the new label", class: "essential" },
      { action: "person two: press Enter", class: "essential" },
      { action: "person two: click Save", class: "essential" },
      { action: "person one: click Save", class: "essential" },
    ],
  },
};

/**
 * One person: a fresh signed-in context, editing FLOW with one rename. With `flow` and `who` ("person one") the
 * person's actions go in the trace (the pinned trace is round 1's; the race round is a probe, not a person's path).
 */
async function editor(ui, node, label, flow, who) {
  const p = await ui.openContext({ fresh: true });
  p.saves = trackAuthoring(p.page);
  await p.ui.openDiagram(FLOW.slug, FLOW.path);
  const E = (action) => ({ action: `${who}: ${action}`, class: "essential" });
  if (flow) await flow.act(E("click Edit").action, "essential", () => p.ui.enterEdit());
  else await p.ui.enterEdit();
  if (flow)
    await flow.actions([E(`double-click node ${node}`), E("type the new label"), E("press Enter")], () =>
      p.ui.rename(node, label),
    );
  else await p.ui.rename(node, label);
  p.captured = await p.ui.captureEditor(FLOW.slug, p.ui);
  p.label = label;
  return p;
}

async function judge(ui, round, { loser, diskBeforeSave, winnerSource }) {
  const answer = loser.saves.applies().at(-1) ?? null;
  const editorSource = await loser.ui.editorSource().catch(() => null);
  const verdict = g2Verdict({
    answer: answer?.body ?? null,
    sent: answer !== null,
    diskBeforeSave,
    diskAfterSave: ui.fileState(FLOW.slug, FLOW.file).text,
    otherWriter: winnerSource,
    personSource: loser.captured.text,
    editorSource,
  });
  ui.flowCheck("G2", round, verdict.ok, {
    ...verdict,
    loser: loser.label,
    sentBase: answer?.request?.expectedSourceRevision ?? null,
  });
  const state = await loser.ui.editorState();
  const keep = (state?.conflict?.actions ?? [])
    .filter((a) => /proposal|copy my|keep/i.test(a.text) && !a.disabled)
    .map((a) => a.text);
  ui.flowCheck(
    "G4",
    `${round}: the loser is told, with a way to keep the version`,
    state?.conflict != null && keep.length > 0,
    { conflict: state?.conflict?.text ?? null, keep },
  );
  return verdict;
}

export default async ({ ui, step, expect, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  // Round 1: one after the other.
  await ui.resetProject(FLOW.slug);
  const base = ui.fileState(FLOW.slug, FLOW.file);
  const one = await editor(ui, "a", "Person one", flow, "person one");
  const two = await editor(ui, "b", "Person two", flow, "person two");
  ui.flowCheck(
    "G2",
    "sequential: both drafts from one base revision",
    one.captured.baseRevision === base.revision && two.captured.baseRevision === base.revision,
    { one: one.captured.baseRevision, two: two.captured.baseRevision, disk: base.revision },
  );
  // What this journey seeds, and so declares (errors.mjs): person one's editor saying the original changed when person
  // two's save lands, and the refusal of the stale save, in each round.
  // An alert when the conflict appears; a notice (role=status) when the banner's words change after it (O156). Only what
  // each step causes is declared (PC-601): round 1's refused save changes the banner already shown (the notice); in the
  // race the loser's refusal is the first it hears of the conflict (the alert), and the banner may change after it.
  const CONFLICT = { kind: "alert", text: "changed outside the editor" },
    BLOCKED = { kind: "notice", text: "Save is blocked" },
    REFUSED = { kind: "alert", text: "Save is blocked" };
  await flow.act(
    "person two: click Save",
    "essential",
    async () => {
      await clickSave(two.page);
      await savesAnswered(two.page, two.saves);
    },
    { expects: [CONFLICT] },
  );
  const afterTwo = ui.fileState(FLOW.slug, FLOW.file).text;
  await step("person two's save took effect", () => {
    expect(two.saves.applies().at(-1)?.body?.outcome).toBe("applied");
    expect(afterTwo).toBe(two.captured.text);
  });
  await flow.act(
    "person one: click Save",
    "essential",
    async () => {
      await clickSave(one.page);
      await savesAnswered(one.page, one.saves);
    },
    { expects: [BLOCKED] },
  );
  const r1 = await judge(ui, "sequential: the second save from the same base", {
    loser: one,
    diskBeforeSave: afterTwo,
    winnerSource: two.captured.text,
  });
  await step("sequential round: G2 holds", () => expect(r1.problems).toEqual([]));
  for (const p of [one, two]) await p.context.close();

  // Round 2: both Save at once.
  await ui.resetProject(FLOW.slug);
  const base2 = ui.fileState(FLOW.slug, FLOW.file);
  const x = await editor(ui, "a", "Racer one");
  const y = await editor(ui, "b", "Racer two");
  ui.flowCheck(
    "G2",
    "race: both drafts from one base revision",
    x.captured.baseRevision === base2.revision && y.captured.baseRevision === base2.revision,
    { x: x.captured.baseRevision, y: y.captured.baseRevision },
  );
  await step(
    "both click Save at once",
    async () => {
      await Promise.all([clickSave(x.page), clickSave(y.page)]);
      await Promise.all([savesAnswered(x.page, x.saves), savesAnswered(y.page, y.saves)]);
    },
    { expects: [REFUSED, BLOCKED] },
  );
  const outcomes = [x, y].map((p) => p.saves.applies().at(-1)?.body?.outcome ?? null);
  const winners = [x, y].filter((p, i) => outcomes[i] === "applied");
  const losers = [x, y].filter((p, i) => outcomes[i] !== "applied");
  ui.flowCheck("G2", "race: exactly one save took effect", winners.length === 1, { outcomes });
  if (winners.length === 1) {
    const r2 = await judge(ui, "race: the losing save", {
      loser: losers[0],
      diskBeforeSave: winners[0].captured.text,
      winnerSource: winners[0].captured.text,
    });
    await step("race round: G2 holds", () => expect(r2.problems).toEqual([]));
  } else {
    await step("race round: G2 holds", () => {
      throw new Error(`race outcomes ${JSON.stringify(outcomes)}; disk: ${ui.fileState(FLOW.slug, FLOW.file).text}`);
    });
  }
  await assertFlowChecks({ step, run, flow });
};
