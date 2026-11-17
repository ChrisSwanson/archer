// smoke-a: new flowchart from empty: every shape, every line kind, Connect to…, rename, reattach, move, reset, delete, undo/redo, type change, save, reopen.
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-flow-new", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-a-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "Flowchart", saveAs: path });
  const ids = {};
  for (const [part, name] of [
    ["Process", "Proc"],
    ["Decision", "Dec"],
    ["Start / end", "Term"],
    ["Subroutine", "Sub"],
    ["Database", "Db"],
  ])
    ids[part] = await ui.addPart(part, { name });
  const [a, b, c, d, e] = Object.values(ids);
  await h.shot("flow-new-1-five-shapes");
  await h.panBy(-560);
  await h.shot("flow-new-1c-panned");
  // each line kind
  const e1 = await ui.connect(a, b);
  await h.part("Dashed");
  const e2 = await ui.connect(b, c);
  await h.part("Thick");
  const e3 = await ui.connect(c, d);
  await h.part("Labelled");
  let e4;
  await step("Labelled connect: drag", async () => {
    e4 = await ui.connect(d, e);
  });
  await step("labelled connect opens label field", async () => {
    const input = ui.locators.openLabelInput();
    const vis = await input.isVisible().catch(() => false);
    console.log(
      "NOTE label field open after Labelled connect:",
      vis,
      vis ? await input.getAttribute("aria-label") : "",
    );
    if (vis) {
      await input.fill("yes");
      await input.press("Enter");
    }
  });
  await h.src("after 4 connections");
  // Connect to… from menu: select node then use menu
  await h.part("Arrow");
  await ui.select(a);
  await step("Connect to… menu a → d", async () => {
    await h.toolbar.getByRole("button", { name: "Connect to…" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    console.log("NOTE connect menu:", (await menu.allTextContents()).join("|"));
    await menu.getByRole("menuitem", { name: /Sub/ }).click();
    await ui.settle();
  });
  await h.src("after Connect to");
  // rename nodes by dblclick
  await ui.rename(a, "Proc renamed");
  // rename edge by double-click on its label / path
  await step("rename edge e1 by double-click", async () => {
    const lbl = page.locator(`.react-flow__edge[data-id="${e1}"]`);
    const p = await lbl.locator(".react-flow__edge-path").boundingBox();
    await page.mouse.dblclick(p.x + p.width / 2, p.y + p.height / 2);
    const input = ui.locators.openLabelInput();
    const vis = await input.isVisible({ timeout: 2000 }).catch(() => false);
    console.log("NOTE dblclick on edge opens editor:", vis);
    if (vis) {
      await input.fill("go");
      await input.press("Enter");
      await ui.settle();
    } else {
      console.log(
        "NOTE edge dblclick -> zoom/none; labels:",
        await page.locator(".react-flow__edge-textwrapper, .react-flow__edge-text").allTextContents(),
      );
    }
  });
  await h.src("after renames");
  await h.shot("flow-new-2-connected");
  // move + reset layout
  await ui.moveNode(c, 120, 80);
  await h.src("after move");
  await h.btn("Reset layout");
  await h.src("after reset layout");
  // reattach: e2 target c -> e
  await ui.reattachEdge(e2, "target", e);
  await h.src("after reattach e2 target->e");
  await ui.reattachEdge(e1, "source", c);
  await h.src("after reattach e1 source->c");
  // undo/redo chain
  for (let i = 0; i < 3; i++) await ui.undo();
  await h.src("after 3 undos");
  for (let i = 0; i < 3; i++) await ui.redo();
  await h.src("after 3 redos");
  // delete edge
  await h.selectEdge(e3);
  await ui.deleteSelected();
  await h.src("after delete edge e3");
  // delete connected node
  await ui.select(d);
  await ui.deleteSelected();
  await step("alerts after delete connected node", async () =>
    console.log("NOTE alerts:", JSON.stringify(await h.alert())),
  );
  await h.shot("flow-new-3-delete-connected");
  await h.src("after delete connected node");
  // add unconnected + delete
  const f = await ui.addPart("Process", { name: "Lonely" });
  await ui.select(f);
  await ui.deleteSelected();
  await h.src("after delete unconnected");
  await ui.undo();
  await h.src("after undo delete unconnected");
  // type change via dropdown (with content)
  await step("type dropdown with content", async () => {
    const sel = page
      .locator(".authoring-workspace")
      .first()
      .locator("label")
      .filter({ hasText: /^\s*Type/ })
      .locator("select");
    await sel.selectOption({ label: "Sequence" });
    const dlg = page.getByRole("alertdialog");
    console.log(
      "NOTE type switch with content dialog:",
      await dlg.isVisible().catch(() => false),
      (await dlg.allTextContents()).join("|"),
    );
    await h.shot("flow-new-4-type-switch");
    if (await dlg.isVisible().catch(() => false))
      await dlg
        .getByRole("button", { name: /Keep|Cancel/ })
        .first()
        .click();
  });
  await ui.save();
  await step("saved file", async () =>
    console.log("--- SAVED\n" + (await ui.readProjectFile("journeys", `.archer/${path}`))),
  );
  await step("landed on reading page", async () => {
    console.log("NOTE url", page.url());
    await expect(page.locator(".archer-reader-tools")).toBeVisible();
  });
  await ui.enterEdit();
  await h.src("reopened");
  await ui.cancel();
};
