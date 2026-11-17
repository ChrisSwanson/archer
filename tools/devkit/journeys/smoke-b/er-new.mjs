import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-er-new", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const lines = async (re) => (await t.src()).split("\n").filter((l) => re.test(l));
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(900);
  };
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-b-er-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "Entity relationship", saveAs: path });
  await t.shot("ernew-0-empty");
  const a = await ui.addPart("Entity", { name: "User" });
  const b = await ui.addPart("Entity", { name: "Post" });
  const c = await ui.addPart("Entity", { name: "Tag" });
  await t.shot("ernew-1-three");
  await t.probe("positions of 3 new entities", async () =>
    page
      .locator(".react-flow__node")
      .evaluateAll((e) =>
        e.map((n) => [
          n.getAttribute("data-id"),
          Math.round(n.getBoundingClientRect().x),
          Math.round(n.getBoundingClientRect().y),
        ]),
      ),
  );
  await fit();
  await t.part("One to many").click();
  await t.gconnect(a, b);
  let inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.fill("writes");
    await inp.press("Enter");
    await ui.settle();
  }
  await fit();
  await t.part("Many to many").click();
  await t.gconnect(b, c);
  inp = ui.locators.openLabelInput();
  if (await inp.isVisible().catch(() => false)) {
    await inp.press("Enter");
    await ui.settle();
  } // empty label
  await t.probe("lines (empty label ok?)", async () => ({ l: await lines(/--/), al: await t.alerts() }));
  await fit();
  await t.part("One to one").click();
  // keyboard-only connect via Connect to… (keyboard: Tab to node, Enter?)
  await ui.select(c);
  await t.toolbar("Connect to…").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await ui.settle();
  await t.probe("keyboard Connect to", async () => ({
    l: await lines(/--/),
    editorOpen: await ui.locators
      .openLabelInput()
      .isVisible()
      .catch(() => false),
  }));
  await page.keyboard.press("Enter");
  await ui.settle();
  await t.shot("ernew-2-connected");
  // rename entity w/ id special chars
  await ui.rename(a, "User & Co (admin)");
  await t.probe("special label", async () => lines(/ENTITY|User/));
  await ui.rename(b, "");
  await t.probe("empty rename", async () => ({ l: await lines(/ENTITY_2|Post/), al: await t.alerts() }));
  // Save with empty entity attributes: file
  await ui.save();
  await step("saved new ER", async () => {
    const f = await ui.readProjectFile("journeys", `.archer/${path}`);
    console.log("SAVED_ER_NEW\n" + f);
    expect(f).toMatch(/^erDiagram/m);
  });
  // reopen existing to check it renders and editing works
  await ui.openDiagram("journeys", path, { edit: true });
  await t.shot("ernew-3-reopen");
};
