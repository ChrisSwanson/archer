// smoke-a: whitespace-padded labels and quotes on every flowchart shape (rename), plus existing flow-styled q.
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-labels2",
  invariants: {
    ...KNOWN,
    warnings: { severity: "warn", reason: "recording" },
    "editor-alert": { severity: "warn", reason: "recording" },
  },
};
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const k = page.keyboard;
  await ui.resetProject("journeys");
  await ui.newDiagram("journeys", {
    type: "Flowchart",
    saveAs: `diagrams/smoke-a-lab2-${Date.now().toString(36)}.mmd`,
  });
  const ids = {};
  for (const [p, n] of [
    ["Process", "P"],
    ["Decision", "D"],
    ["Start / end", "T"],
    ["Subroutine", "S"],
    ["Database", "B"],
  ])
    ids[p] = await ui.addPart(p, { name: n });
  await h.panBy(-400);
  await h.fit().catch(() => {});
  for (const [p, id] of Object.entries(ids)) {
    for (const label of ['say "hi"', "x & y", "lead", " lead", "trail ", "  both  ", "a  b", "   "]) {
      await step(`${p}: ${JSON.stringify(label)}`, async () => {
        const nd = ui.locators.node(id);
        await nd.dblclick({ force: true });
        const i = ui.locators.openLabelInput();
        await expect(i).toBeVisible();
        await i.fill(label);
        await k.press("Enter");
        await ui.settle();
        const open = await i.isVisible().catch(() => false);
        const src = await h.srcQuiet();
        const line = src.split("\n").find((l) => l.trim().startsWith(id)) ?? "?";
        console.log(
          `NOTE ${p} ${JSON.stringify(label)} -> ${JSON.stringify(line.trim())} open=${open} alert=${JSON.stringify(await h.alert())}`,
        );
        if (open) {
          await k.press("Escape");
          await expect(i).toBeHidden({ timeout: 6000 });
        } // a refused label lingers read-only ~4 s (app bug)
        await page
          .getByRole("button", { name: "Dismiss" })
          .click({ timeout: 500 })
          .catch(() => {});
      });
    }
  }
  await ui.cancel({ discard: true });
  // existing: q in flow-styled
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/flow-styled.mmd", { edit: true });
  for (const label of ["Simple", 'With "quotes"', "A & B", "padded "]) {
    await step(`flow-styled q: ${JSON.stringify(label)}`, async () => {
      await ui.locators.node("q").dblclick();
      const i = ui.locators.openLabelInput();
      await i.fill(label);
      await k.press("Enter");
      await ui.settle();
      const src = await h.srcQuiet();
      const line = src.split("\n").find((l) => l.trim().startsWith("q[")) ?? "?";
      console.log(
        `NOTE q ${JSON.stringify(label)} -> ${JSON.stringify(line.trim())} open=${await i.isVisible().catch(() => false)} alert=${JSON.stringify(await h.alert())}`,
      );
      if (await i.isVisible().catch(() => false)) {
        await k.press("Escape");
        await expect(i).toBeHidden({ timeout: 6000 });
      }
      await page
        .getByRole("button", { name: "Dismiss" })
        .click({ timeout: 500 })
        .catch(() => {});
    });
  }
};
