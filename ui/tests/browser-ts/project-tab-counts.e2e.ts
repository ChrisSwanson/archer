// The project page's tabs hold their place while its file listings are read (S6; codex-205, claude-206). The files
// wait for the page's own diagram and note listings (PF-6); until they answer the tab counts read "…", in width kept
// for the count, so the real counts move no tab. Cold: a fresh browser context for each page.
// The count's own text holds its start too (O223): centred, "…" (10 px) becoming "12" (16 px) moved the text's
// starting point 3 px, which Chrome reports as a layout shift of the count's text node (S6, at the lists' DOM anchor).
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const DIAGRAMS = 12,
  NOTES = 11;
const files: Record<string, string> = {
  "archer.toml":
    "version = 1\n\n" +
    Array.from(
      { length: DIAGRAMS },
      (_, i) =>
        `[[views]]\nid = "d${i}"\nkind = "freeform"\ntitle = "Diagram ${i}"\nsource = ".archer/diagrams/d${i}.mmd"\n`,
    ).join("\n"),
  ...Object.fromEntries(
    Array.from({ length: DIAGRAMS }, (_, i) => [
      `.archer/diagrams/d${i}.mmd`,
      `flowchart LR\n  a${i}[A] --> b${i}[B]\n`,
    ]),
  ),
  ...Object.fromEntries(
    Array.from({ length: NOTES }, (_, i) => [`.archer/notes/n${i}.md`, `# Note ${i}\n\nAbout part ${i}.\n`]),
  ),
};

let project: TsProject;
test.beforeEach(async () => {
  project = await sharedTsProject({ files });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await project.stop();
});

type Frame = { at: number; tabs: { text: string; x: number; w: number; start: number | null }[] };

/** Every frame in which a project tab's text or box changed, from the first frame the tabs are drawn. */
async function recordTabs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: Frame[] = ((window as unknown as { __tabs: Frame[] }).__tabs = []);
    let last = "";
    const look = () => {
      const tabs = [...document.querySelectorAll<HTMLElement>("button.archer-project-tab")].map((b) => {
        const r = b.getBoundingClientRect();
        // Where the count's text starts (a text node's layout-shift starting point), not its span's box.
        const count = b.querySelector(".archer-project-tab-count");
        let start: number | null = null;
        if (count?.firstChild) {
          const range = document.createRange();
          range.selectNodeContents(count);
          start = Math.round(range.getBoundingClientRect().x * 10) / 10;
        }
        return { text: b.textContent ?? "", x: Math.round(r.x * 10) / 10, w: Math.round(r.width * 10) / 10, start };
      });
      const key = JSON.stringify(tabs);
      if (tabs.length > 0 && key !== last) {
        frames.push({ at: Math.round(performance.now()), tabs });
        last = key;
      }
      if (performance.now() < 15_000) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

for (const [name, query] of [
  ["folders", ""],
  ["diagrams", "?tab=diagrams"],
  ["notes", "?tab=notes"],
] as const) {
  test(`cold ${name} tab: the tabs keep their boxes while the listings are held and when they answer`, async ({
    page,
  }) => {
    const access = await project.issueAccess("tab counts");
    const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
    // The access link sets the cookie in this context; the page itself is then read cold (nothing cached).
    await page.request.get(access.url);
    await recordTabs(page);
    // The page's own note listing is held, so the catalog has answered and the files still wait for it.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/notes\/all(\?|$)/, async (route) => {
      await released;
      await route.continue();
    });
    await page.goto(`${new URL(project.url).origin}/projects/${slug}/${query}`);
    const tabs = page.locator("button.archer-project-tab");
    await expect(tabs).toHaveCount(3);
    await page.waitForTimeout(400);
    const held = await tabs.allTextContents();
    expect.soft(held.join(" | "), "a held listing reads as a count").not.toMatch(/\d/);
    release();
    await expect(tabs.nth(1)).toHaveText(`Diagrams${DIAGRAMS}`);
    await expect(tabs.nth(2)).toHaveText(`Notes${NOTES}`);
    await page.waitForTimeout(400);
    const frames = await page.evaluate(() => (window as unknown as { __tabs: Frame[] }).__tabs);
    const boxes = frames.map((f) => JSON.stringify(f.tabs.map(({ x, w }) => ({ x, w }))));
    expect(
      new Set(boxes).size,
      `the tabs moved as their counts came:\n${frames.map((f) => JSON.stringify(f)).join("\n")}`,
    ).toBe(1);
    const starts = frames.map((f) => JSON.stringify(f.tabs.map(({ start }) => start)));
    expect(
      new Set(starts).size,
      `a count's text moved as it came:\n${frames.map((f) => JSON.stringify(f)).join("\n")}`,
    ).toBe(1);
  });
}
