// TG-ux4: open each of the five editor families on an existing diagram and keep its entry state, in light and dark,
// at 1440×900 and 1024×768. The harness's entry shots (shots/entry/<family>-<width>-<theme>.png) are the evidence;
// summary.json `entryShots[]` lists each with what it measured (source pane open, canvas and pane heights), and
// the step invariants (chrome-clipped, chrome-scrolls, chrome-overlap, alert-visible…) judge every entry.
// Read-only: nothing is edited or saved.
import { KNOWN } from "./flowchart-create.mjs";
export const meta = { name: "editor-entry", invariants: KNOWN };

export const FAMILIES = [
  ["flowchart", "journeys", "diagrams/flow.mmd"],
  ["sequence", "journeys", "diagrams/seq.mmd"],
  ["c4", "pageturner", "diagrams/containers.mmd"],
  ["state", "pageturner", "diagrams/order-lifecycle.mmd"],
  ["er", "pageturner", "diagrams/data-model.mmd"],
];
const VIEWPORTS = [
  [1440, 900],
  [1024, 768],
];
const THEMES = ["light", "dark"];

export default async ({ ui, step, expect, run }) => {
  for (const [width, height] of VIEWPORTS) {
    await ui.setViewport(width, height);
    for (const theme of THEMES) {
      await ui.setTheme(theme);
      for (const [family, slug, path] of FAMILIES) {
        await ui.openDiagram(slug, path, { edit: true }); // takes the entry shot once per family/width/theme
        await ui.cancel();
      }
    }
  }
  await step("every family has an entry shot per viewport and theme", async () => {
    const got = new Set((run.entryShots ?? []).map((s) => `${s.width}-${s.theme}`));
    expect(run.entryShots?.length ?? 0).toBe(FAMILIES.length * VIEWPORTS.length * THEMES.length);
    expect(got.size).toBe(VIEWPORTS.length * THEMES.length);
  });
};
