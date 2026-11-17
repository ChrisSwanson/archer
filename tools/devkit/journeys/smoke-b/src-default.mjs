// smoke-b: what the editor opens with. Every family the canvas edits opens canvas-only: the Source toggle is there,
// not pressed, and no source pane, no diagnostics, nothing busy once settled.
import { KNOWN } from "./lib.mjs";
export const meta = { name: "smoke-b-src-default", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  for (const [slug, path] of [
    ["awkward", "diagrams/er-awkward.mmd"],
    ["awkward", "diagrams/state-composite.mmd"],
    ["awkward", "diagrams/seq-awkward.mmd"],
    ["journeys", "diagrams/flow.mmd"],
    ["journeys", "diagrams/seq.mmd"],
    ["pageturner", "diagrams/containers.mmd"],
  ]) {
    await ui.openDiagram(slug, path, { edit: true });
    await step(`${path}: opens canvas-only`, async () => {
      const toggle = page
        .getByRole("banner")
        .or(ui.locators.editor())
        .getByRole("button", { name: "Mermaid source", exact: true })
        .first();
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveText("Source");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator("#authoring-source")).toHaveCount(0);
      const diagnostics = await page.locator(".authoring-diagnostics li").allTextContents();
      console.log("PROBE", path, "diagnostics:", JSON.stringify(diagnostics));
      await expect(page.locator(".authoring-preview")).toHaveAttribute("aria-busy", "false");
    });
    await ui.cancel({ discard: true });
  }
};
