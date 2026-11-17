// J6 edit and save (user-flows.md §6): journeys/diagrams/flow.mmd → Edit → rename a node → Save.
// Mandatory outcome: the file differs only by that label; the status says saved. Collectors: G1 at the
// "acknowledged save" boundary (what was saved is what was on screen, with the base revision it was opened
// from), G4 (the saved claim is true: the bytes on disk are the person's), and G1 at "service killed after an
// acknowledged save" (SIGKILL, then a fresh start: the saved bytes are still there and still shown).
// PC-09 / claude-206: the status is read before Save too (on the reading page, and over the unsaved rename), and
// must not say Saved there, so "Saved" after Save is the save's answer and not a line that was already showing.
// Seeded fault claim-any-save: the page calls every change not made by the agent the person's save.
import { assertFlowChecks } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { DISCONNECT_INVARIANTS, FLOW, onlyLabelChanged } from "./state-lib.mjs";

const TO = "Customer";
export const meta = {
  name: "flows-j06-edit-save",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J6",
    baseline: [
      { action: "click Edit", class: "essential" },
      { action: "double-click node a", class: "essential" },
      { action: "type the new label", class: "essential" },
      { action: "press Enter", class: "essential" },
      { action: "click Save", class: "essential" },
    ],
  },
};

/** The presence line as the person reads it, or null when none is shown. */
async function status(page) {
  const line = page.locator(".archer-presence").first();
  if (!(await line.isVisible().catch(() => false))) return null;
  return {
    claim: ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim(),
    voice: await line.getAttribute("data-voice"),
  };
}
const saysSaved = (s) => s !== null && /\bsaved\b/i.test(s.claim);

export default async ({ ui, step, expect, page, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  const [edit, ...rename] = meta.flow.baseline;
  await ui.resetProject(FLOW.slug);
  const before = ui.fileState(FLOW.slug, FLOW.file);
  await ui.openDiagram(FLOW.slug, FLOW.path);
  // Nobody has saved this diagram in this browser: the reading page must not say Saved (claude-206).
  await expect(page.locator(".archer-presence").first()).toBeVisible();
  const reading = await status(page);
  ui.flowCheck("G4", "before Save: the reading page does not say Saved", reading !== null && !saysSaved(reading), {
    status: reading,
  });
  await flow.act(edit.action, edit.class, () => ui.enterEdit());
  await flow.actions(rename.slice(0, 3), () => ui.rename(FLOW.node, TO));
  const unsaved = await status(page);
  ui.flowCheck("G4", "before Save: the unsaved rename is not called saved", !saysSaved(unsaved), { status: unsaved });
  const captured = await ui.captureEditor(FLOW.slug, ui);
  ui.flowCheck(
    "G1",
    "edit: the draft is kept with its base revision",
    captured.baseRevision === before.revision && captured.text.includes(TO),
    { baseRevision: captured.baseRevision, diskRevision: before.revision },
  );
  const saves = [];
  page.on("response", async (r) => {
    if (r.request().method() === "POST" && /\/api\/authoring$/.test(r.url()))
      saves.push({
        status: r.status(),
        body: await r.json().catch(() => null),
        request: JSON.parse(r.request().postData() ?? "null"),
      });
  });
  await flow.act("click Save", "essential", () => ui.save());
  await step("saved: the file differs only by the renamed label", async () => {
    const after = ui.fileState(FLOW.slug, FLOW.file);
    const label = onlyLabelChanged(before.text, after.text, { node: FLOW.node, from: FLOW.from, to: TO });
    ui.flowCheck("G1", "acknowledged save: disk holds the captured draft", after.text === captured.text, {
      diskRevision: after.revision,
      capturedLength: captured.text.length,
    });
    const apply = saves.find((s) => s.request?.op === "document.apply");
    ui.flowCheck(
      "G1",
      "acknowledged save: sent from the captured base revision",
      apply?.request?.expectedSourceRevision === captured.baseRevision,
      { sentBase: apply?.request?.expectedSourceRevision ?? null, outcome: apply?.body?.outcome ?? null },
    );
    expect(label.ok, `changed lines: ${JSON.stringify(label.lines)}`).toBe(true);
    return { lines: label.lines };
  });
  await step("status says saved", async () => {
    const apply = saves.find((s) => s.request?.op === "document.apply");
    // What the page claims after Save, read from the page after it (the editor closes onto the reading page, whose
    // presence line says who last changed the diagram and when: "Saved · HH:MM" in the person's voice; "Edited" no
    // longer counts, as it does not say saved: flows-r1 claude-04, PC-09).
    const presence = page.locator(".archer-presence").first();
    await expect(presence).toBeVisible();
    // The claim follows the recompile of the save; a bounded wait, judged below.
    await expect(presence)
      .toContainText(/\bSaved\b/, { timeout: 10_000 })
      .catch(() => {});
    const claim = ((await presence.textContent()) ?? "").replace(/\s+/g, " ").trim();
    const voice = await presence.getAttribute("data-voice");
    const now = new Date(),
      hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    const fresh = [hhmm(now), hhmm(new Date(now.getTime() - 60_000))].some((t) => claim.includes(t));
    const saidSaved = /\bsaved\b/i.test(claim) && voice === "you" && fresh;
    ui.flowCheck(
      "G4",
      "after Save: the page's saved claim is true",
      saidSaved && apply?.body?.outcome === "applied" && ui.fileState(FLOW.slug, FLOW.file).text.includes(TO),
      { claim, voice, outcome: apply?.body?.outcome ?? null, usesWordSaved: /\bsaved\b/i.test(claim) },
    );
    expect(saidSaved, `the page should say the person just saved it; it shows: ${claim} (voice ${voice})`).toBe(true);
    run.flowState.j6 = { claim, voice };
  });
  // §6 promise boundary "service killed after an acknowledged save": the save survives a SIGKILL and a fresh start.
  await ui.killService();
  await step("after the service was killed: the saved version is on disk and served", async () => {
    const disk = ui.fileState(FLOW.slug, FLOW.file);
    const served = await ui
      .serviceGet(`/p/${FLOW.slug}/api/diagrams`)
      .then((d) => (d.views ?? []).find((v) => v.id === "flow"))
      .catch(() => null);
    const shown = await expect(page.locator(".react-flow__node").filter({ hasText: TO }))
      .toHaveCount(1, { timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    ui.flowCheck("G1", "service killed after an acknowledged save", disk.text === captured.text && shown, {
      diskRevision: disk.revision,
      servedRevision: served?.sourceRevision ?? served?.revision ?? null,
      shownWithoutReload: shown,
    });
  });
  await assertFlowChecks({ step, run, flow });
};
