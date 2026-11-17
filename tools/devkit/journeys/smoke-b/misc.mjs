import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-misc", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(700);
  };
  await ui.resetProject("awkward");
  await ui.resetProject("journeys");
  // 1 ER: change cardinality of an existing relationship
  await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
  await fit();
  await step("ER: select relationship, choose another cardinality part", async () => {
    const ok = await t.pickEdge("CUSTOMER--ORDER", 0.3);
    await t.part("Many to many").click();
    await q.quiet(500);
    console.log(
      "PROBE ER cardinality change: picked",
      ok,
      "line now:",
      (await t.src()).split("\n").filter((l) => /CUSTOMER .*ORDER/.test(l)),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
  });
  await step("ER: edge selected: toolbar delete enabled / Connect disabled", async () => {
    console.log(
      "PROBE ER edge sel: delete enabled",
      await t.toolbar("Delete selected").isEnabled(),
      "connect enabled",
      await t.toolbar("Connect to…").isEnabled(),
    );
  });
  // 2 reload mid edit: draft recovery
  await step("ER: edit, reload, draft recovery", async () => {
    await ui.rename("ORDER", "PURCHASE");
    await q.quiet(800);
    await page.reload();
    await ui.canvasReady();
    await q.quiet(1000);
    console.log(
      "PROBE after reload: url",
      page.url().replace(/.*\/projects/, ""),
      "ORDER label:",
      await ui.locators
        .node("ORDER")
        .textContent()
        .catch(() => "n/a"),
      "status:",
      await t.status(),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
  });
  await step("ER: Save then reading page shows change", async () => {
    await ui.save();
    await page.waitForTimeout(1500);
    const svgText = await page
      .locator("svg, .react-flow")
      .first()
      .textContent()
      .catch(() => "");
    console.log(
      "PROBE reading page after save: url",
      page.url().replace(/.*\/projects/, ""),
      "contains PURCHASE:",
      /PURCHASE/.test(await page.locator("main, .archer-reader, body").first().textContent()),
      "edit flag in url:",
      /edit/.test(page.url()),
    );
  });
  // 3 seq: connect menu screenshot
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await q.quiet(300);
  await step("seq: Connect to… menu content", async () => {
    await ui.select("c");
    await t.toolbar("Connect to…").click();
    await page.waitForTimeout(300);
    console.log(
      "PROBE seq connect menu text:",
      JSON.stringify(await page.locator(".authoring-connect-menu").textContent()),
    );
    await t.shot("seq-connect-menu");
    await page.keyboard.press("Escape");
  });
  // 4 seq: rename participant while a message selected
  await step("seq: rename participant while message selected", async () => {
    await ui.select("msg-1");
    await ui.rename("s", "Backend");
    await q.quiet(400);
    const s = await q.snap();
    console.log(
      "PROBE after rename participant: selected",
      JSON.stringify(s.selected),
      "panel",
      s.panel,
      "src participants:",
      JSON.stringify(s.srcPart),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
  });
  // 5 seq: Escape cancels label edit and restores
  await step("seq: dblclick message, type, Escape restores", async () => {
    await ui.locators.message("msg-0").dblclick();
    const i = ui.locators.openLabelInput();
    await i.fill("SHOULD NOT STICK");
    await page.keyboard.press("Escape");
    await q.quiet(500);
    console.log("PROBE after Esc label:", await ui.locators.message("msg-0").getAttribute("aria-label"));
  });
  await step("seq: dblclick message, type, click elsewhere (blur) commits?", async () => {
    await ui.locators.message("msg-0").dblclick();
    const i = ui.locators.openLabelInput();
    await i.fill("blur commit");
    await page.mouse.click(700, 560);
    await q.quiet(600);
    console.log("PROBE after blur label:", await ui.locators.message("msg-0").getAttribute("aria-label"));
  });
  // 6 seq: undo while label editor open
  await step("seq: Ctrl+Z inside open label editor", async () => {
    await ui.locators.message("msg-1").dblclick();
    const i = ui.locators.openLabelInput();
    await i.fill("typed then undo");
    await page.keyboard.press("Control+z");
    await q.quiet(400);
    console.log(
      "PROBE after ctrl+z in editor: input value:",
      await i.inputValue().catch(() => "(closed)"),
      "undo enabled",
      await t.toolbar("Undo").isEnabled(),
    );
    await page.keyboard.press("Escape");
  });
  // 7 message text with special chars
  await step("seq: special characters in message", async () => {
    await ui.rename("msg-2", 'a; b # c -> d: "q" & <x> %% z');
    await q.quiet(500);
    console.log(
      "PROBE special src:",
      (await t.src()).split("\n").filter((l) => /user record|a; b|#/.test(l)),
      "label:",
      await ui.locators.message("msg-2").getAttribute("aria-label"),
    );
  });
  await step("seq: multi-line label (Shift+Enter?)", async () => {
    await ui.locators.message("msg-3").dblclick();
    const i = ui.locators.openLabelInput();
    await i.fill("line1");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line2");
    await page.keyboard.press("Enter");
    await q.quiet(500);
    console.log(
      "PROBE multiline src:",
      (await t.src()).split("\n").filter((l) => /line1|line2/.test(l)),
    );
  });
};
