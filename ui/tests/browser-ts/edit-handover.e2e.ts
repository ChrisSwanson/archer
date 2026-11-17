import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const manifest = `version = 1\nname = "Handover"\n\n[[views]]\nid = "seq"\nkind = "sequence"\ntitle = "Checkout"\nsource = ".archer/seq.mmd"\n\n[[views]]\nid = "fan"\nkind = "freeform"\ntitle = "Fan out"\nsource = ".archer/fan.mmd"\n`;
const files = {
  "archer.toml": manifest,
  ".archer/seq.mmd":
    "sequenceDiagram\n  participant web as Web app\n  participant api as API\n  participant db as Orders DB\n  web->>api: GET /orders\n  api->>db: SELECT orders\n  db-->>api: 50 rows\n  api-->>web: 200 OK\n",
  ".archer/fan.mmd":
    "flowchart TB\n  a[Gateway]\n  b[Orders]\n  c[Billing]\n  d[Search]\n  a ab@-->|orders| b\n  a ac@-->|billing| c\n  a ad@-->|search| d\n",
};
let project: TsProject;
test.describe.configure({ timeout: 90_000 });
test.afterEach(async ({ page }) => {
  await page.close();
  await project?.stop();
});

const origin = () => new URL(project.url).origin;
const slug = () => new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
async function openView(page: Page, view: "seq" | "fan") {
  project = await sharedTsProject({ files });
  await page.goto((await project.issueAccess("Edit handover")).url);
  await page.goto(`${origin()}/projects/${slug()}/${view}.mmd`);
  await expect(page.locator(view === "seq" ? ".archer-seq-participant" : ".react-flow__node").first()).toBeVisible();
}
const edit = (page: Page) => page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true });
const editor = (page: Page) => page.getByRole("region", { name: "Diagram Editor" });
/** Whether the box being typed in is what a pointer finds across its width: nothing is painted over it. */
const onTop = (page: Page) =>
  page.evaluate(() => {
    const input = document.activeElement as HTMLElement,
      box = input.getBoundingClientRect();
    return [0.1, 0.3, 0.5, 0.7, 0.9].every((f) => {
      const hit = document.elementFromPoint(box.x + box.width * f, box.y + box.height / 2);
      return hit === input || input.contains(hit);
    });
  });

test("Edit hands over from the reading drawing to the editor without a blank stage", async ({ page }) => {
  await openView(page, "seq");
  // Every animation frame from the press until the editor shows: some drawing is visible on the stage.
  await page.evaluate(() => {
    const w = window as unknown as { blank: number; frames: number; done: boolean };
    w.blank = 0;
    w.frames = 0;
    w.done = false;
    const visible = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.visibility === "hidden" || s.display === "none") return false;
      }
      return el.getBoundingClientRect().width > 0;
    };
    const tick = () => {
      w.frames++;
      if (![...document.querySelectorAll(".archer-seq-participant")].some(visible)) w.blank++;
      if ([...document.querySelectorAll(".authoring-workspace .archer-seq-participant")].some(visible)) {
        w.done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await edit(page).click();
  await expect(editor(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { done: boolean }).done)).toBe(true);
  const { blank, frames } = await page.evaluate(() => {
    const w = window as unknown as { blank: number; frames: number };
    return { blank: w.blank, frames: w.frames };
  });
  expect(frames).toBeGreaterThan(0);
  expect(blank).toBe(0);
  await expect(page.getByText("Checking preview…")).toHaveCount(0);
});

test("renaming a sequence participant or message types on top of the drawing, on a solid plate", async ({ page }) => {
  await openView(page, "seq");
  await edit(page).click();
  await expect(editor(page).locator(".archer-seq-participant").first()).toBeVisible();
  for (const [target, name] of [
    [page.locator(".archer-seq-participant", { hasText: "API" }).first(), /api name/],
    [page.locator(".archer-seq-message", { hasText: "50 rows" }).locator("text").last(), /message/],
  ] as const) {
    await target.dblclick();
    const input = page.getByRole("textbox", { name });
    await expect(input).toBeFocused();
    await input.fill("A much longer replacement label for this part");
    expect(await onTop(page)).toBe(true);
    // A plate, not a see-through box over the old text.
    expect(await input.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(
      /rgba\(0, 0, 0, 0\)|transparent/,
    );
    await input.press("Escape");
  }
  // The message's drawn label stands aside while its text is typed: no second copy under the box.
  await page.locator(".archer-seq-message", { hasText: "50 rows" }).locator("text").last().dblclick();
  await expect(page.getByRole("textbox", { name: /message/ })).toBeFocused();
  await expect(
    page.locator(".archer-seq-message svg text, .archer-seq-message > text").filter({ hasText: "50 rows" }),
  ).toHaveCount(0);
});

test("a connection label being renamed sits over its neighbours", async ({ page }) => {
  await openView(page, "fan");
  await edit(page).click();
  await expect(editor(page).locator(".react-flow__node").first()).toBeVisible();
  await page.locator(".archer-edge-label", { hasText: "orders" }).dblclick();
  const input = page.locator(".archer-edge-label .archer-node-label-input");
  await expect(input).toBeFocused();
  // Long enough to run across the neighbouring labels.
  await input.fill("orders, refunds, returns, exchanges, cancellations and every other order event");
  // It does run across "billing": the check below is a real one.
  const [mine, billing] = await Promise.all([
    input.boundingBox(),
    page.locator(".archer-edge-label", { hasText: "billing" }).boundingBox(),
  ]);
  expect(mine!.x + mine!.width).toBeGreaterThan(billing!.x + billing!.width / 2);
  expect(await onTop(page)).toBe(true);
});
