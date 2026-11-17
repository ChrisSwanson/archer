import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-er-existing", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const lines = async (re) => (await t.src()).split("\n").filter((l) => re.test(l));
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(900);
  };
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
  const e1 = await ui.addPart("Entity", { name: "Invoice" });
  const e2 = await ui.addPart("Entity", { name: "Payment" });
  await fit();
  for (const [part, from, to, label] of [
    ["One to many", e1, "CUSTOMER", "billed to"],
    ["One to one", e1, e2, "paid by"],
    ["Many to many", e2, "ORDER", "covers"],
  ]) {
    await step(`connect ${part} ${from}->${to}`, async () => {
      await t.part(part).click();
      await t.gconnect(from, to);
      const inp = ui.locators.openLabelInput();
      const open = await inp.isVisible().catch(() => false);
      console.log("PROBE label editor opened after connect:", open, "part", part);
      if (open) {
        await inp.fill(label);
        await inp.press("Enter");
        await ui.settle();
      }
      await fit();
    });
  }
  await t.probe("lines after 3 connects", async () => lines(/ENTITY_/));
  // duplicate + reverse
  await step("duplicate pair e1->CUSTOMER with One to one", async () => {
    await t.part("One to one").click();
    await t.gconnect(e1, "CUSTOMER");
    console.log(
      "PROBE dup: editor open?",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      "alerts",
      JSON.stringify(await t.alerts()),
      JSON.stringify(await lines(/ENTITY_1.*CUSTOMER|CUSTOMER.*ENTITY_1/)),
    );
    await page.keyboard.press("Escape");
  });
  await step("reverse pair CUSTOMER->e1", async () => {
    await t.part("Many to many").click();
    await t.gconnect("CUSTOMER", e1);
    console.log(
      "PROBE rev: editor open?",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      "alerts",
      JSON.stringify(await t.alerts()),
      JSON.stringify(await lines(/ENTITY_1.*CUSTOMER|CUSTOMER.*ENTITY_1/)),
    );
    await page.keyboard.press("Escape");
  });
  await t.shot("er-connected");
  // Connect to... menu
  await step("Connect to… from Invoice to LINE-ITEM", async () => {
    await ui.select(e1);
    await t.toolbar("Connect to…").click();
    const menu = page.getByRole("menu", { name: /^Connect .* to$/ });
    console.log("PROBE connect menu items:", JSON.stringify(await menu.getByRole("menuitem").allTextContents()));
    await menu
      .getByRole("menuitem")
      .filter({ hasText: /Order [Ll]ine|LINE-ITEM/ })
      .first()
      .click();
    await ui.settle();
    console.log(
      "PROBE after Connect to:",
      JSON.stringify(await lines(/LINE-ITEM/)),
      "editor",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Enter").catch(() => {});
    await ui.settle();
  });
  // rename in title band: entity with attributes and one with a label
  await ui.rename("CUSTOMER", "Client");
  await ui.rename("LINE-ITEM", "Row");
  await t.probe("renamed", async () => lines(/CUSTOMER\[|LINE-ITEM\[|\bORDER\[/));
  await ui.renameEdge("CUSTOMER--ORDER", "has placed");
  await ui.renameEdge("CUSTOMER--ADDRESS", "lives at");
  await ui.renameEdge("PRODUCT--WAREHOUSE", 'say "hi" & bye');
  await t.probe("labels", async () => lines(/has placed|lives at|bye/));
  // Edge rename to empty
  await ui.renameEdge("ORDER--LINE-ITEM", "");
  await t.probe("emptied label", async () => lines(/ORDER .*LINE-ITEM/));
  // reattach
  await ui.reattachEdge("CUSTOMER--ADDRESS", "target", "WAREHOUSE");
  await t.probe("reattach target", async () => ({ l: await lines(/lives at/), al: await t.alerts() }));
  await ui.reattachEdge("PRODUCT--WAREHOUSE", "source", "ADDRESS");
  await t.probe("reattach source", async () => ({ l: await lines(/bye/), al: await t.alerts() }));
  // reattach onto an existing pair (collision)
  await ui.reattachEdge("LINE-ITEM--PRODUCT", "source", "ORDER").catch(() => {});
  await t.probe("reattach to create dup pair", async () => ({ l: await lines(/PRODUCT/), al: await t.alerts() }));
  // delete referenced / unreferenced
  await ui.select("PRODUCT");
  await ui.deleteSelected();
  await t.probe("delete referenced PRODUCT alerts", async () => t.alerts());
  await page.keyboard.press("Escape");
  await ui.select("ADDRESS");
  await page.keyboard.press("Delete");
  await ui.settle();
  await t.probe("Delete key on referenced ADDRESS", async () => ({
    al: await t.alerts(),
    still: await ui.locators.node("ADDRESS").count(),
  }));
  await ui.select(e2);
  await ui.deleteSelected();
  await t.probe("delete referenced e2", async () => ({
    al: await t.alerts(),
    still: await ui.locators.node(e2).count(),
  }));
  const e3 = await ui.addPart("Entity", { name: "Scratch" });
  await ui.select(e3);
  await ui.deleteSelected();
  await t.probe("delete unreferenced", async () => ({ gone: (await ui.locators.node(e3).count()) === 0 }));
  // delete an edge
  await ui.select("ORDER--LINE-ITEM");
  await ui.deleteSelected();
  await t.probe("delete edge", async () => lines(/ORDER .*LINE-ITEM/));
  // undo all
  let n = 0;
  while ((await t.toolbar("Undo").isEnabled()) && n < 40) {
    await ui.undo();
    n++;
  }
  await t.probe("undo all", async () => ({
    n,
    same: (await t.src()).trim() === (await ui.readProjectFile("awkward", ".archer/diagrams/er-awkward.mmd")).trim(),
  }));
  let r = 0;
  while ((await t.toolbar("Redo").isEnabled()) && r < 40) {
    await ui.redo();
    r++;
  }
  await t.probe("redo all", async () => ({ r }));
  await ui.save();
  await step("saved", async () => {
    const f = await ui.readProjectFile("awkward", ".archer/diagrams/er-awkward.mmd");
    console.log("SAVED_ER\n" + f);
    expect(f).toContain("%% Labels, keys, comments");
    expect(f).toContain('string email UK "lower-cased, unique"');
    expect(f).toContain("style CUSTOMER fill:#fff");
  });
};
