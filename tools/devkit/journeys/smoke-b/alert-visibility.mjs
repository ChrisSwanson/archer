import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-alert-visibility", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const vis = async (label) =>
    console.log(
      "PROBE",
      label,
      JSON.stringify(
        await page.evaluate(() => {
          const a = document.querySelector(".authoring-error");
          if (!a) return { present: false };
          const r = a.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + 20, Math.min(r.y + r.height / 2, innerHeight - 2));
          return {
            present: true,
            text: a.textContent.slice(0, 80),
            y: Math.round(r.y),
            h: Math.round(r.height),
            innerHeight,
            topElementIsAlert: !!top?.closest(".authoring-error"),
            topEl: top?.tagName + "." + top?.className,
            srcOpen: !!document.querySelector("#authoring-source"),
          };
        }),
      ),
    );
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
  console.log("PROBE source pane open at load:", await page.locator("#authoring-source").count());
  await page.keyboard.press("Escape");
  await ui.select("PRODUCT");
  await ui.deleteSelected();
  await page.waitForTimeout(400);
  await vis(
    "existing ER, delete referenced (source " +
      ((await page.locator("#authoring-source").count()) ? "open" : "closed") +
      ")",
  );
  await t.shot("alert-er-existing");
  await ui.cancel({ discard: true });
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  console.log("PROBE source pane open at load (state):", await page.locator("#authoring-source").count());
  await ui.select("Idle");
  await ui.deleteSelected();
  await page.waitForTimeout(400);
  await vis("existing state");
  await page.getByRole("button", { name: "Fit view" }).click();
  await page.waitForTimeout(500);
  await t.shot("alert-state-existing");
  // explicitly closed
  const tg = page
    .getByRole("region", { name: "Diagram Editor" })
    .getByRole("button", { name: "Mermaid source", exact: true });
  if ((await tg.count()) > 0 && (await tg.getAttribute("aria-pressed")) === "true") {
    await tg.click();
    await page.waitForTimeout(300);
  }
  await vis("state, source toggled closed");
  await t.shot("alert-state-closed");
};
