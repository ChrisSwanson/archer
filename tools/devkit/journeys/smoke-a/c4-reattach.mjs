// smoke-a: C4 relationship end reattach (drag the selected relationship's end onto another element).
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-c4-reattach", invariants: KNOWN, viewport: { width: 1440, height: 1800 } };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  await ui.resetProject("pageturner");
  await ui.openDiagram("pageturner", "diagrams/containers.mmd", { edit: true });
  await h.fit();
  await h.shot("c4r-1-open");
  const eid = "web--api";
  await h.selectEdge(eid);
  await step("report updater geometry", async () => {
    const info = await page.evaluate((eid) => {
      const e = document.querySelector(`.react-flow__edge[data-id="${eid}"]`);
      return {
        cls: e.getAttribute("class"),
        updaters: [...e.querySelectorAll("[class*=edgeupdater]")].map((u) => {
          const b = u.getBoundingClientRect();
          return { cls: u.getAttribute("class"), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) };
        }),
      };
    }, eid);
    console.log("NOTE updaters", JSON.stringify(info));
  });
  await h.shot("c4r-2-selected");
  await h.reattach(eid, "target", "jobs", "body");
  await h.src("c4r after body drop");
  await ui.undo();
  await h.reattach(eid, "target", "jobs", "handle");
  await h.src("c4r after reattach web--api target -> jobs");
  await h.shot("c4r-3-after");
};
