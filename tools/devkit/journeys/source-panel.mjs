// Reading page Source panel: open it, Copy (clipboard must equal the file), Edit source (opens
// ?edit&source), change the Mermaid text in the editor, check the canvas follows, Save.
import { KNOWN } from "./flowchart-create.mjs";
export const meta = { name: "source-panel", invariants: KNOWN };

export default async ({ ui, step, expect, page }) => {
  await ui.resetProject("journeys");
  const original = await ui.readProjectFile("journeys", ".archer/diagrams/flow.mmd");
  await ui.openDiagram("journeys", "diagrams/flow.mmd");
  // The canvas' archer:interactive mark, then two frames, before the first toolbar click: on a page that draws its
  // toolbar again when the diagram arrives (v0.10.0, known failure O186) a click before then lands on whatever moved
  // under the pointer (the tools launcher), not on Source.
  await step("canvas interactive", async () => {
    await page.waitForFunction(() => performance.getEntriesByName("archer:interactive").length > 0, null, {
      timeout: 15_000,
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  });
  const shown = await ui.openSourcePanel();
  await step("panel shows the file's exact source", () => expect(shown.trimEnd()).toBe(original.trimEnd()));
  const copied = await ui.copySource();
  await step("Copy puts the exact source on the clipboard", () => expect(copied.trimEnd()).toBe(original.trimEnd()));
  await ui.editSourceFromPanel();
  await step("editor opened with ?edit&source and the same text", async () => {
    const q = new URL(page.url()).searchParams;
    expect(q.has("edit") && q.has("source")).toBe(true);
    expect((await ui.editorSource()).trimEnd()).toBe(original.trimEnd());
  });
  const edited = original.trimEnd() + "\n  c[(Cache)]\n  b reads@-.->|lookup| c\n";
  await ui.setEditorSource(edited);
  await step("canvas follows the typed source", () => expect(ui.locators.node("c")).toBeVisible());
  await ui.save();
  await step("saved bytes equal the typed source", async () => {
    expect(await ui.readProjectFile("journeys", ".archer/diagrams/flow.mmd")).toBe(edited);
  });
  await step("reading page Source panel shows the saved text", async () => {
    const text = await ui.openSourcePanel();
    expect(text).toContain("Cache");
  });
};
