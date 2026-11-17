import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-structure", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const show = async (l) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      l,
      "|",
      s.src.replace(/(participant|actor) \w+ as [^⏎]+ ⏎ /g, ""),
      "| sel",
      JSON.stringify(s.selected),
      "| alerts",
      JSON.stringify(await t.alerts()),
    );
  };
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  // stale picked after delete: delete msg-1, then click Loop with "nothing selected"
  const initialMessages = (await ui.seq.messages()).length;
  await step("delete msg-1 then click Loop without selecting", async () => {
    await ui.select("msg-1");
    await ui.deleteSelected();
    await show("after delete msg-1");
    await t.part("Loop").click();
    await show("after Loop click (no selection by user)");
  });
  // Loop with nothing selected adds nothing, so there may be one step to undo, not two: undo while there is any.
  await step("undo back to the start", async () => {
    for (let i = 0; i < 3 && (await t.toolbar("Undo").isEnabled()); i++) await ui.undo();
    await show("undone");
    expect((await ui.seq.messages()).length).toBe(initialMessages);
  });
  // notes
  await step("note over 1 participant", async () => {
    await ui.select("s");
    await t.part("Note").click();
    await show("note over s");
  });
  await step("note over 2 participants", async () => {
    await ui.seq.addNote(["c", "d"]);
    await show("note over c,d");
  });
  await step("note with nothing selected", async () => {
    await page.reload();
    await ui.canvasReady();
    await t.part("Note").click();
    await q.quiet();
    await show("Note with no selection");
  });
  await step("note over a message-selected (after message)", async () => {
    await ui.select("msg-1");
    await ui.seq.addNote(["s"]).catch((e) => console.log("PROBE note w/ msg selected:", String(e).slice(0, 150)));
    await show("note with message+participant");
  });
  // wraps in each kind
  for (const [kind, ids] of [
    ["Loop", ["msg-0"]],
    ["If / else", ["msg-1", "msg-2"]],
    ["Optional", ["msg-3"]],
    ["Parallel", ["msg-0", "msg-1"]],
  ]) {
    await step(`wrap ${ids.join(",")} in ${kind}`, async () => {
      await ui.resetProject("journeys");
      await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
      await ui.seq.wrap(ids, kind).catch((e) => console.log("PROBE wrap", kind, "failed", String(e).slice(0, 120)));
      await show(`after wrap ${ids} in ${kind}`);
      await t.shot(`seq-wrap-${kind}`);
    });
  }
  // non-consecutive
  await step("non-consecutive msg-0 + msg-2", async () => {
    await ui.resetProject("journeys");
    await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
    await ui.select("msg-0");
    await ui.select("msg-2", { shift: true });
    await t.part("Loop").click();
    await show("non-consecutive wrap");
  });
  // cross fragment
  await step("wrap one inside + one outside a loop", async () => {
    await ui.resetProject("journeys");
    await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
    await ui.seq.wrap(["msg-1", "msg-2"], "Loop");
    await ui.select("msg-0");
    await ui.select("msg-1", { shift: true });
    await t.part("If / else").click();
    await show("cross-fragment wrap");
  });
  // Change fragment label? rename fragment in place
  await step("dblclick a fragment label", async () => {
    const f = page.locator(".archer-seq-fragment").first();
    const b = await f.boundingBox();
    await page.mouse.dblclick(b.x + 30, b.y + 10);
    await page.waitForTimeout(400);
    console.log(
      "PROBE fragment dblclick editor:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Escape");
  });
  await step("delete a fragment: select it by click", async () => {
    const f = page.locator(".archer-seq-fragment").first();
    const b = await f.boundingBox();
    await page.mouse.click(b.x + 30, b.y + 10);
    await page.waitForTimeout(300);
    console.log(
      "PROBE after fragment click, delete enabled:",
      await t.toolbar("Delete selected").isEnabled(),
      "sel",
      JSON.stringify((await q.snap()).selected),
    );
  });
  // Notes: dblclick note edits? delete note
  await step("add note then dblclick it", async () => {
    await ui.seq.addNote(["s"]);
    const n = page.locator("g.archer-seq-note").first();
    await n.dblclick();
    await page.waitForTimeout(400);
    console.log(
      "PROBE note dblclick editor:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Escape");
    await n.click();
    console.log("PROBE note click, delete enabled:", await t.toolbar("Delete selected").isEnabled());
  });
};
