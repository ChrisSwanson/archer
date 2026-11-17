import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-altkeys", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const show = async (l) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      l,
      JSON.stringify(s.messages.map((m) => m.split(":")[1])),
      "sel",
      JSON.stringify(s.selected),
      "active:",
      await page.evaluate(
        () =>
          document.activeElement?.tagName +
          "." +
          (document.activeElement?.getAttribute("class") || "").slice(0, 30) +
          "|" +
          (document.activeElement?.getAttribute("aria-label") || ""),
      ),
    );
  };
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await ui.select("msg-3");
  await show("selected msg-3 by click");
  await page.keyboard.press("Alt+ArrowUp");
  await show("Alt+Up (focus as left by click)");
  await page.keyboard.press("Alt+ArrowUp");
  await show("Alt+Up again");
  await page.keyboard.press("Alt+ArrowDown");
  await show("Alt+Down");
  // focus the Move up button, then keyboard Enter
  await t.toolbar("Move message up").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await show("Alt+Up with Move-up button focused");
  // keyboard-only selection of a message: Tab into canvas
  await page
    .locator(".archer-seq-svg, .archer-seq-viewport")
    .first()
    .focus()
    .catch(() => {});
  console.log(
    "PROBE after focusing svg:",
    await page.evaluate(
      () =>
        document.activeElement?.tagName +
        "." +
        (document.activeElement?.getAttribute("class") || "").slice(0, 40) +
        "|" +
        (document.activeElement?.getAttribute("aria-label") || ""),
    ),
  );
};
