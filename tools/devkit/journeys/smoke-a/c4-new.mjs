// smoke-a: new C4 diagram: every element part, Relationship/Two-way by drag and Connect to…, duplicate pair, rename, reattach, delete, undo.
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-c4-new", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  await ui.resetProject("journeys");
  await ui.newDiagram("journeys", {
    type: "C4 container",
    saveAs: `diagrams/smoke-a-c4-${Date.now().toString(36)}.mmd`,
  });
  const ids = [];
  for (const [p, n] of [
    ["Person", "Alice"],
    ["System", "Sys"],
    ["External", "Ext"],
    ["Container", "Web"],
    ["Database", "Store"],
  ])
    ids.push(await ui.addPart(p, { name: n }));
  await h.note("ids", ids.join(","));
  await h.src("c4 after five elements");
  await h.btnIfEnabled("Reset layout");
  await h.fit();
  await h.shot("c4-new-1-elements");
  const [p, s, x, c, d] = ids;
  // Relationship by drag
  await h.part("Relationship");
  let r1;
  await step("Relationship drag p -> c", async () => {
    r1 = await ui.connect(p, c);
  });
  await step("relationship label editor opens?", async () => {
    const i = ui.locators.openLabelInput();
    const v = await i.isVisible().catch(() => false);
    console.log("NOTE rel label editor open:", v, v ? await i.inputValue() : "");
    if (v) {
      await i.fill("Browses");
      await i.press("Enter");
      await ui.settle();
    }
  });
  await h.part("Two-way");
  let r2;
  await step("Two-way drag c -> d", async () => {
    r2 = await ui.connect(c, d);
  });
  await step("birel label", async () => {
    const i = ui.locators.openLabelInput();
    const v = await i.isVisible().catch(() => false);
    console.log("NOTE birel label editor open:", v);
    if (v) {
      await i.press("Enter");
      await ui.settle();
    }
  });
  await h.src("c4 after rel + birel");
  // duplicate pair: p -> c again
  await h.part("Relationship");
  await step("duplicate pair p -> c by drag", async () => {
    let err = null;
    try {
      const r = await ui.connect(p, c);
      console.log("NOTE duplicate created edge", r);
    } catch (e) {
      err = e;
    }
    console.log(
      "NOTE duplicate attempt error:",
      err && String(err.message).split("\n")[0],
      "alerts:",
      JSON.stringify(await h.alert()),
    );
    const i = ui.locators.openLabelInput();
    if (await i.isVisible().catch(() => false)) {
      await i.press("Enter");
      await ui.settle();
    }
  });
  await h.src("c4 after duplicate attempt");
  // reverse pair c -> p
  await step("reverse pair c -> p by drag", async () => {
    let err = null;
    try {
      const r = await ui.connect(c, p);
      console.log("NOTE reverse created edge", r);
    } catch (e) {
      err = e;
    }
    console.log(
      "NOTE reverse attempt error:",
      err && String(err.message).split("\n")[0],
      "alerts:",
      JSON.stringify(await h.alert()),
    );
    const i = ui.locators.openLabelInput();
    if (await i.isVisible().catch(() => false)) {
      await i.press("Enter");
      await ui.settle();
    }
  });
  // Connect to… menu
  await ui.select(s);
  await step("Connect to… s -> x", async () => {
    await h.toolbar.getByRole("button", { name: "Connect to…" }).click();
    const menu = page.getByRole("menu");
    console.log("NOTE c4 menu:", (await menu.allTextContents()).join("|"));
    await menu.getByRole("menuitem", { name: /Ext/ }).click();
    await ui.settle();
    const i = ui.locators.openLabelInput();
    const v = await i.isVisible().catch(() => false);
    console.log("NOTE connect-to label editor open:", v);
    if (v) {
      await i.fill("Pings");
      await i.press("Enter");
      await ui.settle();
    }
  });
  await h.src("c4 after Connect to");
  await ui.rename(c, "Web app");
  await h.src("c4 after rename element");
  // rename relationship by keyboard and by double-click
  await step("rename relationship by double-click", async () => {
    const ed = (await h.edges())[0];
    const pth = await ui.locators
      .edge(ed)
      .locator(".react-flow__edge-path")
      .first()
      .evaluate((el) => {
        const m = el.getScreenCTM();
        const q = el.getPointAtLength(el.getTotalLength() * 0.5);
        return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
      });
    await page.mouse.dblclick(pth.x, pth.y);
    const i = ui.locators.openLabelInput();
    const v = await i.isVisible({ timeout: 2000 }).catch(() => false);
    console.log("NOTE c4 edge dblclick opens editor:", v, "edge", ed);
    if (v) {
      await i.fill("Renamed rel");
      await i.press("Enter");
      await ui.settle();
    }
  });
  await h.src("c4 after rel rename");
  await h.shot("c4-new-2-connected");
  // reattach
  await ui.reattachEdge(r1, "target", s);
  await h.src("c4 after reattach r1 target -> sys");
  await ui.undo();
  await h.src("c4 after undo reattach");
  // delete
  await ui.select(d);
  await ui.deleteSelected();
  await step("alerts delete referenced", async () => console.log("NOTE alerts:", JSON.stringify(await h.alert())));
  await h.src("c4 after delete referenced element");
  await ui.select(x);
  await ui.deleteSelected();
  await h.src("c4 after delete ext (has rel from Sys)");
  await ui.save();
  await step("saved", async () => console.log("--- SAVED\n" + (await page.url())));
};
