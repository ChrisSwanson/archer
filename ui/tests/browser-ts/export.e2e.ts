import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { graphToolsTrigger, openGraphTool } from "./support/primary-navigation";
import { createExportRuntime, type ExportRuntime } from "./support/export-runtime";

const test = base.extend<{}, { exportRuntime: ExportRuntime }>({
  exportRuntime: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a fixture's first argument to be destructured.
    async ({}, use) => {
      const runtime = await createExportRuntime();
      try {
        await use(runtime);
      } finally {
        await runtime.close();
      }
    },
    { scope: "worker" },
  ],
});

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
async function fixture(runtime: ExportRuntime, gitHistory = true) {
  return runtime.startProject({ gitHistory });
}
async function download(page: Page, dir: string) {
  const pending = page.waitForEvent("download");
  await page
    .getByRole("region", { name: "Export Diagram" })
    .getByRole("button", { name: "Download", exact: true })
    .click();
  const result = await pending;
  const path = join(dir, result.suggestedFilename());
  await result.saveAs(path);
  return { filename: result.suggestedFilename(), bytes: readFileSync(path) };
}
async function svgInfo(page: Page, bytes: Buffer) {
  return page.evaluate((source) => {
    const svg = new DOMParser().parseFromString(source, "image/svg+xml");
    return {
      provenance: JSON.parse(svg.querySelector("#archer-export-provenance")!.textContent!),
      background: svg.querySelector("svg > rect")?.getAttribute("fill"),
      emphasis: svg.querySelector("[data-emphasis]")?.getAttribute("data-emphasis") ?? null,
      text: svg.documentElement.textContent,
      animation: svg.querySelectorAll("animate,animateMotion,animateTransform").length,
    };
  }, bytes.toString("utf8"));
}
for (const phone of [false, true]) {
  test(`real SVG/PNG export choices, focus and full canvas footprint, phone=${phone}`, async ({
    page,
    exportRuntime,
  }) => {
    // This case starts an isolated service from the worker's production
    // runtime and verifies eight real artifacts. An earlier cold-bundle run
    // spent 16.5s in setup and 27.3s on its first
    // SVG, exceeding the suite's 45s total bound before the matrix finished.
    // Keep one bounded run with every artifact assertion and no retries.
    test.setTimeout(90_000);
    const server = await fixture(exportRuntime);
    try {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(server.url);
      await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Checkout flow", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // The page itself never scrolls: the hidden copy of the agent's caption once sat past its foot, and
      // focusing the export panel scrolled the whole page (and the canvas) up by that much.
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
        "the page overflows the window",
      ).toBe(0);
      const canvas = page.locator(".react-flow"),
        before = await canvas.boundingBox();
      await openTool(page, "Export diagram");
      const panel = page.getByRole("region", { name: "Export Diagram" });
      await expect(panel.getByLabel("File type")).toBeFocused();
      if (phone) {
        // The sidebar is a drawer at phone width, closed while a tool is open: it cannot paint over the panel.
        await expect
          .poll(() => page.locator(".primary-navigation").evaluate((el) => getComputedStyle(el).visibility), {
            message: "the closed drawer is out of the way of the artifact surface",
          })
          .toBe("hidden");
        await panel.getByRole("combobox", { name: "Content", exact: true }).selectOption("presentation");
        const captionCheckbox = panel.getByLabel("Include caption");
        expect(
          await captionCheckbox.evaluate((input) => {
            const box = input.getBoundingClientRect();
            return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input;
          }),
          "the visible caption checkbox receives its actual pointer hit",
        ).toBe(true);
      }
      expect(await canvas.boundingBox()).toEqual(before);
      const point = await freeCanvasPoint(page);
      expect(
        await page.evaluate(({ x, y }) => {
          const e = document.elementFromPoint(x, y);
          return {
            canvas: !!e?.closest(".react-flow"),
            overlay: !!e?.closest(".archer-artifact-panel,.archer-diagram-key,.react-flow__controls"),
          };
        }, point),
      ).toEqual({ canvas: true, overlay: false });
      const viewport = page.locator(".react-flow__viewport"),
        transform = await viewport.getAttribute("style");
      await page.mouse.move(point.x, point.y);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(point.x + 40, point.y - 25, { steps: 8 });
      await page.mouse.up({ button: "middle" });
      await expect.poll(() => viewport.getAttribute("style")).not.toBe(transform);
      const backgrounds: string[] = [];
      for (const theme of ["light", "dark"])
        for (const mode of ["diagram", "presentation"]) {
          await panel.getByLabel("Export theme").selectOption(theme);
          await panel.getByRole("combobox", { name: "Content", exact: true }).selectOption(mode);
          await panel.getByLabel("File type").selectOption("svg");
          const svg = await download(page, server.dir),
            info = await svgInfo(page, svg.bytes);
          expect(svg.filename).toBe(`flow-${mode}-${theme}.svg`);
          expect(info.provenance.lastGood).toBe(false);
          expect(info.provenance.revision).toMatch(/^sha256:/);
          expect(info.provenance.activeEmphasisId).toBe(mode === "presentation" ? "focus" : null);
          expect(info.emphasis).toBe(mode === "presentation" ? "focus" : null);
          expect(info.text?.includes("Customer checkout")).toBe(mode === "presentation");
          // The key is in the presentation only. Its heading says so; "External" now also names the drawing's own
          // node kind (capitalised as on the page, redesign slice 8), so it no longer tells the key apart.
          expect(info.text?.includes("Diagram Key")).toBe(mode === "presentation");
          expect(info.animation).toBe(0);
          if (mode === "diagram") backgrounds.push(info.background!);
          await panel.getByLabel("File type").selectOption("png");
          const png = await download(page, server.dir);
          expect(png.filename).toBe(`flow-${mode}-${theme}.png`);
          expect([...png.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
          expect(png.bytes.readUInt32BE(16)).toBeGreaterThan(0);
          expect(png.bytes.readUInt32BE(20)).toBeGreaterThan(0);
        }
      expect(backgrounds[0]).not.toBe(backgrounds[1]);
      await panel.getByLabel("File type").selectOption("svg");
      await panel.getByRole("combobox", { name: "Content", exact: true }).selectOption("presentation");
      if (process.env.ARCHER_SHOTS)
        await page.screenshot({ path: phone ? "/tmp/archer-export-phone.png" : "/tmp/archer-export-desktop.png" });
      await panel.getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest(".archer-artifact-panel"))).toBe(false);
      await panel.getByLabel("File type").focus();
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(graphToolsTrigger(page)).toBeFocused();
      await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
      // Closing Export restores the canvas trigger. A second Escape
      // would dismiss the active emphasis before this toggle is tested.
      await expect(page.getByRole("button", { name: "Checkout flow", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByRole("button", { name: "Checkout flow", exact: true }).click();
      await expect(page.getByRole("button", { name: "Checkout flow", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await openTool(page, "Export diagram");
      await panel.getByRole("combobox", { name: "Content", exact: true }).selectOption("presentation");
      await panel.getByLabel("Include caption").uncheck();
      await panel.getByLabel("Include diagram key").uncheck();
      const dismissed = await svgInfo(page, (await download(page, server.dir)).bytes);
      expect(dismissed.provenance.activeEmphasisId).toBeNull();
      expect(dismissed.emphasis).toBeNull();
      expect(dismissed.text?.includes("Customer checkout")).toBe(false);
      expect(dismissed.text?.includes("Diagram Key")).toBe(false);
    } finally {
      await server.stop();
    }
  });
}
test("broken current source requires explicit last-good consent, no automatic retry", async ({
  page,
  exportRuntime,
}) => {
  // This case previously measured 8.1s navigating, 12.0s
  // rendering and 24.0s downloading before its final provenance assertion.
  // Match the bounded real-export budget above; retain every assertion and no retries.
  test.setTimeout(90_000);
  const server = await fixture(exportRuntime);
  try {
    await page.goto(server.url);
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await server.breakSource();
    await expect(page.getByRole("alert").filter({ hasText: "last version" })).toBeVisible();
    const requests: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("api/operations")) {
        const body = request.postDataJSON();
        if (body.name === "export_diagram") requests.push(body.arguments);
      }
    });
    await openTool(page, "Export diagram");
    const panel = page.getByRole("region", { name: "Export Diagram" });
    await panel.getByRole("button", { name: "Download", exact: true }).click();
    await expect(panel.getByLabel("I choose the last-good drawing")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.allowLastGood).toBe(false);
    await expect(panel.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
    await panel.getByLabel("I choose the last-good drawing").check();
    const result = await download(page, server.dir);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.allowLastGood).toBe(true);
    expect(result.filename).toContain("last-good");
    expect((await svgInfo(page, result.bytes)).provenance.lastGood).toBe(true);
  } finally {
    await server.stop();
  }
});
for (const git of [true, false])
  test(`explicit current-view accuracy reflects real Git availability=${git}`, async ({ page, exportRuntime }) => {
    const server = await fixture(exportRuntime, git);
    try {
      await page.goto(server.url);
      await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
      const requests: unknown[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("api/operations")) {
          const body = request.postDataJSON();
          if (body.name === "list_stale_diagrams") requests.push(body.arguments);
        }
      });
      await openTool(page, "Check diagram accuracy");
      const panel = page.getByRole("region", { name: "Diagram Accuracy" });
      await expect(panel.getByRole("button", { name: "Check covered files" })).toBeFocused();
      expect(requests).toEqual([]);
      await panel.getByRole("button", { name: "Check covered files" }).click();
      await expect(panel.getByRole("status")).toHaveText(
        git ? "Covered files changed since the last diagram commit." : "Git accuracy is unavailable for this diagram.",
      );
      expect(requests).toEqual([{ viewId: "flow" }]);
      if (git) await expect(panel.getByText("src/api.ts", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
    } finally {
      await server.stop();
    }
  });

for (const state of [
  { name: "comparison", button: "Compare revisions", region: "Compare Revisions" },
  { name: "accuracy", button: "Check diagram accuracy", region: "Diagram Accuracy" },
  { name: "export", button: "Export diagram", region: "Export Diagram" },
  { name: "last-good consent", button: "Export diagram", region: "Export Diagram" },
])
  test(`axe covers ${state.name}`, async ({ page, exportRuntime }) => {
    // Each main state retains the original 45s budget and gets an independent
    // service/project fixture, so earlier audits cannot consume its interaction budget.
    const server = await fixture(exportRuntime);
    try {
      await page.goto(server.url);
      await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
      if (state.name === "last-good consent") await server.breakSource();
      await openTool(page, state.button);
      const panel = page.getByRole("region", { name: state.region, exact: true });
      await expect(panel).toBeVisible();
      if (state.name === "accuracy") {
        await panel.getByRole("button", { name: "Check covered files" }).click();
        await expect(panel.getByRole("status")).toContainText("Covered files changed");
      }
      if (state.name === "export")
        await panel.getByRole("combobox", { name: "Content", exact: true }).selectOption("presentation");
      if (state.name === "last-good consent") {
        await panel.getByRole("button", { name: "Download", exact: true }).click();
        await expect(panel.getByLabel("I choose the last-good drawing")).toBeVisible();
      }
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.passes.length).toBeGreaterThan(0);
      expect(results.violations, `${state.name} accessibility`).toEqual([]);
      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(graphToolsTrigger(page)).toBeFocused();
    } finally {
      await server.stop();
    }
  });
