import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-er-dblclick", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  await ui.resetProject("awkward");
  for (const id of ["WAREHOUSE", "ADDRESS", "ORDER", "CUSTOMER", "PRODUCT"]) {
    for (const [name, fx, fy] of [
      ["center", 0.5, 0.5],
      ["top 12px", 0.5, null],
      ["left 20%", 0.2, 0.5],
      ["bottom 8px", 0.5, -1],
    ]) {
      await step(`dblclick ${id} ${name}`, async () => {
        await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
        await q.quiet(200);
        await page.getByRole("button", { name: "Fit view" }).click();
        await page.waitForTimeout(600);
        const b = await ui.locators.node(id).boundingBox();
        const x = b.x + b.width * fx,
          y = fy === null ? b.y + 12 : fy === -1 ? b.y + b.height - 8 : b.y + b.height * fy;
        await page.mouse.dblclick(x, y);
        await page.waitForTimeout(450);
        const open = await ui.locators
          .openLabelInput()
          .isVisible()
          .catch(() => false);
        console.log("PROBE", id, name, `box h=${Math.round(b.height)}`, "editor:", open);
      });
    }
  }
};
