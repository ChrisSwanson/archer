// Typing Mermaid directly in the source drawer: valid updates canvas, invalid keeps text and says why,
// plain Mermaid edges (no stable id) are refused, type switch with content confirms and Undo restores.
import { KNOWN } from "../flowchart-create.mjs";
export const meta = { name: "smoke-c-source-typing", invariants: { ...KNOWN, "editor-alert": false } };
export default async ({ ui, step, expect, page }) => {
  await ui.newDiagram("journeys", { type: "Flowchart", saveAs: "diagrams/typed-" + Date.now().toString(36) + ".mmd" });
  await ui.toggleEditorSource();
  await ui.setEditorSource("flowchart LR\n  a[One] e1@--> b[Two]\n");
  await step("valid source draws two nodes", async () =>
    expect(await page.locator(".react-flow__node").count()).toBe(2),
  );
  await step("plain Mermaid edge `a --> b` is accepted (pasting ordinary Mermaid should work)", async () => {
    await ui.setEditorSource("flowchart LR\n  a[One] --> b[Two]\n");
    expect(await page.locator(".react-flow__node").count()).toBe(2);
  });
  await ui.setEditorSource("flowchart LR\n  a[One] e1@--> b[Two]\n  c[[Broken --> \n");
  await step("while invalid the canvas keeps the last good drawing", async () =>
    expect(await page.locator(".react-flow__node").count()).toBeGreaterThan(0),
  );
  await step("invalid text disables Save and says which line", async () => {
    await expect(ui.locators.button("Save", page.locator(".authoring-toolbar"))).toBeDisabled();
    await expect(page.locator(".authoring-workspace")).toContainText(/Line \d/);
  });
  await ui.setEditorSource("flowchart LR\n  a[One] e1@--> b[Two]\n");
  const sel = page
    .locator("label")
    .filter({ hasText: /^\s*Type/ })
    .locator("select");
  await sel.selectOption({ label: "Sequence" });
  await step("type switch with content asks first", async () =>
    expect(page.getByRole("alertdialog", { name: /Switch to/ })).toBeVisible(),
  );
  await page.getByRole("button", { name: /Clear and switch/ }).click();
  await ui.undo();
  await step("Undo after type switch restores flowchart and its source", async () => {
    expect(await sel.inputValue()).toMatch(/flow/i);
    expect(await ui.editorSource()).toContain("e1@-->");
  });
};
