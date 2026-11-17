import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { graphToolsTrigger, openGraphTool } from "./support/primary-navigation";
import { testPage } from "./support/page-path";
async function openTool(page: Page, name: string): Promise<void> {
  await openGraphTool(page, name);
}
async function freeCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const result = await page.locator(".react-flow").evaluate((canvas) => {
    const r = canvas.getBoundingClientRect();
    const eligible = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      return (
        !!hit?.closest(".react-flow") &&
        !hit.closest(
          ".accuracy-compare,.archer-artifact-panel,.archer-diagram-key,.react-flow__controls,.primary-flyout",
        )
      );
    };
    const sparseHits: { x: number; y: number; hit: string | null }[] = [];
    for (const vertical of [0.75, 0.6, 0.9, 0.4, 0.2])
      for (const horizontal of [0.15, 0.5, 0.85]) {
        const x = r.left + r.width * horizontal,
          y = r.top + r.height * vertical;
        if (eligible(x, y)) return { point: { x, y }, diagnostic: null };
        sparseHits.push({
          x,
          y,
          hit:
            document
              .elementFromPoint(x, y)
              ?.closest(
                ".accuracy-compare,.archer-artifact-panel,.archer-diagram-key,.react-flow__controls,.primary-flyout",
              )?.className ??
            document.elementFromPoint(x, y)?.tagName ??
            null,
        });
      }
    // A 15-point probe misses the real phone gap between taller mode controls
    // and the key. Scan the actual viewport with the same hit-test contract.
    let densePoint: { x: number; y: number } | null = null;
    for (let y = Math.max(0, r.top) + 8; y < Math.min(innerHeight, r.bottom) - 8 && !densePoint; y += 8) {
      for (let x = Math.max(0, r.left) + 8; x < Math.min(innerWidth, r.right) - 8; x += 8) {
        if (eligible(x, y)) {
          densePoint = { x, y };
          break;
        }
      }
    }
    const overlays = [
      ...document.querySelectorAll(
        ".accuracy-compare,.archer-artifact-panel,.archer-diagram-key,.react-flow__controls,.primary-navigation",
      ),
    ]
      .map((element) => ({ className: element.className, rect: element.getBoundingClientRect().toJSON() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);
    return {
      point: densePoint,
      diagnostic: {
        canvas: r.toJSON(),
        viewport: { width: innerWidth, height: innerHeight },
        sparseHits,
        densePoint,
        overlays,
      },
    };
  });
  if (result.diagnostic)
    await test
      .info()
      .attach("canvas-hit-scan", { body: JSON.stringify(result.diagnostic, null, 2), contentType: "application/json" });
  expect(result.point, "a real canvas point remains usable outside the actual corner overlays").not.toBeNull();
  return result.point!;
}
async function fixture(gitHistory = true, badHistory = false) {
  const dir = mkdtempSync(join(tmpdir(), "archer-compare-ui-")),
    root = join(dir, "project"),
    state = join(dir, "state");
  const configPath = join(dir, "instance.archer.toml");
  writeFileSync(configPath, "version = 1\n", { mode: 0o600 });
  mkdirSync(join(root, ".archer"), { recursive: true });
  writeFileSync(
    join(root, "archer.toml"),
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Shop"\nsource = ".archer/flow.mmd"\n',
  );
  const source = join(root, ".archer/flow.mmd");
  writeFileSync(source, "flowchart LR\n a[Client] e1@--> b[Shop]\n");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Archer test",
        "-c",
        "user.email=archer-test@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    );
  if (gitHistory) {
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "Initial diagram");
    writeFileSync(source, badHistory ? "flowchart LR\n broken???\n" : "flowchart LR\n a[Customer] e1@--> b[Shop]\n");
    git("add", ".");
    git("commit", "-qm", "Customer label");
    writeFileSync(source, "flowchart LR\n a[Customer] e1@--> b[Shop]\n\n");
    git("add", ".");
    git("commit", "-qm", "Source spacing");
  }
  const load = async (p: string) =>
      import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, "../../../ts/src", p)).href),
    { startService } = await load("service/service.ts"),
    { connectService } = await load("service/client.ts");
  const svc = await startService({
      forceHttp: true,
      env: {
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, ".config"),
        ARCHER_CONFIG: configPath,
        ARCHER_OPEN_BROWSER: "never",
      },
      stateDir: state,
      socketPath: join(state, "archer.sock"),
      pagePath: testPage(),
      log: () => {},
    }),
    client = await connectService(svc.socketPath);
  const url = (await client.call("attach", { root })).url;
  await client.call("present", { root, viewId: "flow" });
  return {
    url,
    selection: async () => (await client.call("getContext", { root })).selection,
    async stop() {
      client.close();
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const phone of [false, true])
  test(`comparison uses real Git history and leaves outside canvas usable, phone=${phone}`, async ({ page }) => {
    const server = await fixture();
    try {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(server.url);
      const node = page.locator('.react-flow__node[data-id="a"]');
      await expect(node).toBeVisible();
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await node.click();
      await expect.poll(() => server.selection()).toMatchObject({ nodes: [{ id: "a" }] });
      const canvas = page.locator(".react-flow"),
        before = await canvas.boundingBox();
      await openTool(page, "Compare revisions");
      const panel = page.getByRole("region", { name: "Compare Revisions" });
      await expect(panel).toBeVisible();
      await expect(panel.getByLabel("From commit")).toBeFocused();
      expect(await canvas.boundingBox()).toEqual(before);
      const point = await freeCanvasPoint(page);
      const hit = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return {
          canvas: !!element?.closest(".react-flow"),
          panel: !!element?.closest(".accuracy-compare"),
          controls: !!element?.closest(".react-flow__controls,.archer-diagram-key"),
        };
      }, point);
      expect(hit).toEqual({ canvas: true, panel: false, controls: false });
      const viewport = page.locator(".react-flow__viewport"),
        transform = await viewport.getAttribute("style");
      await page.mouse.move(point.x, point.y);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(point.x + 45, point.y - 30, { steps: 8 });
      await page.mouse.up({ button: "middle" });
      await expect.poll(() => viewport.getAttribute("style")).not.toBe(transform);
      await panel.getByRole("button", { name: "Compare", exact: true }).click();
      await expect(panel.getByText("Source changed; diagram semantics are unchanged.")).toBeVisible();
      await panel.getByLabel("From commit").fill("HEAD~2");
      await panel.getByLabel("To commit").fill("HEAD~1");
      await panel.getByRole("button", { name: "Compare", exact: true }).click();
      await expect(panel.getByText("Changed · node:a", { exact: true })).toBeVisible();
      await panel.getByText("Changed · node:a", { exact: true }).click();
      await expect(panel.locator("pre").filter({ hasText: '"Client"' })).toBeVisible();
      await expect(panel.locator("pre").filter({ hasText: '"Customer"' })).toBeVisible();
      await expect(panel.locator(".accuracy-path").first()).toHaveText(".archer/flow.mmd");
      expect(await panel.locator(".accuracy-commit").first().textContent()).toMatch(/^[a-f0-9]{40}$/);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
      if (process.env.ARCHER_SHOTS)
        await page.screenshot({
          path: phone ? "/tmp/archer-comparison-phone.png" : "/tmp/archer-comparison-desktop.png",
        });
      await panel.getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest(".accuracy-compare"))).toBe(false);
      await expect(panel).toBeVisible();
      await panel.getByLabel("From commit").focus();
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(graphToolsTrigger(page)).toBeFocused();
      expect((await server.selection()).nodes.map((n: { id: string }) => n.id)).toEqual(["a"]);
    } finally {
      await server.stop();
    }
  });
