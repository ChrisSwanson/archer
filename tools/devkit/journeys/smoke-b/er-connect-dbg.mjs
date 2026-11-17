import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-er-connect-dbg", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
  const e1 = await ui.addPart("Entity", { name: "Invoice" });
  await page.getByRole("button", { name: "Fit view" }).click();
  await page.waitForTimeout(1200);
  for (const [to, steps] of [
    ["ORDER", 20],
    ["ORDER", 60],
    ["ORDER", 20],
  ]) {
    await step("manual drag to " + to + " steps " + steps, async () => {
      const src = ui.locators.node(e1);
      await src.hover();
      const a = t.center(await src.locator(".react-flow__handle.source").boundingBox());
      const b = t.center(await ui.locators.node(to).locator(".react-flow__handle.target").boundingBox());
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(a.x + 8, a.y + 8, { steps: 3 });
      await page.mouse.move(b.x, b.y, { steps });
      await page.waitForTimeout(150);
      console.log(
        "TARGET CLASS",
        await ui.locators.node(to).locator(".react-flow__handle.target").getAttribute("class"),
      );
      await t.shot("mid-" + to + steps);
      await page.mouse.up();
      await ui.settle();
      await page.waitForTimeout(500);
      console.log("SRC", JSON.stringify((await t.src()).split("\n").filter((l) => /ENTITY_1/.test(l))));
    });
  }
};
