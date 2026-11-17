import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = { name: "smoke-b-dblclick-zoom", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const camSeq = () =>
    page.evaluate(() => {
      const v = document.querySelector(".archer-seq-viewport");
      const s = document.querySelector(".archer-seq-svg");
      return JSON.stringify({
        vp: v?.getAttribute("style")?.slice(0, 120),
        vb: s?.getAttribute("viewBox"),
        tf: v?.querySelector("g")?.getAttribute("transform"),
      });
    });
  const camFlow = () =>
    page
      .locator(".react-flow__viewport")
      .evaluate((e) => e.style.transform)
      .catch(() => null);
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
  await q.quiet(300);
  for (const [what, loc] of [
    ["participant s", ui.locators.participant("s")],
    ["message msg-1", ui.locators.message("msg-1")],
  ]) {
    await step(`seq dblclick ${what}`, async () => {
      const c0 = await camSeq();
      await loc.dblclick();
      await page.waitForTimeout(500);
      const open = await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false);
      console.log("PROBE seq dblclick", what, "editor", open, "camera changed", c0 !== (await camSeq()));
      await page.keyboard.press("Escape");
      await q.quiet(200);
    });
  }
  await step("seq dblclick empty canvas", async () => {
    const c0 = await camSeq();
    const b = await page.locator(".authoring-preview").boundingBox();
    await page.mouse.dblclick(b.x + b.width - 120, b.y + b.height - 60);
    await page.waitForTimeout(500);
    console.log("PROBE seq dblclick empty: camera changed", c0 !== (await camSeq()));
  });
  await step("seq double-click lifeline", async () => {
    const c0 = await camSeq();
    const b = await ui.locators.lifelineHit("c").boundingBox();
    await page.mouse.dblclick(b.x + b.width / 2, b.y + 150);
    await page.waitForTimeout(500);
    console.log(
      "PROBE seq dblclick lifeline: camera changed",
      c0 !== (await camSeq()),
      "new msgs",
      (await ui.seq.messages()).length,
      "editor",
      await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false),
    );
    await page.keyboard.press("Escape");
  });
  await step("seq wheel zoom still works (camera)", async () => {
    const c0 = await camSeq();
    const b = await page.locator(".authoring-preview").boundingBox();
    await page.mouse.move(b.x + 300, b.y + 300);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
    console.log("PROBE seq wheel: camera changed", c0 !== (await camSeq()));
  });
  for (const [slug, p, ids] of [
    ["awkward", "diagrams/er-awkward.mmd", ["ORDER", "WAREHOUSE"]],
    ["awkward", "diagrams/state-composite.mmd", ["Idle"]],
  ]) {
    await ui.openDiagram(slug, p, { edit: true });
    await q.quiet(300);
    for (const id of ids)
      await step(`${p} dblclick ${id} (title band / body)`, async () => {
        const c0 = await camFlow();
        const n = ui.locators.node(id);
        const b = await n.boundingBox();
        await page.mouse.dblclick(b.x + b.width / 2, b.y + 14);
        await page.waitForTimeout(500);
        const open = await ui.locators
          .openLabelInput()
          .isVisible()
          .catch(() => false);
        console.log("PROBE", p, id, "editor", open, "camera changed", c0 !== (await camFlow()));
        await page.keyboard.press("Escape");
      });
    await step(`${p} dblclick empty canvas and edge`, async () => {
      const c0 = await camFlow();
      const b = await page.locator(".authoring-preview").boundingBox();
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height - 30);
      await page.waitForTimeout(500);
      console.log("PROBE", p, "dblclick empty: camera changed", c0 !== (await camFlow()));
    });
  }
};
