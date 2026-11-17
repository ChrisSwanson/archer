// Round 1 (UI/UX) fixes, pass 6, batch F22: canvas, walkthrough, embedded. Each test names its row in the
// pass's fix list and the finding it answers. The Pageturner corpus, served from this checkout's build
// (`ARCHER_PAGE`, else ui/dist; the embedded page `ARCHER_MCP_PAGE`, else ui/dist/mcp).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { McpHost } from "./support/mcp-host";
import { sharedTsProject } from "./support/shared-service";
import { settled } from "./support/settled";

const MCP_PAGE = process.env.ARCHER_MCP_PAGE ?? resolve(import.meta.dirname, "../../dist/mcp/index.html");
const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus");

function corpus(name: string): Record<string, string> {
  const root = join(CORPUS, name);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}
const commit = async (root: string): Promise<void> => {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-c", "user.name=archer-test", "-c", "user.email=test@archer.invalid", "-c", "init.defaultBranch=main", ...args],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "corpus");
};

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function open(browser: Browser, options: BrowserContextOptions, path: string, highlights = false): Promise<Page> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  if (highlights)
    await project.setEmphasis("containers", [
      JSON.parse(readFileSync(join(CORPUS, "pageturner/.devkit/emphasis.json"), "utf8")),
    ]);
  const page = await (await browser.newContext(options)).newPage();
  await page.goto((await project.issueAccess("round1-f22")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${origin}/projects/${slug}/${path}`);
  return page;
}
const phone = (width: number, height: number): BrowserContextOptions => ({
  viewport: { width, height },
  hasTouch: true,
  isMobile: true,
});

// Row 1, R5-03 (the edge More control's zoom-independent touch target) is superseded: the ⓘ control is gone and a relationship's technology and description are drawn
// inline on the caption plate (decided 2026-10-31; `edge-detail-inline.e2e.ts`).

test("row 3 R5-claude-03: Escape on a focused node ends the walkthrough and lands on Walkthroughs", async ({
  browser,
}) => {
  const page = await open(
    browser,
    { viewport: { width: 1500, height: 900 }, reducedMotion: "reduce" },
    "diagrams/containers.mmd?walkthrough=checkout-tour&step=1",
  );
  await expect(page.locator(".archer-walk").first()).toBeVisible();
  const node = page
    .locator('.react-flow__node[tabindex="0"], .react-flow__node[aria-label]')
    .filter({ hasText: /Pageturner Online Bookshop/ })
    .first();
  await node.focus();
  await expect(node).toBeFocused();
  await page.keyboard.press("Escape");
  const walks = page.getByRole("button", { name: /^Walkthroughs · \d/ });
  await expect(walks).toHaveAttribute("aria-pressed", "false");
  await expect(walks).toBeFocused();
});

test("row 4 R5-claude-04: on a touch screen the walkthrough Step slider is a 44px target", async ({ browser }) => {
  for (const [width, height] of [
    [390, 844],
    [320, 640],
  ] as const) {
    const page = await open(
      browser,
      { ...phone(width, height), reducedMotion: "reduce" },
      "diagrams/containers.mmd?walkthrough=checkout-tour&step=1",
    );
    const scrub = page.locator(".archer-walk-scrub:visible").first();
    await expect(scrub).toBeVisible();
    const box = (await scrub.boundingBox())!;
    expect(box.height, `${width}`).toBeGreaterThanOrEqual(44);
    await project?.stop();
    project = undefined;
    await page.context().close();
  }
});

/** Every canvas control's box (the cluster's own buttons). */
function controlBoxes(): {
  name: string;
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}[] {
  return [...document.querySelectorAll<HTMLElement>(".react-flow__controls button")]
    .filter((b) => b.offsetParent !== null)
    .map((b) => {
      const r = b.getBoundingClientRect();
      return {
        name: b.getAttribute("aria-label") ?? b.textContent ?? "",
        width: r.width,
        height: r.height,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      };
    });
}

test("row 5 R5-claude-05: at 320 with highlights on, every canvas control is 44×44 and in the drawing", async ({
  browser,
}, testInfo) => {
  const page = await open(browser, { ...phone(320, 640), reducedMotion: "reduce" }, "diagrams/containers.mmd", true);
  await expect(page.locator(".react-flow__controls button").first()).toBeVisible();
  await expect(page.getByText("Checkout and Follow-Up").first()).toBeVisible();
  await settled(page);
  await page.screenshot({ path: testInfo.outputPath("controls-320.png") });
  const boxes = await page.evaluate(controlBoxes);
  const flow = (await page.locator(".react-flow").first().boundingBox())!;
  expect(boxes.length).toBeGreaterThan(4);
  for (const box of boxes) {
    expect(box.height, JSON.stringify(boxes)).toBeGreaterThanOrEqual(44);
    expect(box.width, JSON.stringify(boxes)).toBeGreaterThanOrEqual(44);
    expect(box.top, box.name).toBeGreaterThanOrEqual(flow.y);
    expect(box.bottom, box.name).toBeLessThanOrEqual(flow.y + flow.height + 0.5);
  }
});

for (const sheet of ["highlights", "walkthrough"] as const)
  test(`row 6 R5-claude-07: at 320 with the ${sheet} sheet open, the canvas heading is not drawn over the controls`, async ({
    browser,
  }, testInfo) => {
    const page = await open(
      browser,
      { ...phone(320, 640), reducedMotion: "reduce" },
      sheet === "walkthrough" ? "diagrams/containers.mmd?walkthrough=checkout-tour&step=1" : "diagrams/containers.mmd",
      true,
    );
    // Fit view: with a sheet open the cluster folds, and Zoom in (its first button) waits behind the fold (O95).
    await expect(page.locator(".react-flow__controls-fitview")).toBeVisible();
    if (sheet === "highlights")
      await page
        .getByRole("button", { name: /^Highlights/ })
        .first()
        .click();
    await expect(page.locator(".archer-dock-sheet").first()).toBeVisible();
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`sheet-${sheet}-320.png`) });
    const overlap = await page.evaluate(() => {
      const heading = document.querySelector<HTMLElement>(".archer-canvas-heading");
      if (heading === null || heading.offsetParent === null || getComputedStyle(heading).visibility === "hidden")
        return [];
      const h = heading.getBoundingClientRect();
      if (h.width === 0 || h.height === 0) return [];
      const cluster = document.querySelector<HTMLElement>(".react-flow__controls")!.getBoundingClientRect();
      return cluster.left < h.right && cluster.right > h.left && cluster.top < h.bottom && cluster.bottom > h.top
        ? [`heading ${JSON.stringify(h)} over cluster ${JSON.stringify(cluster)}`]
        : [];
    });
    expect(overlap).toEqual([]);
  });

// --- The embedded page (row 2) ---
const base = resolve(import.meta.dirname, "../../../ts");
const load = async (p: string) => import(/* @vite-ignore */ pathToFileURL(resolve(base, p)).href);

for (const [width, height] of [
  [1500, 900],
  [1000, 800],
] as const)
  for (const scheme of ["light", "dark"] as const) {
    test(`row 2 R5-01 / R5-claude-02: embedded at ${width}×${height} ${scheme}: Theme covers no control, axe is clean, the page has an h1`, async ({
      browser,
    }, testInfo) => {
      const { connect, tempDir, removeTempDirs } = await load("test/mcp/support.ts");
      const { startService } = await load("src/service/service.ts");
      const { connectService } = await load("src/service/service-client.ts");
      const home = tempDir({ "instance.archer.toml": "version = 1\n" });
      const svc = await startService({
        forceHttp: true,
        stateDir: tempDir(),
        env: {
          HOME: home,
          XDG_CONFIG_HOME: resolve(home, ".config"),
          ARCHER_CONFIG: resolve(home, "instance.archer.toml"),
          ARCHER_OPEN_BROWSER: "never",
        },
        log: () => {},
      });
      const files = Object.fromEntries(
        Object.entries(corpus("pageturner")).filter(([path]) => path.startsWith(".archer/") || path === "archer.toml"),
      );
      const { client, close } = await connect(
        {
          cwd: tempDir(files),
          ensureService: () => connectService(svc.socketPath),
          uiHtml: () => readFileSync(MCP_PAGE, "utf8"),
        },
        { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
      );
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      let host: McpHost | undefined;
      try {
        const resource = (await client.readResource({ uri: "ui://archer/diagram" })).contents[0];
        host = await McpHost.open(page, { html: resource.text, callTool: (params) => client.callTool(params) });
        await host.deliver(await client.callTool({ name: "present_diagram", arguments: { viewId: "system-context" } }));
        const view = host.view;
        await expect(view.locator(".react-flow__node").first()).toBeVisible();
        await page.waitForTimeout(500);
        await page.screenshot({ path: testInfo.outputPath(`embedded-${width}-${scheme}.png`) });
        // Every control's middle and corners reach the control itself, Theme's included.
        const coveredNow = (): Promise<string[]> =>
          view.locator("body").evaluate(() => {
            const out: string[] = [];
            for (const button of document.querySelectorAll<HTMLElement>("button")) {
              const r = button.getBoundingClientRect();
              if (
                r.width === 0 ||
                r.height === 0 ||
                button.closest(".react-flow__edgelabel-renderer, .react-flow__nodes") !== null
              )
                continue;
              for (const [x, y] of [
                [0.5, 0.5],
                [0.25, 0.25],
                [0.75, 0.25],
                [0.25, 0.75],
                [0.75, 0.75],
              ].map(([fx, fy]) => [r.left + r.width * fx!, r.top + r.height * fy!])) {
                const hit = document.elementFromPoint(x, y);
                if (hit !== null && !button.contains(hit)) {
                  out.push(
                    `${button.getAttribute("aria-label") ?? button.textContent} under ${hit.getAttribute("class") ?? hit.tagName}`,
                  );
                  break;
                }
              }
            }
            return out;
          });
        expect(await coveredNow()).toEqual([]);
        // Folded to its rail, the panel's Expand is clear of Theme too, and Theme still answers a press.
        await view.getByRole("button", { name: "Collapse diagram panel" }).click();
        await expect(view.getByRole("button", { name: "Expand diagram panel" })).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath(`embedded-${width}-${scheme}-rail.png`) });
        expect(await coveredNow()).toEqual([]);
        const theme = view.locator(".archer-theme-toggle");
        const before = await theme.getAttribute("aria-label");
        await theme.click();
        await expect(theme).not.toHaveAttribute("aria-label", before!);
        await view.getByRole("button", { name: "Expand diagram panel" }).click();
        await expect(view.locator("h1")).toHaveCount(1);
        const axe = await new AxeBuilder({ page })
          .include("#view")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
          .analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      } finally {
        host?.stop();
        await context.close();
        await close();
        await svc.close();
        removeTempDirs();
      }
    });
  }
