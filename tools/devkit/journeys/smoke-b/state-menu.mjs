import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-menu", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page } = ctx;
  const t = tools(ctx);
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(700);
  };
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  await fit();
  const viaMenu = async (from, textRe) => {
    await ui.select(from);
    await t.toolbar("Connect to…").click();
    const menu = page.getByRole("menu", { name: /^Connect .* to$/ });
    const items = await menu.getByRole("menuitem").allTextContents();
    const item = menu.getByRole("menuitem").filter({ hasText: textRe }).first();
    if (!(await item.count())) {
      console.log("PROBE no menu item for", textRe, "among", JSON.stringify(items));
      await page.keyboard.press("Escape");
      return;
    }
    await item.click();
    await ui.settle();
    const open = await ui.locators
      .openLabelInput()
      .isVisible()
      .catch(() => false);
    console.log(
      "PROBE menu",
      from,
      "->",
      textRe,
      "editor:",
      open,
      "alerts:",
      JSON.stringify(await t.alerts()),
      "lines:",
      JSON.stringify((await t.src()).split("\n").filter((l) => new RegExp(`^\\s*${from} -->`).test(l))),
    );
    if (open) await page.keyboard.press("Enter");
    await ui.settle();
  };
  await viaMenu("Idle", /^Split$/);
  await viaMenu("Report", /^Notify$/);
  await viaMenu("Idle", /^Fetch/);
  await viaMenu("Idle", /^Working$/);
  await viaMenu("Report", /^start$/);
  await t.probe("menu for Report (items)", async () => {
    await ui.select("Report");
    await t.toolbar("Connect to…").click();
    const m = page.getByRole("menu");
    const r = await m.getByRole("menuitem").allTextContents();
    await page.keyboard.press("Escape");
    return r;
  });
  // menu for a start marker / composite / choice
  for (const id of ["root_start", "Working", "Route", "Merge"])
    await t.probe(`Connect to… enabled for ${id}`, async () => {
      await ui.select(id).catch(() => {});
      return await t.toolbar("Connect to…").isEnabled();
    });
  // keyboard: focus canvas node, Tab?
};
