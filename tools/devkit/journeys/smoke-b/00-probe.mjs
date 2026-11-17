// Probe: open an awkward ER diagram in edit mode, dump buttons/roles and screenshot.
import { KNOWN } from "../flowchart-create.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const meta = { name: "smoke-b-probe", invariants: KNOWN };
const SH = join(process.env.ARCHER_JOURNEY_SHOTS ?? join(tmpdir(), "archer-journey-shots"), "smoke-b");
export default async ({ ui, step, page, expect }) => {
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/er-awkward.mmd", { edit: true });
  await step("dump", async () => {
    const btns = await page
      .getByRole("button")
      .evaluateAll((e) => e.map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 40)));
    console.log("BUTTONS", JSON.stringify(btns));
    const nodes = await page.locator(".react-flow__node").evaluateAll((e) => e.map((b) => b.getAttribute("data-id")));
    const edges = await page.locator(".react-flow__edge").evaluateAll((e) => e.map((b) => b.getAttribute("data-id")));
    console.log("NODES", nodes, "EDGES", edges);
    await page.screenshot({ path: SH + "/er-open.png" });
  });
};
