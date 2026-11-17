// smoke-a: angle-bracket / html-ish labels on flowchart, C4, state, ER.
import { KNOWN, mk } from "./lib.mjs";
export const meta = {
  name: "smoke-a-labels3",
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
  for (const [type, part] of [
    ["Flowchart", "Process"],
    ["C4 container", "Container"],
    ["State", "State"],
    ["Entity relationship", "Entity"],
  ]) {
    await ui.resetProject("journeys");
    await ui.newDiagram("journeys", { type, saveAs: `diagrams/smoke-a-lab3-${Date.now().toString(36)}.mmd` });
    const id = await ui.addPart(part, { name: "Base" });
    for (const label of [
      "a <b> c",
      "<b>bold</b>",
      "Jobs <retries> #1",
      "x<y>z",
      "<br/>",
      "&amp; literal",
      "#quot; literal",
    ]) {
      await step(`${type}: ${JSON.stringify(label)}`, async () => {
        await ui.locators.node(id).dblclick();
        const i = ui.locators.openLabelInput();
        await expect(i).toBeVisible();
        await i.fill(label);
        await k.press("Enter");
        await ui.settle();
        const open = await i.isVisible().catch(() => false);
        const src = await h.srcQuiet();
        const line = src.split("\n").find((l) => l.includes(id)) ?? "?";
        console.log(
          `NOTE ${type} ${JSON.stringify(label)} -> ${JSON.stringify(line.trim())} shown=${JSON.stringify(((await ui.locators.node(id).textContent()) ?? "").trim())} open=${open} alert=${JSON.stringify(await h.alert())}`,
        );
        // A refused label stays on screen read-only until the field times out (about 4 s; reported as an app bug):
        // wait for it to close so the next double-click opens a fresh editor instead of typing into the stale one.
        if (open) {
          const t0 = Date.now();
          await k.press("Escape");
          await expect(i).toBeHidden({ timeout: 6000 });
          console.log(`NOTE refused label field stayed open ${Date.now() - t0} ms after Escape`);
        }
        await page
          .getByRole("button", { name: "Dismiss" })
          .click({ timeout: 500 })
          .catch(() => {});
      });
    }
    await ui.cancel({ discard: true });
  }
};
