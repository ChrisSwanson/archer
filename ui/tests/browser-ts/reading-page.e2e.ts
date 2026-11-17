import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

// A long chain: at a reading zoom it runs past the canvas, so the off-screen cue shows.
const CHAIN = `flowchart LR\n${Array.from({ length: 28 }, (_, i) => `  n${i}[Service step ${i}]`).join("\n")}\n${Array.from({ length: 27 }, (_, i) => `  n${i} e${i}@--> n${i + 1}`).join("\n")}\n`;
const files = {
  "archer.toml":
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Request flow"\nsource = ".archer/flow.mmd"\n\n[[views]]\nid = "chain"\nkind = "freeform"\ntitle = "Long chain"\nsource = ".archer/chain.mmd"\n',
  ".archer/flow.mmd": "flowchart LR\n  a[Client]\n  b[API]\n  a calls@-->|HTTP| b\n",
  ".archer/chain.mmd": CHAIN,
};
let project: TsProject;
test.beforeEach(async () => {
  project = await sharedTsProject({ files });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await project.stop();
});

const slug = (): string => new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const readUrl = (file: string): string => `${new URL(project.url).origin}/projects/${slug()}/${file}`;

async function openAuthoring(page: Page, file: string): Promise<void> {
  const access = await project.issueAuthoringAccess("Reading page keyboard");
  await page.goto(access.url);
  await page.goto(readUrl(file));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

test("Enter on the reading page's Edit button moves focus into the editor, not the page body", async ({ page }) => {
  await openAuthoring(page, "flow.mmd");
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? "none")).not.toBe("BODY");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[aria-label="Diagram Editor"]') !== null))
    .toBe(true);
});

test("Escape closes the reading Source panel from the panel, the Source button, or the page", async ({ page }) => {
  await openAuthoring(page, "flow.mmd");
  const source = page.getByRole("button", { name: "Source", exact: true });
  const panel = page.getByRole("region", { name: "Mermaid Source" });
  for (const where of ["button", "panel", "body"] as const) {
    await source.click();
    await expect(panel).toBeVisible();
    if (where === "panel") await panel.locator(".cm-content, pre, textarea").first().click();
    if (where === "body") await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(panel, where).toHaveCount(0);
  }
});

for (const width of [1024, 900, 768]) {
  test(`at ${width}px the off-screen cue sits clear of the drawing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(project.url);
    await project.present("chain");
    const cue = page.locator(".archer-offscreen-cue");
    await expect(cue).toBeVisible();
    const box = (await cue.boundingBox())!;
    await expect
      .poll(() =>
        page.locator(".react-flow__node").evaluateAll(
          (nodes, cueBox) =>
            nodes
              .filter((node) => {
                const r = node.getBoundingClientRect();
                return (
                  r.left < cueBox.x + cueBox.width &&
                  r.right > cueBox.x &&
                  r.top < cueBox.y + cueBox.height &&
                  r.bottom > cueBox.y
                );
              })
              .map((node) => node.getAttribute("data-id")),
          box,
        ),
      )
      .toEqual([]);
  });
}
