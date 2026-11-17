// smoke-a: framing of new shapes and Fit view on a new diagram (bug class 3).
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-flow-framing", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  await ui.resetProject("journeys");
  await ui.newDiagram("journeys", { type: "Flowchart", saveAs: `diagrams/smoke-a-fr-${Date.now().toString(36)}.mmd` });
  const report = (t) =>
    step(`viewport ${t}`, async () => {
      const r = await page.evaluate(() => {
        const vp = document.querySelector(".react-flow__viewport")?.style.transform;
        const host = document.querySelector(".react-flow")?.getBoundingClientRect();
        const nodes = [...document.querySelectorAll(".react-flow__node")].map((n) => {
          const b = n.getBoundingClientRect();
          return {
            id: n.getAttribute("data-id"),
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(b.width),
            inView: b.x >= host.x && b.right <= host.right && b.y >= host.y && b.bottom <= host.bottom,
          };
        });
        return {
          vp,
          host: host && {
            x: Math.round(host.x),
            y: Math.round(host.y),
            w: Math.round(host.width),
            h: Math.round(host.height),
          },
          nodes,
        };
      });
      console.log(`NOTE ${t}: ${JSON.stringify(r)}`);
    });
  await report("empty");
  for (const [p, n] of [
    ["Process", "A"],
    ["Decision", "B"],
    ["Start / end", "C"],
    ["Subroutine", "D"],
    ["Database", "E"],
  ]) {
    await ui.addPart(p, { name: n });
    await report(`after add ${n}`);
  }
  await h.fit();
  await report("after Fit view");
  await h.shot("framing-after-fit");
  await h.btnIfEnabled("Reset layout");
  await report("after reset layout");
  await h.fit();
  await report("fit after reset");
  await h.shot("framing-fit-after-reset");
};
