import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-new", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(700);
  };
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-b-state-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "State", saveAs: path });
  const a = await ui.addPart("State", { name: "Idle" });
  const b = await ui.addPart("State", { name: "Busy" });
  await fit();
  await ui.select(a);
  await t.part("Start").click();
  await q.quiet(400);
  await t.part("Transition").click();
  await t.gconnect(a, b);
  let i = ui.locators.openLabelInput();
  if (await i.isVisible().catch(() => false)) {
    await i.fill("start work");
    await i.press("Enter");
    await ui.settle();
  }
  await fit();
  await t.gconnect(b, a);
  i = ui.locators.openLabelInput();
  if (await i.isVisible().catch(() => false)) {
    await i.fill("done");
    await i.press("Enter");
    await ui.settle();
  }
  await ui.select(b);
  await t.part("End").click();
  await q.quiet(400);
  await t.shot("statenew-1");
  console.log(
    "PROBE nodes",
    JSON.stringify(await page.locator(".react-flow__node").evaluateAll((e) => e.map((x) => x.getAttribute("data-id")))),
  );
  await ui.save();
  await step("saved state", async () =>
    console.log("PROBE saved:", JSON.stringify(await ui.readProjectFile("journeys", `.archer/${path}`))),
  );
};
