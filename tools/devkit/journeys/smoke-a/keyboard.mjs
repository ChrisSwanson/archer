// smoke-a: keyboard-only editing of a new flowchart and a new C4 (Tab to parts, Enter, typing shortcuts in label field, Escape, Delete, Ctrl+Z, Connect to… menu).
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-keyboard", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const k = page.keyboard;
  const active = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a
        ? `${a.tagName.toLowerCase()}${a.getAttribute("aria-label") ? `[${a.getAttribute("aria-label")}]` : ""}${a.className && typeof a.className === "string" ? "." + a.className.split(" ")[0] : ""}${a.textContent && a.tagName === "BUTTON" ? ` "${a.textContent.trim().slice(0, 20)}"` : ""}`
        : "none";
    });
  const tabTo = async (pred, max = 60) => {
    for (let i = 1; i <= max; i++) {
      await k.press("Tab");
      const a = await active();
      if (pred(a)) return { i, a };
    }
    return null;
  };
  for (const [type, firstPart, secondPart] of [
    ["Flowchart", "Process", "Decision"],
    ["C4 container", "Person", "Container"],
  ]) {
    await h.note(`===== ${type}`);
    await ui.resetProject("journeys");
    await ui.newDiagram("journeys", { type, saveAs: `diagrams/smoke-a-kb-${Date.now().toString(36)}.mmd` });
    // start from body focus after the Save-as field: click on empty canvas area then Tab
    await step("Tab from Save-as to the parts bar", async () => {
      await page.getByLabel("Save as", { exact: true }).focus();
      const hit = await tabTo((a) => /Process|Person/.test(a) && /button/.test(a));
      console.log("NOTE tabs from Save-as to first part:", JSON.stringify(hit));
      const tb = await page.evaluate(() =>
        [...document.querySelectorAll(".authoring-parts button")]
          .map((b) => `${b.textContent.trim()}:${b.tabIndex}`)
          .join(","),
      );
      console.log("NOTE parts tabindexes:", tb);
    });
    await step(`Enter on "${firstPart}" adds and opens name editor with focus`, async () => {
      await k.press("Enter");
      const inp = ui.locators.openLabelInput();
      await expect(inp).toBeVisible();
      console.log("NOTE focus after add:", await active());
      // shortcut leakage while typing in the label field
      await k.type("c?1 Dd");
      console.log("NOTE typed 'c?1 Dd' value:", await inp.inputValue());
      await k.press("Delete");
      await k.press("Backspace");
      console.log(
        "NOTE after Delete+Backspace value:",
        await inp.inputValue(),
        "dialogs/menus:",
        await page.getByRole("menu").count(),
        await page.getByRole("dialog").count(),
      );
      await k.press("Enter");
      await ui.settle();
      console.log("NOTE nodes after commit:", (await h.nodes()).join(","), "focus:", await active());
    });
    await h.src(`${type} after first add`);
    await step("Escape in label field", async () => {
      await page.locator(".authoring-parts").getByRole("button", { name: secondPart, exact: true }).focus();
      await k.press("Enter");
      const inp = ui.locators.openLabelInput();
      await expect(inp).toBeVisible();
      await k.type("Typed then escaped");
      await k.press("Escape");
      await ui.settle();
      console.log(
        "NOTE after Escape: input visible?",
        await inp.isVisible().catch(() => false),
        "nodes:",
        (await h.nodes()).join(","),
        "focus:",
        await active(),
      );
    });
    await h.src(`${type} after Escape`);
    await step("Ctrl+Z / Ctrl+Shift+Z", async () => {
      await page
        .locator(".react-flow")
        .first()
        .focus()
        .catch(() => {});
      await k.press("Control+z");
      await ui.settle();
      console.log("NOTE after Ctrl+Z nodes:", (await h.nodes()).join(","));
      await k.press("Control+Shift+z");
      await ui.settle();
      console.log("NOTE after Ctrl+Shift+Z nodes:", (await h.nodes()).join(","));
      await k.press("Control+y");
      await ui.settle();
    });
    await step("Tab to a node and select with Enter/Space, then Delete", async () => {
      const nodeIds = await h.nodes();
      const n = ui.locators.node(nodeIds[nodeIds.length - 1]);
      await n.focus();
      console.log(
        "NOTE node focusable:",
        await page.evaluate(() => document.activeElement?.className?.toString().slice(0, 60)),
      );
      await k.press("Enter");
      await k.press("Space");
      console.log("NOTE selected after Enter/Space:", await page.locator(".react-flow__node.selected").count());
      await k.press("Delete");
      await ui.settle();
      console.log("NOTE after Delete nodes:", (await h.nodes()).join(","), "alerts", JSON.stringify(await h.alert()));
    });
    await step("keyboard Connect to… (select node, Tab to toolbar, Enter, menu with arrows, Escape)", async () => {
      const ids = await h.nodes();
      if (ids.length < 2) {
        console.log("NOTE fewer than two nodes", ids.join(","));
        return;
      }
      await ui.locators.node(ids[0]).focus();
      await k.press("Enter");
      console.log("NOTE selected count", await page.locator(".react-flow__node.selected").count());
      // The editing tools are one roving toolbar (APG): a single Tab stop, then ←/→ along it. Tab to the toolbar,
      // then arrow to Connect to…. Never press Enter on whatever happens to have focus: Enter on Save or a link
      // left the editor (the journey then waited out Cancel on the reading page).
      const inTools = () =>
        page.evaluate(() => document.activeElement?.closest('[role=toolbar][aria-label="Editing tools"]') != null);
      let hit = null;
      for (let i = 1; i <= 80 && !hit; i++) {
        await k.press("Tab");
        if (await inTools()) hit = { tabs: i, a: await active() };
      }
      if (!hit) throw new Error(`Tab never reached the Editing tools toolbar (focus: ${await active()})`);
      for (let i = 0; i < 20 && !/Connect to/.test(await active()); i++) await k.press("ArrowRight");
      const at = await active();
      console.log("NOTE Tab reaches Editing tools:", JSON.stringify(hit), "arrows reach:", at);
      if (!/Connect to/.test(at))
        throw new Error(`arrow keys in Editing tools never reached Connect to… (focus: ${at})`);
      await k.press("Enter");
      console.log("NOTE menu open:", await page.getByRole("menu").count(), "focus:", await active());
      await k.press("ArrowDown");
      console.log("NOTE after ArrowDown focus:", await active());
      await k.press("Escape");
      console.log("NOTE after Escape menu:", await page.getByRole("menu").count(), "focus:", await active());
      await k.press("Enter");
      await k.press("Enter");
      await ui.settle();
      const ii = ui.locators.openLabelInput();
      if (await ii.isVisible().catch(() => false)) {
        console.log("NOTE label editor after connect focus:", await active());
        await k.press("Enter");
        await ui.settle();
      }
      console.log("NOTE edges:", (await h.edges()).join(","));
    });
    await h.src(`${type} after keyboard connect`);
    await step("keyboard: Escape with selection, Cancel via keyboard", async () => {
      await k.press("Escape");
      console.log(
        "NOTE selected after Escape:",
        await page.locator(".react-flow__node.selected, .react-flow__edge.selected").count(),
      );
    });
    await ui.cancel({ discard: true });
  }
};
