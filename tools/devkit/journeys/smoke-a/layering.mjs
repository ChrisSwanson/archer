// smoke-a: editing chrome layering at a given width (SMOKE_A_VW x SMOKE_A_VH, default 1440x900), Structure panel closed and open, flowchart and C4 and with a selection.
import { KNOWN, mk } from "./lib.mjs";
const vw = Number(process.env.SMOKE_A_VW ?? 1440),
  vh = Number(process.env.SMOKE_A_VH ?? 900);
export const meta = { name: `smoke-a-layering-${vw}`, invariants: KNOWN, viewport: { width: vw, height: vh } };
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const geom = (t) =>
    step(`geometry ${t}`, async () => {
      const r = await page.evaluate(() => {
        const q = (s) =>
          [...document.querySelectorAll(s)].map((e) => {
            const b = e.getBoundingClientRect();
            return { s, x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.right), b: Math.round(b.bottom) };
          });
        const els = [
          ...q(".authoring-toolbar"),
          ...q(".authoring-tools-row"),
          ...q(".authoring-parts"),
          ...q('[aria-label="Editing tools"]'),
          ...q(".react-flow__controls"),
          ...q(".authoring-panel"),
          ...q(".authoring-source"),
          ...q(".archer-canvas-hint, .archer-fit-notice, [class*=fit-note]"),
          ...q(".authoring-statusline"),
        ];
        return { vw: innerWidth, vh: innerHeight, els, hscroll: document.documentElement.scrollWidth > innerWidth };
      });
      const ov = [];
      for (let i = 0; i < r.els.length; i++)
        for (let j = i + 1; j < r.els.length; j++) {
          const a = r.els[i],
            b = r.els[j];
          if (a.s === b.s) continue;
          if (a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1) ov.push(`${a.s} x ${b.s}`);
        }
      console.log(
        `NOTE ${t} @${vw}x${vh}: hscroll=${r.hscroll}; overlaps=${JSON.stringify([...new Set(ov)])}; ${r.els.map((e) => `${e.s}[${e.x},${e.y},${e.r},${e.b}]`).join(" ")}`,
      );
    });
  for (const [slug, file, label] of [
    ["journeys", "diagrams/flow.mmd", "flow"],
    ["pageturner", "diagrams/containers.mmd", "c4"],
    ["pageturner", "diagrams/data-model.mmd", "er"],
    ["pageturner", "diagrams/order-lifecycle.mmd", "state"],
  ]) {
    await ui.resetProject(slug);
    await ui.openDiagram(slug, file, { edit: true });
    await geom(`${label} open`);
    await h.shot(`layer-${vw}-${label}-1-open`);
    await ui.toggleStructure();
    await page.waitForTimeout(500);
    await geom(`${label} structure open`);
    await h.shot(`layer-${vw}-${label}-2-structure`);
    const first = (await h.nodes())[0];
    await ui.select(first).catch(() => {});
    await page.waitForTimeout(300);
    await geom(`${label} structure open + selection`);
    await h.shot(`layer-${vw}-${label}-3-selected`);
    await ui.toggleStructure();
    await ui.cancel({ discard: true });
  }
};
