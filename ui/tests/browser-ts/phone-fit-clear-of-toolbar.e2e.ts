// On a phone the canvas's tool column stands over the drawing's left edge, so the opening framing keeps a left
// inset clear of it, as the desktop fit does for its chrome.
import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { settled } from "./support/settled";

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus/pageturner");
function corpusFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(CORPUS, path)] = readFileSync(path, "utf8");
    }
  };
  walk(CORPUS);
  files["archer.toml"] = files["archer.toml"]!.replace(/^version = 1\n/m, "version = 1\nnested_view = false\n");
  return files;
}

// The Pageturner sample's containers diagram drawn as written has its system boundary round its containers: a boundary
// wider than a phone, whose left side the tool column stood over.
test("at 375x812 the fitted drawing starts to the right of the tool column", async ({ browser }) => {
  const server = await startTsProject({ pagePath: testPage(), files: corpusFiles() });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    const agent = new URL(server.agentUrl);
    await page.goto(server.agentUrl);
    await page.goto(`${agent.origin}${agent.pathname}diagrams/containers.mmd`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await settled(page);
    const seen = await page.evaluate(() => {
      const controls = document.querySelector(".react-flow__controls")!.getBoundingClientRect();
      // Everything drawn: boxes, and the wires, one of which loops out to the left of the first box.
      const drawn = [...document.querySelectorAll(".react-flow__node, .react-flow__edge path")];
      return {
        toolbarRight: controls.right,
        drawingLeft: Math.min(...drawn.map((el) => el.getBoundingClientRect().left)),
      };
    });
    expect(seen.drawingLeft).toBeGreaterThanOrEqual(seen.toolbarRight);
  } finally {
    await context.close();
    await server.stop();
  }
});