test("non-Git history is explicitly unavailable", async ({ page }) => {
  const server = await fixture(false);
  try {
    await page.goto(server.url);
    await openTool(page, "Compare revisions");
    const panel = page.getByRole("region", { name: "Compare Revisions" });
    await panel.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(panel.getByText("Git history is unavailable for this project.").first()).toBeVisible();
    await expect(
      panel.getByText("Semantic comparison unavailable. Check the historical source status above."),
    ).toBeVisible();
  } finally {
    await server.stop();
  }
});
test("bad historical source exposes real diagnostics instead of current model fallback", async ({ page }) => {
  const server = await fixture(true, true);
  try {
    await page.goto(server.url);
    await openTool(page, "Compare revisions");
    const panel = page.getByRole("region", { name: "Compare Revisions" });
    await panel.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(panel.getByText("This historical source could not compile.")).toBeVisible();
    await expect(panel.locator(".accuracy-history li").first()).toBeVisible();
    await expect(
      panel.getByText("Semantic comparison unavailable. Check the historical source status above."),
    ).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("opened graph tools meet contrast and accessibility requirements", async ({ page }) => {
  const server = await fixture();
  try {
    await page.goto(server.url);
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await graphToolsTrigger(page).click();
    await expect(page.getByRole("button", { name: "Compare revisions", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await server.stop();
  }
});
