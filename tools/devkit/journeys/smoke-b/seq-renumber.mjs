import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-renumber", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const P = "diagrams/seq.mmd";
  const lab = async (id) =>
    (await ui.locators
      .message(id)
      .getAttribute("aria-label")
      .catch(() => null)) ?? "(gone)";
  const panelLabel = async () => {
    const p = page.getByRole("region", { name: "Selected message" });
    return (await p.isVisible().catch(() => false)) ? (await p.textContent()).slice(0, 40) : null;
  };
  const state = async (label) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      label,
      "| order:",
      JSON.stringify(s.messages),
      "| selected:",
      JSON.stringify(s.selected),
      "| panel title:",
      JSON.stringify(await panelLabel()),
    );
  };
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", P, { edit: true });
  // A. select "200 OK" (msg-3), press Move message up once at a time
  await ui.select("msg-3");
  await state("selected msg-3 (200 OK)");
  await step("Move message up #1", async () => {
    await t.toolbar("Move message up").click();
    await state("after Move up #1");
  });
  await step("Move message up #2", async () => {
    await t.toolbar("Move message up").click();
    await state("after Move up #2");
  });
  await step("Alt+ArrowUp", async () => {
    await page.keyboard.press("Alt+ArrowUp");
    await state("after Alt+Up");
  });
  await ui.undo();
  await ui.undo();
  await ui.undo();
  await state("undone");
  // B. reverse then selection
  await step("reverse msg-1 via toolbar", async () => {
    await ui.select("msg-1");
    await t.toolbar("Reverse message").click();
    await state("after reverse");
  });
  await ui.undo();
  // C. rename a message in place by dblclick, then rename again quickly
  await step("dblclick rename msg-2", async () => {
    await ui.rename("msg-2", "renamed record");
    await state("after rename msg-2");
  });
  // D. delete a middle message: selection / panel
  await step("delete middle message msg-1 using toolbar", async () => {
    await ui.select("msg-1");
    await ui.deleteSelected();
    await state("after delete msg-1 (selection should clear)");
  });
  await step("Delete key on a selected message", async () => {
    await ui.select("msg-0");
    await page.keyboard.press("Delete");
    await q.quiet();
    await state("after Delete key msg-0");
  });
  await ui.undo();
  await ui.undo();
  await ui.undo();
  await state("after undo x3");
  // E. wrapping then selection
  await step("wrap msg-1,msg-2 in Loop; selection afterwards", async () => {
    await ui.seq.wrap(["msg-1", "msg-2"], "Loop");
    await state("after wrap");
    const s = await q.snap();
    console.log("PROBE after wrap src:", s.src);
  });
  await step("wrap again (nested) msg-0..msg-2 in Optional", async () => {
    await ui.seq
      .wrap(["msg-0", "msg-1", "msg-2"], "Optional")
      .catch((e) => console.log("PROBE nested wrap failed:", String(e).slice(0, 200)));
    await state("after nested wrap");
    console.log("PROBE nested src:", (await q.snap()).src, "alerts", JSON.stringify(await t.alerts()));
  });
  await t.shot("seq-renumber-end");
};
