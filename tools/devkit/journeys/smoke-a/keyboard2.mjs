// smoke-a: hotkeys in both families: Ctrl+Z/Y, Delete on a mouse-selected and a keyboard-focused node/edge, Space/Enter semantics on a focused node, Connect menu focus return.
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-keyboard2",
  invariants: { ...KNOWN, warnings: { severity: "warn", reason: "recording" } },
};
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const k = page.keyboard;
  const active = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a
        ? `${a.tagName.toLowerCase()}${a.getAttribute("aria-label") ? `[${a.getAttribute("aria-label")}]` : ""}.${(a.className?.toString() || "").split(" ")[0]}`
        : "none";
    });
  const nodesNow = async () => (await h.nodes()).join(",");
  for (const [type, parts] of [
    ["Flowchart", ["Process", "Process", "Process"]],
    ["C4 container", ["Container", "Container", "Container"]],
  ]) {
    await h.note(`===== ${type}`);
    await ui.resetProject("journeys");
    await ui.newDiagram("journeys", { type, saveAs: `diagrams/smoke-a-kb2-${Date.now().toString(36)}.mmd` });
    const ids = [];
    for (const p of parts) ids.push(await ui.addPart(p, { name: `N${ids.length + 1}` }));
    if (type === "Flowchart") await h.panBy(-300);
    const [a, b, c] = ids;
    await h.part(type === "Flowchart" ? "Arrow" : "Relationship");
    const e1 = await ui.connect(a, b);
    const ii = ui.locators.openLabelInput();
    if (await ii.isVisible().catch(() => false)) {
      await k.press("Enter");
      await ui.settle();
    }
    await step("Ctrl+Z with focus on body after clicking empty canvas", async () => {
      await page.mouse.click(700, 800);
      console.log("NOTE focus:", await active());
      await k.press("Control+z");
      await ui.settle();
      console.log("NOTE after Ctrl+Z edges:", (await h.edges()).join(","), "nodes:", await nodesNow());
      await k.press("Control+Shift+z");
      await ui.settle();
      console.log("NOTE after Ctrl+Shift+Z edges:", (await h.edges()).join(","));
      await k.press("Control+z");
      await ui.settle();
      await k.press("Control+y");
      await ui.settle();
      console.log("NOTE after Ctrl+Z, Ctrl+Y edges:", (await h.edges()).join(","));
    });
    await step("mouse-select node then Delete key", async () => {
      await ui.locators.node(c).click();
      await k.press("Delete");
      await ui.settle();
      console.log(
        "NOTE after Delete (mouse-selected unconnected node c) nodes:",
        await nodesNow(),
        "alerts",
        JSON.stringify(await h.alert()),
      );
      await k.press("Control+z");
      await ui.settle();
      console.log("NOTE after undo nodes:", await nodesNow());
    });
    await step("focus node then Space (select?) then Delete", async () => {
      await page.mouse.click(700, 800);
      await ui.locators.node(c).focus();
      await k.press("Space");
      console.log(
        "NOTE after Space: selected",
        await page.locator(".react-flow__node.selected").count(),
        "editor open",
        await ui.locators
          .openLabelInput()
          .isVisible()
          .catch(() => false),
        "focus",
        await active(),
      );
      await k.press("Delete");
      await ui.settle();
      console.log("NOTE after Delete nodes:", await nodesNow());
      await k.press("Control+z");
      await ui.settle();
    });
    await step("focus node then Enter opens rename; Escape closes; focus", async () => {
      await page.mouse.click(700, 800);
      await ui.locators.node(c).focus();
      await k.press("Enter");
      console.log(
        "NOTE after Enter: editor open",
        await ui.locators
          .openLabelInput()
          .isVisible()
          .catch(() => false),
        "focus",
        await active(),
      );
      await k.press("Escape");
      console.log(
        "NOTE after Escape: focus",
        await active(),
        "editor open",
        await ui.locators
          .openLabelInput()
          .isVisible()
          .catch(() => false),
      );
    });
    await step("empty / whitespace label commit", async () => {
      await ui.locators.node(c).dblclick();
      const inp = ui.locators.openLabelInput();
      await inp.fill("   ");
      await k.press("Enter");
      await ui.settle();
      // A refused label lingers read-only ~4 s (app bug, reported): let it close before opening the editor again.
      await expect(inp).toBeHidden({ timeout: 6000 });
      console.log(
        "NOTE whitespace label ->",
        await ui.locators.node(c).textContent(),
        "alerts",
        JSON.stringify(await h.alert()),
        "input still open",
        await inp.isVisible().catch(() => false),
      );
      if (await inp.isVisible().catch(() => false)) await k.press("Escape");
      await ui.locators.node(c).dblclick();
      const i2 = ui.locators.openLabelInput();
      await expect(i2).toBeVisible();
      // Already empty after the whitespace commit? Then there is nothing to clear (Playwright's fill("") would press
      // Delete in an empty field, which changes nothing and reads as a swallowed key).
      if (await i2.inputValue()) await i2.fill("");
      await k.press("Enter");
      await ui.settle();
      console.log(
        "NOTE empty label ->",
        await ui.locators.node(c).textContent(),
        "alerts",
        JSON.stringify(await h.alert()),
      );
      const ii3 = ui.locators.openLabelInput();
      if (await ii3.isVisible().catch(() => false)) await k.press("Escape");
    });
    await step("Delete key on a selected edge (mouse) and focused edge", async () => {
      await h.selectEdgeNow(e1);
      await k.press("Delete");
      await ui.settle();
      console.log("NOTE after Delete mouse-selected edge:", (await h.edges()).join(","));
      await k.press("Control+z");
      await ui.settle();
      await page.mouse.click(700, 800);
      await ui.locators.edge(e1).focus();
      await k.press("Space");
      console.log("NOTE edge after Space selected:", await page.locator(".react-flow__edge.selected").count());
      await k.press("Delete");
      await ui.settle();
      console.log("NOTE after Delete focused edge:", (await h.edges()).join(","));
    });
    await step("Connect to… menu: keyboard + focus return", async () => {
      await ui.locators.node(a).click();
      const btn = h.toolbar.getByRole("button", { name: "Connect to…" });
      await btn.focus();
      await k.press("Enter");
      console.log("NOTE menu items:", await page.getByRole("menuitem").count(), "focus:", await active());
      await k.press("ArrowDown");
      console.log("NOTE ArrowDown focus:", await active());
      await k.press("Tab");
      console.log("NOTE Tab focus:", await active());
      await k.press("Escape");
      console.log("NOTE Escape -> focus:", await active(), "menu open:", await page.getByRole("menu").count());
    });
    await ui.cancel({ discard: true });
  }
};
