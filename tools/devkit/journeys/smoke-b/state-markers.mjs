import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-markers", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const tail = async (n = 6) => (await t.src()).trim().split("\n").slice(-n);
  const msg = async () => ({
    al: await t.alerts(),
    sel: await page.locator(".react-flow__node.selected").evaluateAll((e) => e.map((x) => x.getAttribute("data-id"))),
  });
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-b-state-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "State", saveAs: path });
  await t.shot("st-0");
  const a = await ui.addPart("State", { name: "Idle" });
  const b = await ui.addPart("State", { name: "Running" });
  const nodesBefore = new Set(
    await page.locator(".react-flow__node").evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))),
  );
  // A choice has no name editor (nothing to name), so addPart has no id to return: take the node it added.
  const c =
    (await ui.addPart("Choice", { name: "Ok?" })) ??
    (await page.locator(".react-flow__node").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).find(
      (id) => !nodesBefore.has(id),
    );
  await t.probe("added ids", async () => ({ a, b, c, tail: await tail(8) }));
  await t.shot("st-1");
  // deselect by clicking empty canvas
  await page.mouse.click(1100, 450);
  await page.waitForTimeout(300);
  await t.probe("selection after canvas click", msg);
  await t.part("Start").click();
  await page.waitForTimeout(500);
  await t.probe("Start, nothing selected", async () => ({ ...(await msg()), tail: await tail(3) }));
  await t.shot("st-2-start-none");
  await t.part("End").click();
  await page.waitForTimeout(500);
  await t.probe("End, nothing selected", async () => ({ ...(await msg()), tail: await tail(3) }));
  await ui.select(a);
  await t.part("Start").click();
  await ui.settle();
  await t.probe("Start on Idle", async () => ({ ...(await msg()), tail: await tail(3) }));
  await t.part("End").click();
  await ui.settle();
  await t.probe("End on Idle (selected stays?)", async () => ({ ...(await msg()), tail: await tail(3) }));
  await ui.select(b);
  await t.part("End").click();
  await ui.settle();
  await t.probe("End on Running", async () => ({ ...(await msg()), tail: await tail(3) }));
  await ui.select(c);
  await t.part("Start").click();
  await ui.settle();
  await t.probe("Start on choice", async () => ({ ...(await msg()), tail: await tail(3) }));
  // click a [*] marker node and delete it
  await t.probe("marker nodes", async () =>
    page.locator(".react-flow__node").evaluateAll((e) => e.map((x) => x.getAttribute("data-id"))),
  );
  await t.shot("st-3-markers");
  await ui.select("root_start");
  await ui.deleteSelected();
  await t.probe("delete root_start marker", async () => ({ ...(await msg()), tail: await tail(6) }));
  await t.probe("dblclick start marker", async () => {
    await ui.locators.node("root_end").dblclick();
    await page.waitForTimeout(300);
    return {
      open: await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    };
  });
  await page.keyboard.press("Escape");
  await ui.save();
  await step("saved", async () => {
    console.log("SAVED_STATE_NEW\n" + (await ui.readProjectFile("journeys", `.archer/${path}`)));
  });
};
