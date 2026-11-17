// smoke-a: existing C4 (boundaries, _Ext, Rel_*): rename, reattach (incl. onto a boundary), delete referenced/unreferenced, last element in boundary; diff the source.
import { KNOWN, mk } from "./lib.mjs";
export const meta = { name: "smoke-a-c4-existing", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const slug = "awkward",
    file = "diagrams/c4-boundaries.mmd",
    rel = `.archer/${file}`;
  await ui.resetProject(slug);
  const original = await ui.readProjectFile(slug, rel);
  await ui.openDiagram(slug, file, { edit: true });
  await h.note("nodes", (await h.nodes()).join(","), "edges", (await h.edges()).join(","));
  await h.shot("c4e-1-open");
  const diff = async (t) => {
    const cur = await h.src(t);
    const { udiff } = await import("./lib.mjs");
    console.log(`--- DIFF vs original (${t})\n${udiff(original, cur.replace(/\n$/, "\n"))}\n---`);
  };
  // rename element and relationship
  await ui.rename("web", "Web application");
  await diff("rename web");
  await step("rename rel web--api via keyboard", async () => {
    const e = ui.locators.edge("web--api");
    await e.focus();
    await e.press("Enter");
    const i = ui.locators.openLabelInput();
    await expect(i).toBeVisible();
    console.log("NOTE rel editor value:", await i.inputValue(), "aria", await i.getAttribute("aria-label"));
    await i.fill("Calls (renamed)");
    await i.press("Enter");
    await ui.settle();
  });
  await diff("rename rel");
  // reattach web--api target -> jobs
  await ui.reattachEdge("web--api", "target", "jobs");
  await diff("reattach web--api target->jobs");
  await step("alerts after reattach", async () => console.log("NOTE alerts:", JSON.stringify(await h.alert())));
  await ui.undo();
  await diff("undo reattach");
  // reattach onto a boundary (drop on boundary body)
  await step("reattach api--orders target onto boundary 'ops' body", async () => {
    const e = ui.locators.edge("api--orders");
    const pt = await e
      .locator(".react-flow__edge-path")
      .first()
      .evaluate((el) => {
        const m = el.getScreenCTM();
        const q = el.getPointAtLength(el.getTotalLength() * 0.5);
        return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
      });
    await page.mouse.click(pt.x, pt.y);
    const upd = e.locator(".react-flow__edgeupdater-target");
    const ub = await upd.boundingBox();
    const bb = await page.locator('.react-flow__node[data-id="ops"]').boundingBox();
    console.log("NOTE boundary box", JSON.stringify(bb), "updater", JSON.stringify(ub));
    if (ub && bb) {
      await ui.drag({ x: ub.x + ub.width / 2, y: ub.y + ub.height / 2 }, { x: bb.x + 20, y: bb.y + bb.height - 15 });
      await ui.settle();
    }
    console.log("NOTE alerts after boundary drop:", JSON.stringify(await h.alert()));
  });
  await diff("after reattach onto boundary");
  await h.shot("c4e-2-boundary-drop");
  // delete referenced element
  await ui.select("ledger");
  await ui.deleteSelected();
  await step("alerts delete referenced ledger", async () =>
    console.log("NOTE alerts:", JSON.stringify(await h.alert())),
  );
  // add unreferenced then delete
  const z = await ui.addPart("Container", { name: "Temp" });
  await ui.select(z);
  await ui.deleteSelected();
  await diff("add + delete unreferenced");
  // last element in boundary: ops contains monitor only; remove its rel first
  await h.selectEdge("monitor--api");
  await ui.deleteSelected();
  await diff("delete rel monitor--api");
  await ui.select("monitor");
  await ui.deleteSelected();
  await step("alerts delete last element in boundary", async () =>
    console.log("NOTE alerts:", JSON.stringify(await h.alert())),
  );
  await diff("delete monitor (last in ops)");
  await h.shot("c4e-3-after-delete-last");
  // undo chain
  for (let i = 0; i < 4; i++) await ui.undo();
  await diff("after 4 undos");
  await ui.save();
  await h.diffFile(slug, rel, original);
  await ui.openDiagram(slug, file);
  await page.waitForTimeout(1500);
  await h.shot("c4e-4-reading");
};
