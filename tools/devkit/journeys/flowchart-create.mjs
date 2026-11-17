// New flowchart: add two parts, connect them, label the connection, rename a node, undo/redo, Save.
// Then assert the bytes Save wrote and reopen the saved diagram in edit mode.
// Known findings (2026-10-19), downgraded to warnings so the journey stays a regression signal for
// everything else; they still appear in summary.json "warnings":
//  - every page load fetches api/comments?target=<view> 3x and api/bootstrap 2x (duplicate-requests);
//  - after saving a new diagram the reading page made 44 API requests, 15 of them api/comments.
export const KNOWN = {
  "duplicate-requests": { severity: "warn", reason: "known: api/comments fetched 3x per page load" },
  "requests-per-view": {
    severity: "warn",
    reason: "known: >40 API requests on the reading page after saving a new diagram",
  },
};
export const meta = { name: "flowchart-create", invariants: KNOWN };

export default async ({ ui, step, expect }) => {
  await ui.resetProject("journeys");
  const path = `diagrams/smoke-flow-${Date.now().toString(36)}.mmd`;
  await ui.newDiagram("journeys", { type: "Flowchart", saveAs: path });
  const a = await ui.addPart("Process", { name: "Client" });
  const b = await ui.addPart("Decision", { name: "Authorised?" });
  const e = await ui.connect(a, b);
  await ui.renameEdge(e, "checks");
  await ui.rename(a, "Browser client");
  await ui.undo();
  await step("undo restored the old label", () => expect(ui.locators.node(a)).toContainText("Client"));
  await ui.redo();
  await step("redo re-applied the rename", () => expect(ui.locators.node(a)).toContainText("Browser client"));
  await ui.save();
  await step("saved file has both nodes and the labelled connection", async () => {
    const text = await ui.readProjectFile("journeys", `.archer/${path}`);
    expect(text).toMatch(/^flowchart/m);
    expect(text).toContain("Browser client");
    expect(text).toContain("Authorised?");
    expect(text).toMatch(/-->\|"?checks"?\|/);
  });
  await ui.enterEdit();
  await step("reopened editor shows both nodes", () => expect(ui.page.locator(".react-flow__node")).toHaveCount(2));
  await ui.cancel();
};
