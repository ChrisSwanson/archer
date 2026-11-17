// Exercises the helpers the three main journeys do not: edge-end reattach, delete, structure panel,
// Cancel with discard, a new Sequence diagram from New → Diagram, and dragging a message to reorder.
// Known finding: saving a new sequence diagram POSTs api/authoring/presentation and gets 409
// (shows as an http-errors warning).
import { KNOWN } from "./flowchart-create.mjs";
export const meta = { name: "helpers-tour", invariants: KNOWN };
export default async ({ ui, step, expect, page }) => {
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/flow.mmd", { edit: true });
  const c = await ui.addPart("Database", { name: "Store" });
  await ui.reattachEdge("calls", "target", c);
  await step("calls now ends at store", async () => {
    await ui.toggleEditorSource();
    expect(await ui.editorSource()).toMatch(new RegExp(`a calls@-->\\|"?HTTP"?\\| ${c}`));
  });
  await ui.select("b");
  await ui.deleteSelected(); // b is unreferenced once calls moved to the new node
  await step("b gone (now unreferenced)", () => expect(ui.locators.node("b")).toHaveCount(0));
  await ui.toggleStructure();
  await ui.cancel({ discard: true });
  const seqPath = `diagrams/new-seq-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "Sequence", saveAs: seqPath });
  await ui.addPart("Participant", { name: "Alice" });
  await ui.addPart("Participant", { name: "Bob" });
  const m = await ui.seq.drawMessage("p1", "p2", { label: "hi" });
  const m2 = await ui.seq.drawMessage("p2", "p1", { label: "yo" });
  await ui.seq.moveMessage(m2, m);
  await step("order swapped", async () => expect((await ui.seq.messages()).map((x) => x.label)[0]).toMatch(/yo/));
  await ui.save();
  await step("file", async () => {
    const t = await ui.readProjectFile("journeys", `.archer/${seqPath}`);
    expect(t).toMatch(/p2->>p1: yo[\s\S]*p1->>p2: hi/);
  });
};
