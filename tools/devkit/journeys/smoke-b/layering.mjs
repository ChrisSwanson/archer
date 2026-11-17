import { KNOWN, tools, seqTools } from "./lib.mjs";
export const meta = {
  name: "smoke-b-layering",
  invariants: {
    ...KNOWN,
    "chrome-overlap": { severity: "warn", reason: "recorded as warning so the journey continues" },
  },
};
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const q = seqTools({ page, ui, t });
  const rects = () =>
    page.evaluate(() => {
      const sel = {
        cluster: ".authoring-edit-cluster",
        parts: ".authoring-parts",
        msgpanel: ".authoring-message-panel",
        controls: ".archer-canvas-controls:not(.authoring-edit-cluster)",
        structure: ".authoring-panel",
        toolbar: ".authoring-toolbar",
        error: ".authoring-error",
      };
      const out = {};
      for (const [k, s] of Object.entries(sel)) {
        const e = document.querySelector(s);
        if (!e) continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        out[k] = { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom) };
      }
      const ks = Object.keys(out),
        hits = [];
      for (let i = 0; i < ks.length; i++)
        for (let j = i + 1; j < ks.length; j++) {
          const a = out[ks[i]],
            b = out[ks[j]];
          if (a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1) hits.push(ks[i] + "×" + ks[j]);
        }
      return {
        out,
        hits,
        scrollW: document.documentElement.scrollWidth,
        innerW: innerWidth,
        hscroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [1024, 768],
  ]) {
    await step(`viewport ${w}x${h}: seq with message panel, then structure panel`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await ui.resetProject("journeys");
      await ui.openDiagram("journeys", "diagrams/seq.mmd", { edit: true });
      await ui.select("msg-1");
      await q.quiet(400);
      console.log("PROBE", w, "seq+msgpanel", JSON.stringify(await rects()));
      await t.shot(`layer-seq-${w}`);
      await ui.toggleStructure();
      await q.quiet(400);
      console.log("PROBE", w, "seq+msgpanel+structure", JSON.stringify(await rects()));
      await t.shot(`layer-seq-struct-${w}`);
      await ui.toggleStructure();
    });
    await step(`viewport ${w}: ER/state/C4`, async () => {
      for (const [slug, p, id] of [
        ["awkward", "diagrams/er-awkward.mmd", "ORDER"],
        ["awkward", "diagrams/state-composite.mmd", "Idle"],
      ]) {
        await ui.openDiagram(slug, p, { edit: true });
        await ui.select(id);
        await ui.toggleStructure();
        await q.quiet(400);
        console.log("PROBE", w, p, JSON.stringify(await rects()));
        await t.shot(`layer-${p.split("/").pop().replace(".mmd", "")}-${w}`);
        await ui.toggleStructure();
      }
    });
  }
};
