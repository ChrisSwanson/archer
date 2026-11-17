import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-conn-dbg", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page } = ctx;
  const t = tools(ctx);
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(900);
  };
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  await fit();
  for (const [from, to] of [
    ["Report", "Merge"],
    ["Report", "Working"],
    ["Idle", "Split"],
    ["Notify", "Run"],
  ]) {
    await step(`dbg ${from}->${to}`, async () => {
      const src = ui.locators.node(from);
      await src.hover();
      const a = t.center(await src.locator(".react-flow__handle.source").first().boundingBox());
      const handles = await ui.locators
        .node(to)
        .locator(".react-flow__handle")
        .evaluateAll((h) =>
          h.map(
            (x) =>
              x.className.replace("react-flow__handle ", "").slice(0, 40) +
              " " +
              JSON.stringify(x.getBoundingClientRect()),
          ),
        );
      console.log("PROBE handles of", to, JSON.stringify(handles));
      const tb = await ui.locators.node(to).locator(".react-flow__handle.target").first().boundingBox();
      const b = t.center(tb);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(a.x + 8, a.y + 8, { steps: 3 });
      await page.mouse.move(b.x, b.y, { steps: 50 });
      await page.waitForTimeout(300);
      console.log(
        "PROBE at-target class",
        await ui.locators.node(to).locator(".react-flow__handle.target").first().getAttribute("class"),
        "elementAtPoint:",
        await page.evaluate(
          ([x, y]) => {
            const e = document.elementFromPoint(x, y);
            return (
              e &&
              e.className.toString().slice(0, 60) + " | node=" + e.closest(".react-flow__node")?.getAttribute("data-id")
            );
          },
          [b.x, b.y],
        ),
      );
      await t.shot(`dbg-${from}-${to}`);
      await page.mouse.up();
      await ui.settle();
      await page.waitForTimeout(400);
      console.log(
        "PROBE result lines",
        JSON.stringify((await t.src()).split("\n").filter((l) => new RegExp(`${from} --> `).test(l))),
        "alerts",
        JSON.stringify(await t.alerts()),
      );
      await page.keyboard.press("Enter").catch(() => {});
    });
    await ui.cancel({ discard: true }).catch(() => {});
    await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
    await fit();
  }
};
