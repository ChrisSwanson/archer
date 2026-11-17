// New → Diagram for every offered type: add something, Save to a path, land on the reading page showing it.
import { KNOWN } from "../flowchart-create.mjs";
export const meta = { name: "smoke-c-new-each-type", invariants: KNOWN, timeoutMs: 15000 };
const TYPES = [
  ["Flowchart", "Process", true],
  ["Sequence", "Participant", true],
  ["C4 container", null, true],
  ["State", null, true],
  ["Entity relationship", null, true],
];
export default async ({ ui, step, expect, page }) => {
  await ui.resetProject("journeys");
  const stamp = Date.now().toString(36);
  for (const [type] of TYPES) {
    const path = `diagrams/new-${type.split(" ")[0].toLowerCase()}-${stamp}.mmd`;
    await ui.newDiagram("journeys", { type, saveAs: path });
    // The parts bar differs per type: take the first button.
    const first = page.locator(".authoring-parts button").first();
    const label = ((await first.textContent()) ?? "").trim();
    await ui.addPart(label, { name: `Thing ${type}` });
    await ui.save();
    await step(
      `${type}: reading page shows the saved diagram (${page.url().replace(/^.*\/projects/, "/projects")})`,
      async () => {
        await expect(page.locator(".react-flow, .archer-seq-canvas, svg").first()).toBeVisible();
        await expect(page.locator("body")).toContainText(/Thing/);
        expect(page.url()).toContain(path.replace("diagrams/", "diagrams/"));
      },
    );
    await step(`${type}: file written`, async () => {
      const t = await ui.readProjectFile("journeys", `.archer/${path}`);
      expect(t.length).toBeGreaterThan(10);
    });
  }
};
