// smoke-a: which label texts do node/edge/relationship renames accept? Records resulting source and the alert text per family.
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-labels",
  invariants: {
    ...KNOWN,
    warnings: { severity: "warn", reason: "recording refusals" },
    "editor-alert": { severity: "warn", reason: "recording" },
  },
};
const LABELS = [
  'say "hi"',
  "a & b",
  "x < y",
  "#1 first",
  "semi; colon",
  "pipe | bar",
  "brace {x}",
  "paren (x)",
  "bracket [x]",
  "back`tick",
  "100%",
  "emoji ✓ é",
  "  padded  ",
  "two\\nlines",
  "--> arrow",
  "end",
  "A:::b",
];
export default async (ctx) => {
  const { ui, step, expect, page } = ctx;
  const h = mk(ctx);
  const k = page.keyboard;
  for (const [type, part, rel] of [
    ["Flowchart", "Process", "Arrow"],
    ["C4 container", "Container", "Relationship"],
    ["State", "State", "Transition"],
    ["Entity relationship", "Entity", "One to many"],
  ]) {
    await h.note(`===== ${type}`);
    await ui.resetProject("journeys");
    await ui.newDiagram("journeys", { type, saveAs: `diagrams/smoke-a-lab-${Date.now().toString(36)}.mmd` });
    const a = await ui.addPart(part, { name: "Base" });
    for (const label of LABELS) {
      await step(`${type}: node label ${JSON.stringify(label)}`, async () => {
        await ui.locators.node(a).dblclick();
        const i = ui.locators.openLabelInput();
        await expect(i).toBeVisible();
        await i.fill(label.replace(/\\n/g, "\n").replace(/\n/g, " "));
        await k.press("Enter");
        await ui.settle();
        const open = await i.isVisible().catch(() => false);
        const txt = ((await ui.locators.node(a).textContent()) ?? "").trim();
        const al = await h.alert();
        const src = await h.srcQuiet();
        const line = src.split("\n").find((l) => l.includes(a)) ?? "?";
        console.log(
          `NOTE ${type} label ${JSON.stringify(label)} -> node text ${JSON.stringify(txt)} | src line ${JSON.stringify(line.trim())} | editorStillOpen=${open} | alert=${JSON.stringify(al)}`,
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
    await ui.cancel({ discard: true });
  }
};
