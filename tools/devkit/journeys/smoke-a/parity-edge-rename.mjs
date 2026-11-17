// smoke-a: family parity for renaming a connection by double-click (on its label, and on the line), then Escape.
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-parity-edge-rename",
  invariants: { ...KNOWN, warnings: { severity: "warn", reason: "recording" } },
  viewport: { width: 1440, height: 1500 },
};
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const k = page.keyboard;
  const cases = [
    ["journeys", "diagrams/flow.mmd", "flowchart"],
    ["pageturner", "diagrams/containers.mmd", "c4"],
    ["pageturner", "diagrams/order-lifecycle.mmd", "state"],
    ["pageturner", "diagrams/data-model.mmd", "er"],
  ];
  for (const [slug, file, fam] of cases) {
    await ui.resetProject(slug);
    await ui.openDiagram(slug, file, { edit: true });
    const edges = await h.edges();
    const e = edges[0];
    await h.note(fam, "first edge", e, "of", edges.length);
    const geo = await page.evaluate((e) => {
      const g = document.querySelector(`.react-flow__edge[data-id="${e}"]`);
      const p = g.querySelector(".react-flow__edge-path");
      const m = p.getScreenCTM();
      const q = p.getPointAtLength(p.getTotalLength() * 0.5);
      const lab = document.querySelector(
        `.react-flow__edgelabel-renderer [data-id="${e}"], [data-edge-label="${e}"], .react-flow__edge-textwrapper`,
      );
      const lb = lab?.getBoundingClientRect();
      const txt = [...document.querySelectorAll(".react-flow__edgelabel-renderer *, .react-flow__edge-text")]
        .filter((x) => x.children.length === 0 && x.textContent.trim())
        .slice(0, 3)
        .map((x) => {
          const b = x.getBoundingClientRect();
          return {
            t: x.textContent.trim().slice(0, 30),
            x: Math.round(b.x + b.width / 2),
            y: Math.round(b.y + b.height / 2),
          };
        });
      return {
        line: { x: Math.round(q.x * m.a + q.y * m.c + m.e), y: Math.round(q.x * m.b + q.y * m.d + m.f) },
        labels: txt,
      };
    }, e);
    console.log("NOTE geometry", fam, JSON.stringify(geo));
    for (const [what, pt] of [
      ["line midpoint", geo.line],
      ["label text", geo.labels[0]],
    ]) {
      if (!pt) {
        console.log(`NOTE ${fam} ${what}: no target`);
        continue;
      }
      await step(`${fam}: dblclick ${what}`, async () => {
        await page.mouse.dblclick(pt.x, pt.y);
        await page.waitForTimeout(400);
        const i = ui.locators.openLabelInput();
        const vis = await i.isVisible().catch(() => false);
        console.log(
          `NOTE ${fam} dblclick ${what} -> editor open: ${vis}${vis ? " value " + JSON.stringify(await i.inputValue()) + " aria " + (await i.getAttribute("aria-label")) : ""}`,
        );
        if (vis) await k.press("Escape");
        await page.waitForTimeout(200);
      });
    }
    await ui.cancel({ discard: true });
  }
};
