import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-edit", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const P = "diagrams/seq.mmd";
  const note = async (label, extra) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      label,
      "|",
      s.src.replace(/(participant|actor) \w+ as \w+ ⏎ /g, ""),
      "| sel",
      JSON.stringify(s.selected),
      "panel",
      s.panel,
      extra ?? "",
      "| alerts",
      JSON.stringify(await t.alerts()),
    );
    return s;
  };
  const panel = () => page.getByRole("region", { name: "Selected message" });
  const panelVals = async () =>
    panel()
      .isVisible()
      .then(async (v) =>
        !v
          ? null
          : {
              from: await panel()
                .locator("label")
                .filter({ hasText: /^\s*From/ })
                .locator("select")
                .inputValue(),
              to: await panel()
                .locator("label")
                .filter({ hasText: /^\s*To/ })
                .locator("select")
                .inputValue(),
              type: await panel()
                .locator("label")
                .filter({ hasText: /^\s*Type/ })
                .locator("select")
                .inputValue(),
              pos: await panel().getByLabel("Position in the sequence").inputValue(),
              text: await panel()
                .textContent()
                .then((s) => s.slice(0, 120)),
            },
      );
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", P, { edit: true });
  await note("initial");
  // 1. drag message ends
  await step("drag msg-0 target end to Database", async () => {
    await ui.seq.dragMessageEnd("msg-0", "target", "d");
    await note("after dragMessageEnd c->s to c->d", "panel=" + JSON.stringify(await panelVals()));
  });
  await step("drag msg-0 source end to Server", async () => {
    await ui.seq.dragMessageEnd("msg-0", "source", "s");
    await note("source end to s (would make self message s->d?)");
  });
  await step("drag msg-3 source end onto its own target (self message)", async () => {
    await ui.seq.dragMessageEnd("msg-3", "source", "c");
    await note("msg-3 source -> c (c->>c)");
  });
  await ui.undo();
  await ui.undo();
  await ui.undo();
  await note("after 3 undo (original)");
  // 2. move message up/down by drag, buttons, keys
  await step("drag msg-3 above msg-1", async () => {
    await ui.seq.moveMessage("msg-3", "msg-1");
    await note("after drag msg-3 above msg-1", "panel=" + JSON.stringify(await panelVals()));
  });
  await step("select msg-1 afterwards: which is selected & panel shows?", async () => {
    const s = await q.snap();
    console.log(
      "PROBE selected after reorder drag:",
      JSON.stringify(s.selected),
      "panel:",
      JSON.stringify(await panelVals()),
    );
  });
  await step("Alt+ArrowDown on selected", async () => {
    await page.keyboard.press("Alt+ArrowDown");
    await note("after Alt+Down", "panel=" + JSON.stringify(await panelVals()));
  });
  await step("Move message up button x2", async () => {
    await t.toolbar("Move message up").click();
    await q.quiet();
    await t
      .toolbar("Move message up")
      .click()
      .catch(() => {});
    await note("after Move up x2", "panel=" + JSON.stringify(await panelVals()));
  });
  await ui.undo();
  await ui.undo();
  await ui.undo();
  await ui.undo();
  await note("after undos to original");
  // 3. panel position input
  await step("panel position typing", async () => {
    await ui.select("msg-0");
    console.log("PROBE panel for msg-0:", JSON.stringify(await panelVals()));
    const f = panel().getByLabel("Position in the sequence");
    for (const v of ["3", "99", "0", "-2", "2.5", "", "4"]) {
      await f.click({ clickCount: 3 }).catch(() => {});
      await f.fill(v);
      await f.press("Enter").catch(() => {});
      await q.quiet(400);
      const s = await q.snap();
      console.log(
        "PROBE position typed",
        JSON.stringify(v),
        "->",
        JSON.stringify(s.messages),
        "panel:",
        JSON.stringify(await panelVals()),
        "sel",
        JSON.stringify(s.selected),
        "alerts",
        JSON.stringify(await t.alerts()),
      );
    }
  });
  await step("panel position via keyboard typing digits one by one", async () => {
    await ui.select("msg-0");
    const f = panel().getByLabel("Position in the sequence");
    await f.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("12", { delay: 150 });
    await q.quiet();
    const s = await q.snap();
    console.log(
      "PROBE typed '12' digit by digit:",
      JSON.stringify(s.messages),
      JSON.stringify(await panelVals()),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
  });
  await ui.undo().catch(() => {});
  await t.shot("seq-edit-end");
};
