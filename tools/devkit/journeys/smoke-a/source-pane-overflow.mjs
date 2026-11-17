// smoke-a: forced Mermaid source pane on non-flowchart families: how tall is the canvas, does the pane fit the viewport, can it be scrolled to?
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-source-pane",
  invariants: { ...KNOWN, warnings: { severity: "warn", reason: "recording" } },
};
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  for (const [slug, file, fam] of [
    ["journeys", "diagrams/flow.mmd", "flowchart"],
    ["pageturner", "diagrams/containers.mmd", "c4"],
  ]) {
    await ui.resetProject(slug);
    await ui.openDiagram(slug, file, { edit: true });
    await step(`${fam}: geometry`, async () => {
      const r = await page.evaluate(() => {
        const box = (s) => {
          const e = document.querySelector(s);
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
        };
        const ta = document.querySelector("#authoring-source");
        return {
          vh: innerHeight,
          canvas: box(".authoring-preview"),
          source: box(".authoring-source"),
          textarea: box("#authoring-source"),
          docScroll: document.scrollingElement.scrollHeight,
          bodyOverflow: getComputedStyle(document.body).overflow,
          copyBtnVisible: (() => {
            const b = [...document.querySelectorAll(".authoring-source button")].map(
              (x) => x.getBoundingClientRect().bottom,
            );
            return b;
          })(),
        };
      });
      console.log("NOTE", fam, JSON.stringify(r));
      const ta = page.locator("#authoring-source");
      if (await ta.isVisible().catch(() => false)) {
        const inView = await ta.evaluate((e) => {
          const b = e.getBoundingClientRect();
          return { bottom: Math.round(b.bottom), innerHeight };
        });
        console.log("NOTE textarea bottom vs viewport", JSON.stringify(inView));
      }
    });
    await h.shot(`pane-${fam}`);
    await ui.cancel({ discard: true });
  }
};
