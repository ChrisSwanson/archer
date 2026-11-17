import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-choice", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const tail = async (n = 6) => (await t.src()).trim().split("\n").slice(-n);
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-b-state-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "State", saveAs: path });
  await ui.addPart("State", { name: "Idle" });
  await step("click Choice (no typing)", async () => {
    await t.part("Choice").click();
    await page.waitForTimeout(800);
    console.log(
      "PROBE after Choice click: input open",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      JSON.stringify(await t.alerts()),
    );
    console.log(
      "PROBE alert box",
      JSON.stringify(
        await page
          .locator(".authoring-error")
          .first()
          .boundingBox()
          .catch(() => null),
      ),
      "viewport",
      JSON.stringify(page.viewportSize()),
      "source pane open:",
      await page.locator("#authoring-source").count(),
    );
    await t.shot("choice-1");
    const inp = ui.locators.openLabelInput();
    if (await inp.isVisible().catch(() => false)) {
      console.log("PROBE input value:", await inp.inputValue(), await inp.getAttribute("aria-label"));
      await inp.fill("Ok?");
      await inp.press("Enter");
      await page.waitForTimeout(800);
    }
    console.log(
      "PROBE after Enter",
      JSON.stringify(await tail(4)),
      JSON.stringify(await t.alerts()),
      "save enabled:",
      await page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true }).isEnabled(),
    );
    await t.shot("choice-2");
  });
  await step("click Choice again then Escape", async () => {
    await t.part("Choice").click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    console.log(
      "PROBE after Esc",
      JSON.stringify(await tail(4)),
      JSON.stringify(await t.alerts()),
      "save enabled:",
      await page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true }).isEnabled(),
    );
  });
};
