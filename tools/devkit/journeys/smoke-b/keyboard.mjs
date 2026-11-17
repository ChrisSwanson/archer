import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-keyboard", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const active = () =>
    page.evaluate(() => {
      const e = document.activeElement;
      return e
        ? `${e.tagName.toLowerCase()}${e.getAttribute("role") ? "[" + e.getAttribute("role") + "]" : ""} "${(e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50)}"`
        : "none";
    });
  const tabs = async (n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      await page.keyboard.press("Tab");
      seen.push(await active());
    }
    return seen;
  };
  // Structured families open canvas-only: read the source whether the pane is open or not.
  const src = () => ui.editorSource();
  for (const [fam, slug, p, first] of [
    ["ER", "awkward", "diagrams/er-awkward.mmd", "ORDER"],
    ["state", "awkward", "diagrams/state-composite.mmd", "Idle"],
    ["seq", "journeys", "diagrams/seq.mmd", "s"],
  ]) {
    await step(`${fam}: tab order from page top`, async () => {
      await ui.resetProject(slug);
      await ui.openDiagram(slug, p, { edit: true });
      await q.quiet(300);
      await page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true }).focus();
      const seen = await tabs(32);
      console.log("PROBE", fam, "tab sequence after Save:", JSON.stringify(seen));
    });
  }
  // ER keyboard: focus node via tab stop, Enter selects?, F2/Enter rename, Delete, arrows
  await step("ER keyboard: select ORDER via tab stop and Enter, rename with Enter", async () => {
    await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
    await q.quiet(300);
    const stop = page
      .locator('.react-flow__node[tabindex="0"], [data-archer-stop], .archer-node[tabindex="0"]')
      .first();
    console.log(
      "PROBE ER tab-stop element:",
      await stop.evaluate((e) => e.outerHTML.slice(0, 200)).catch(() => "none"),
    );
    await stop.focus().catch(() => {});
    console.log("PROBE ER focused:", await active());
    await page.keyboard.press("Enter");
    await q.quiet(200);
    console.log(
      "PROBE after Enter: selected nodes",
      JSON.stringify(
        await page.locator(".react-flow__node.selected").evaluateAll((e) => e.map((x) => x.getAttribute("data-id"))),
      ),
      "editor open",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Enter");
    await q.quiet(200);
    console.log(
      "PROBE after 2nd Enter: editor open",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    if (
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false)
    ) {
      await page.keyboard.press("Control+a");
      await page.keyboard.type("Ordr ? c d");
      await page.keyboard.press("Enter");
      await q.quiet(300);
      console.log(
        "PROBE after type: focus",
        await active(),
        "src has:",
        (await src()).split("\n").filter((l) => /Ordr/.test(l)),
      );
    }
    // shortcuts while typing
    await ui.rename("CUSTOMER", "a?b c");
    console.log(
      "PROBE rename with ?/c chars OK; src:",
      (await src()).split("\n").filter((l) => /a\?b/.test(l)),
      "shortcut dialog open:",
      await page.getByRole("dialog").count(),
    );
  });
  // typing in inputs: shortcut keys
  await step("typing 'c', '?', Delete, Backspace inside the label input", async () => {
    await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
    await q.quiet(300);
    const n = ui.locators.node("Report");
    await n.dblclick();
    const inp = ui.locators.openLabelInput();
    await expect(inp).toBeVisible();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("c?x");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    console.log(
      "PROBE input value:",
      await inp.inputValue(),
      "| node still there:",
      await ui.locators.node("Report").count(),
      "| shortcuts dialog:",
      await page.getByRole("dialog").count(),
      "| connect menu:",
      await page.getByRole("menu").count(),
    );
    await page.keyboard.press("Escape");
    await q.quiet(300);
    console.log(
      "PROBE after Escape: editor open:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      "label now:",
      await ui.locators.node("Report").textContent(),
    );
    console.log("PROBE focus after Escape:", await active());
  });
  await step("seq: keyboard-only message draw via Connect to…", async () => {
    await ui.resetProject("journeys");
    await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
    await q.quiet(300);
    await ui.select("c");
    await t.toolbar("Connect to…").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    console.log(
      "PROBE connect menu items:",
      JSON.stringify(await page.getByRole("menuitem").allTextContents()),
      "focus:",
      await active(),
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await q.quiet(500);
    console.log(
      "PROBE after pick: editor open",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      "focus",
      await active(),
    );
    if (
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false)
    ) {
      await page.keyboard.type("kbd msg");
      await page.keyboard.press("Enter");
      await q.quiet(400);
    }
    console.log(
      "PROBE src:",
      (await src())
        .split("\n")
        .filter((l) => /->/.test(l))
        .join(" | "),
      "focus after commit:",
      await active(),
    );
  });
  await step("seq: Escape in menu, Escape in editor then Save enabled?", async () => {
    await ui.select("c");
    await t.toolbar("Connect to…").click();
    await page.keyboard.press("Escape");
    console.log("PROBE menu open after Esc:", await page.getByRole("menu").count(), "focus:", await active());
  });
};
