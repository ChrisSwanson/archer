// J7a conflict, external write (user-flows.md §6): J6 unsaved → an agent writes the file (ui.agentWrite) → Save.
// G2: the uncoordinated external write is detected before Save; the stale save is refused before it takes effect
// (the service's answer, the file bytes unchanged by it); afterwards the other writer's version is on disk and the
// person's version is in the editor (or saved as a copy). The page names the conflict and a way to keep the work.
import { assertFlowChecks, g2Verdict } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { FLOW, FLOW_INVARIANTS, clickSave, savesAnswered, trackAuthoring, within } from "./state-lib.mjs";

const TO = "Mine";
export const meta = {
  name: "flows-j07a-external-write",
  invariants: { ...FLOW_INVARIANTS, "editor-alert": false },
  flow: {
    id: "J7a",
    baseline: [
      { action: "click Edit", class: "essential" },
      { action: "double-click node a", class: "essential" },
      { action: "type the new label", class: "essential" },
      { action: "press Enter", class: "essential" },
      { action: "click Save", class: "essential" },
    ],
  },
};

export default async ({ ui, step, expect, page, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  const [edit, ...rename] = meta.flow.baseline;
  await ui.resetProject(FLOW.slug);
  const before = ui.fileState(FLOW.slug, FLOW.file);
  const saves = trackAuthoring(page);
  await ui.openDiagram(FLOW.slug, FLOW.path);
  await flow.act(edit.action, edit.class, () => ui.enterEdit());
  await flow.actions(rename.slice(0, 3), () => ui.rename(FLOW.node, TO));
  const person = await ui.captureEditor(FLOW.slug, ui);
  const other = before.text.replace("b[API]", "b[API by agent]");
  // What this journey seeds, and so declares (errors.mjs): the conflict alert the write raises and Save's refusal.
  // The banner is an alert when the conflict appears, and polite (role=status: a notice to the census) once its words
  // change (O156); the conflict still stands after the proposal is saved, and the banner says so again, silently.
  const CONFLICT = { kind: "alert", text: "changed outside the editor" },
    BLOCKED = { kind: "notice", text: "Save is blocked" };
  const STANDING = { kind: "notice", text: "changed outside the editor" };
  await ui.agentWrite(FLOW.slug, FLOW.file, other, { expects: [CONFLICT] });
  const detected = await step("the page says the original changed, before Save", async () => {
    await expect(page.locator(".authoring-conflict")).toBeVisible({ timeout: 10_000 });
    return ui.editorState();
  });
  ui.flowCheck("G2", "external write detected before Save", detected?.conflict != null, {
    conflict: detected?.conflict ?? null,
  });
  // claude-310: one change, said once in the editor (the banner) beside ADR 0028's Load the new version / Keep mine
  // choice; no second notice under the drawing saying the same thing.
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll('.authoring-workspace *, [aria-label="Diagram Editor"] *')]
      .filter(
        (el) =>
          el.children.length === 0 &&
          el.checkVisibility?.() !== false &&
          /changed outside the editor/i.test(el.textContent ?? ""),
      )
      .map((el) => el.textContent.trim()),
  );
  const choices = await page.locator(".archer-file-updates").count();
  ui.flowCheck(
    "G4",
    "one outside change is said once in the editor, beside the one choice",
    outside.length === 1 && choices === 1,
    { outside, choices },
  );
  // claude-10: reopening the original lands on the diagram's own editing address, not the legacy /-/edit/ one.
  const reopen =
    (detected?.conflict?.actions ?? []).find((a) => a.text === "Reopen the current original")?.href ?? null;
  ui.flowCheck(
    "U7",
    "Reopen the current original opens the canonical editor address",
    reopen === `/projects/${FLOW.slug}/${FLOW.path}?edit`,
    { reopen },
  );
  const diskBeforeSave = ui.fileState(FLOW.slug, FLOW.file).text;
  await flow.act(
    "click Save",
    "essential",
    async () => {
      await clickSave(page);
      await savesAnswered(page, saves, 1, 10_000);
    },
    { expects: [BLOCKED] },
  );
  const answer = saves.applies().at(-1) ?? null;
  const editorSource = await ui.editorSource();
  const state = await ui.editorState();
  const verdict = g2Verdict({
    answer: answer?.body ?? null,
    sent: answer !== null,
    diskBeforeSave,
    diskAfterSave: ui.fileState(FLOW.slug, FLOW.file).text,
    otherWriter: other,
    personSource: person.text,
    editorSource,
  });
  ui.flowCheck("G2", "stale save after an external write", verdict.ok, {
    ...verdict,
    sentBase: answer?.request?.expectedSourceRevision ?? null,
    capturedBase: person.baseRevision,
  });
  const keep = (state?.conflict?.actions ?? [])
    .filter((a) => /proposal|copy my|keep/i.test(a.text) && !a.disabled)
    .map((a) => a.text);
  ui.flowCheck(
    "G4",
    "the conflict is named with a way to keep the person's version",
    state?.conflict != null && keep.length > 0,
    { conflict: state?.conflict?.text ?? null, keep, status: state?.status ?? null },
  );
  await step("G2 outcome: refused, file is the agent's, the person's version kept", () =>
    expect(verdict.problems).toEqual([]),
  );
  // O84 (claude-03): the banner's "Save as a proposal privately" is the way to keep the person's version it offers. It
  // must save it, as their text against the base they opened (ADR 0025, never rebased onto the agent's write), leave
  // the file alone, and the page must say what is true. Read back from the service, not the page.
  const proposal = await step(
    "Save as a proposal privately keeps the person's version",
    async () => {
      const before = saves.list.length,
        statuses = [];
      // The service's draft list as the page reads it after its save (a read of our own here would be a duplicate request).
      const onStatus = async (r) => {
        if (r.request().method() === "GET" && /\/api\/authoring$/.test(new URL(r.url()).pathname))
          statuses.push(await r.json().catch(() => null));
      };
      page.on("response", onStatus);
      await page.locator(".authoring-conflict").getByRole("button", { name: "Save as a proposal privately" }).click();
      await within(page, () => saves.list.slice(before).some((x) => x.op === "draft.save"), { timeout: 10_000 });
      const answer = saves.list.slice(before).find((x) => x.op === "draft.save");
      await expect(page.locator(".authoring-feedback"))
        .toBeVisible({ timeout: 5_000 })
        .catch(() => {});
      if (answer?.status === 200) await within(page, () => statuses.length > 0, { timeout: 5_000 }).catch(() => {});
      page.off("response", onStatus);
      const status = statuses.at(-1) ?? null;
      const draft =
        (status?.drafts ?? []).find((d) => d.draftId === answer?.request?.draftId && d.state === "open") ?? null;
      const snapshot = draft
        ? await page
            .evaluate(
              async ({ slug, draftId, draftRevision }) => {
                const r = await fetch(`/p/${slug}/api/authoring/snapshot`, {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ draftId, draftRevision }),
                });
                return r.ok ? r.json() : null;
              },
              { slug: FLOW.slug, draftId: draft.draftId, draftRevision: draft.draftRevision },
            )
            .catch(() => null)
        : null;
      return {
        answer: answer
          ? {
              status: answer.status,
              outcome: answer.body?.outcome ?? null,
              code: answer.body?.code ?? answer.body?.error?.code ?? null,
            }
          : null,
        draft,
        snapshot,
        page: await ui.editorState(),
        disk: ui.fileState(FLOW.slug, FLOW.file).text,
      };
    },
    { expects: [STANDING] },
  );
  const saved = proposal?.answer?.status === 200 && proposal.answer.outcome === "saved" && proposal.draft !== null;
  ui.flowCheck(
    "G2",
    "the proposal copy keeps the person's version against the base they opened",
    saved &&
      proposal.snapshot?.source === person.text &&
      proposal.draft.origin?.baseSourceRevision === before.revision &&
      proposal.draft.origin?.diverged === true,
    {
      answer: proposal?.answer ?? null,
      draftOrigin: proposal?.draft?.origin ?? null,
      snapshotIsPerson: proposal?.snapshot?.source === person.text,
      expectedBase: before.revision,
    },
  );
  ui.flowCheck("G2", "saving the proposal leaves the agent's file alone", proposal?.disk === other, {
    diskIsAgent: proposal?.disk === other,
  });
  const said = proposal?.page?.feedback?.text ?? null;
  ui.flowCheck(
    "G4",
    "the page says the proposal's true outcome",
    saved
      ? /Saved as a private proposal/.test(said ?? "") && /Draft and proposal tools/.test(said ?? "")
      : /not saved/i.test(said ?? "") && !/kept as a draft you can compare/.test(said ?? ""),
    { said, saved },
  );
  await assertFlowChecks({ step, run, flow });
};
