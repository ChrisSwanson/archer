import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-seq-notes-frag", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const show = async (l) => {
    const s = await q.snap();
    console.log(
      "PROBE",
      l,
      "|",
      s.src.replace(/(participant|actor) \w+ as [^⏎]+ ⏎ /g, ""),
      "| sel",
      JSON.stringify(s.selected),
      "| alerts",
      JSON.stringify(await t.alerts()),
    );
  };
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/seq-awkward.mmd", { edit: true });
  await t.shot("seqaw-0");
  console.log(
    "PROBE parts:",
    JSON.stringify(await ui.seq.participants()),
    "msgs",
    (await ui.seq.messages()).length,
    "notes",
    await page.locator("g.archer-seq-note").count(),
    "fragments",
    await page.locator(".archer-seq-fragment").count(),
  );
  // click a note, Delete
  await step("click note then Delete selected", async () => {
    const n = page.locator("g.archer-seq-note").first();
    await n.click();
    await q.quiet(300);
    console.log(
      "PROBE note selected classes:",
      await n.getAttribute("class"),
      "delete enabled",
      await t.toolbar("Delete selected").isEnabled(),
    );
    await page.keyboard.press("Delete");
    await show("after Delete on note");
  });
  await step("dblclick note", async () => {
    const n = page.locator("g.archer-seq-note").first();
    await n.dblclick();
    await page.waitForTimeout(400);
    console.log(
      "PROBE note dblclick editor:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
      "alerts",
      JSON.stringify(await t.alerts()),
    );
    await page.keyboard.press("Escape");
  });
  await step("click a fragment header", async () => {
    const f = page
      .locator(".archer-seq-fragment")
      .first(); /* the header (chip + label) is drawn in its own layer above the lifelines, not inside the frame */
    const h = page
      .locator(
        '[data-seq-part="fragment"] .archer-seq-fragment-chip, .archer-seq-fragment-header .archer-seq-fragment-chip',
      )
      .first();
    const b = await h.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await q.quiet(300);
    console.log(
      "PROBE fragment header click -> sel",
      JSON.stringify((await q.snap()).selected),
      "classes",
      await f.getAttribute("class"),
    );
    await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(400);
    console.log(
      "PROBE fragment header dblclick editor:",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Escape");
  });
  // rename participants in place incl. actor with long label; delete participant referenced
  await step("rename participant (long label) in place", async () => {
    await ui.rename("web", "Web front-end");
    await show("after rename web");
  });
  await step("delete referenced participant", async () => {
    await ui.select("db");
    await ui.deleteSelected();
    await show("after delete db");
  });
  await step("delete message inside nested fragment", async () => {
    const ms = await ui.seq.messages();
    await ui.select(ms[4].id);
    await ui.deleteSelected();
    await show("after delete msg-4 in alt/opt");
  });
  await step("delete last message inside a fragment leaving it empty", async () => {
    await page.reload();
    await ui.canvasReady();
    const lab = (await ui.seq.messages()).map((m) => m.id + m.label);
    console.log("PROBE labels", JSON.stringify(lab));
  });
  await t.shot("seqaw-end");
};
