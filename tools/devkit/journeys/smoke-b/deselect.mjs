import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-deselect", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page } = ctx;
  const t = tools(ctx);
  const selected = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".react-flow__node.selected, .react-flow__edge.selected, .archer-seq-selected, [data-selected=true], .selected",
        ),
      ].map((e) => (e.getAttribute("data-id") || e.getAttribute("data-seq-id") || e.className.toString()).slice(0, 40)),
    );
  for (const [slug, path, id] of [
    ["journeys", "diagrams/flow.mmd", "a"],
    ["awkward", "diagrams/er-awkward.mmd", "ORDER"],
    ["awkward", "diagrams/state-composite.mmd", "Notify"],
    ["journeys", "diagrams/seq.mmd", "c"],
  ]) {
    await ui.openDiagram(slug, path, { edit: true });
    await ui.select(id);
    console.log("PROBE", path, "selected after click:", JSON.stringify(await selected()));
    // empty pane click: bottom-middle of the canvas area
    const box = await page.locator(".authoring-preview").boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height - 25);
    await page.waitForTimeout(300);
    console.log("PROBE", path, "after empty-pane click:", JSON.stringify(await selected()));
    await ui.select(id);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    console.log("PROBE", path, "after Escape:", JSON.stringify(await selected()));
    await ui.cancel({ discard: true }).catch(() => {});
  }
};
