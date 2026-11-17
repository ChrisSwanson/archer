// smoke-a: awkward flowchart (flow-styled): no-op rename, special-character labels, edge delete vs linkStyle index, subgraph interactions, refusals and their messages.
import { KNOWN, mk, udiff } from "./lib.mjs";
export const meta = {
  name: "smoke-a-flow-awkward",
  invariants: {
    ...KNOWN,
    warnings: { severity: "warn", reason: "recording refusals" },
    "editor-alert": { severity: "warn", reason: "recording" },
  },
  viewport: { width: 1440, height: 1300 },
};
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const k = page.keyboard;
  const slug = "awkward",
    file = "diagrams/flow-styled.mmd",
    rel = `.archer/${file}`;
  await ui.resetProject(slug);
  const original = await ui.readProjectFile(slug, rel);
  await ui.openDiagram(slug, file, { edit: true });
  await h.shot("fa-1-open");
  await h.note("nodes", (await h.nodes()).join(","), "edges", (await h.edges()).join(","));
  const diff = async (t) => {
    const cur = await h.src(t);
    console.log(`--- DIFF (${t})\n${udiff(original, cur)}\n---`);
  };
  const openEditorValue = async (id) => {
    await ui.locators.node(id).dblclick();
    const i = ui.locators.openLabelInput();
    await i.waitFor({ timeout: 3000 }).catch(() => {});
    return i;
  };
  // no-op rename: open editor, Enter unchanged
  for (const id of ["q", "db", "ext", "uni", "long"]) {
    await step(`no-op rename ${id}: open editor and press Enter unchanged`, async () => {
      const i = await openEditorValue(id);
      const v = await i.inputValue().catch(() => "(no editor)");
      console.log(`NOTE editor value for ${id}: ${JSON.stringify(v)}`);
      await k.press("Enter");
      await ui.settle();
      console.log(`NOTE alerts: ${JSON.stringify(await h.alert())}`);
    });
  }
  await diff("after no-op renames (should be no diff)");
  // rename q to something with specials
  await ui.rename("q", 'Jobs "queue" & <retries> #1');
  await diff("rename q with quotes/&/<>/#");
  await h.undoUnlessRefused();
  // delete edge 0 (linkStyle 0 refers by index)
  await h.selectEdgeNow("e_web_api");
  await ui.deleteSelected();
  await diff("delete edge e_web_api (linkStyle 0)");
  await h.undoUnlessRefused();
  // delete node with class/style
  await ui.select("long");
  await ui.deleteSelected();
  await step("alerts delete long", async () => console.log("NOTE alerts:", JSON.stringify(await h.alert())));
  // dblclick on a subgraph
  await step("dblclick subgraph 'backend' title", async () => {
    const g = ui.locators.node("backend");
    const bb = await g.boundingBox();
    console.log("NOTE backend box", JSON.stringify(bb));
    await page.mouse.dblclick(bb.x + 40, bb.y + 14);
    await page.waitForTimeout(500);
    const i = ui.locators.openLabelInput();
    const vis = await i.isVisible().catch(() => false);
    console.log(
      "NOTE subgraph dblclick opens editor:",
      vis,
      vis ? await i.inputValue() : "",
      "alerts",
      JSON.stringify(await h.alert()),
    );
    if (vis) await k.press("Escape");
  });
  // drag a grouped node
  await step("drag grouped node 'worker'", async () => {
    const b = await ui.locators.node("worker").boundingBox();
    await ui.drag(
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      { x: b.x + b.width / 2 + 200, y: b.y + b.height / 2 + 120 },
    );
    await ui.settle();
    console.log("NOTE alerts after dragging grouped node:", JSON.stringify(await h.alert()));
  });
  await h.shot("fa-2-after-group-drag");
  // connect to a subgraph / from subgraph by drag onto its body
  await h.part("Arrow");
  await step("drag a connection from 'web' onto subgraph 'backend' body", async () => {
    await ui.locators.node("web").hover();
    const sh = await ui.locators.node("web").locator(".react-flow__handle.source").first().boundingBox();
    const gb = await ui.locators.node("backend").boundingBox();
    const before = (await h.edges()).length;
    await ui.drag(
      { x: sh.x + sh.width / 2, y: sh.y + sh.height / 2 },
      { x: gb.x + gb.width - 30, y: gb.y + gb.height - 20 },
    );
    await ui.settle();
    console.log("NOTE edges", before, "->", (await h.edges()).length, "alerts", JSON.stringify(await h.alert()));
  });
  // reattach an edge end onto a subgraph
  await step("reattach e_api_ext target onto subgraph 'inner' body", async () => {
    await h.selectEdgeNow("e_api_ext");
    const ub = await page
      .locator('.react-flow__edge[data-id="e_api_ext"] .react-flow__edgeupdater-target')
      .boundingBox();
    const gb = await ui.locators.node("inner").boundingBox();
    await ui.drag({ x: ub.x + ub.width / 2, y: ub.y + ub.height / 2 }, { x: gb.x + 20, y: gb.y + gb.height - 10 });
    await ui.settle();
    console.log("NOTE alerts after reattach onto group:", JSON.stringify(await h.alert()));
  });
  await diff("final");
  await ui.cancel({ discard: true });
};
