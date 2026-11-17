/** The reported arrows, through Mermaid, ELK and the actual SVG renderer. */
import { roundedRoute, terminalStraightLength } from "../../src/diagrams/rounded-route";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Locator } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "../../../ts/test/fixtures/pageturner/.archer/diagrams");
let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});
async function open(page: Page, diagram: "containers" | "deployment" | "bidirectional"): Promise<void> {
  const kind = diagram === "deployment" ? "architecture" : "c4";
  project = await sharedTsProject({
    files: {
      "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${kind}"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n`,
      ".archer/drawing.mmd": readFileSync(
        diagram === "bidirectional"
          ? resolve(HERE, "../../../ts/test/fixtures/c4/widened.mmd")
          : resolve(DEMO, `${diagram}.mmd`),
        "utf8",
      ),
    },
  });
  await page.goto(project.url);
  await project.present("drawing");
}
/** Measure straightness over the last 10 route units, independently of path commands. */
async function approach(path: Locator, at: "start" | "end"): Promise<{ deviation: number; length: number }> {
  return path.evaluate((element, at) => {
    const path = element as SVGPathElement;
    const total = path.getTotalLength();
    const position = (distance: number) => path.getPointAtLength(at === "end" ? total - distance : distance);
    const tip = position(0);
    const near = position(0.25);
    const behind = position(10);
    const dx = near.x - tip.x;
    const dy = near.y - tip.y;
    const tangent = Math.hypot(dx, dy);
    return {
      deviation: Math.abs((behind.x - tip.x) * dy - (behind.y - tip.y) * dx) / tangent,
      length: Math.hypot(behind.x - tip.x, behind.y - tip.y),
    };
  }, at);
}
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    for (const diagram of ["containers", "deployment"] as const) {
      test(`${diagram}: ${width}px ${theme} owner arrows keep the entire head approach straight`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await open(page, diagram);
        const edges = diagram === "containers" ? ["api--payments", "worker--jobs"] : ["backoffice--api", "api--queue"];
        for (const id of edges) {
          const path = page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
          await expect(path).toHaveAttribute("marker-end", /url/);
          const measured = await approach(path, "end");
          expect(measured.deviation, `${id}: the rounded bend enters the arrowhead's approach`).toBeLessThan(0.02);
          expect(measured.length, `${id}: a full 10 units remain straight`).toBeGreaterThan(9.98);
        }
        if (process.env.ARCHER_SHOTS) {
          const cue = page.locator(".archer-offscreen-cue-action", { hasText: "Show all" });
          if (await cue.isVisible()) await cue.click();
          let previous = "";
          await expect
            .poll(async () => {
              const current = await page.locator(".react-flow__viewport").getAttribute("style");
              const still = current !== "" && current === previous;
              previous = current ?? "";
              return still;
            })
            .toBe(true);
          await page.screenshot({ path: `${process.env.ARCHER_SHOTS}/arrow-${diagram}-${width}-${theme}.png` });
        }
      });
    }
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`bidirectional: ${width}px ${theme} preserves complete approaches at both ends`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await open(page, "bidirectional");
      const path = page.locator('.react-flow__edge[data-id="web--payments"] .react-flow__edge-path');
      for (const end of ["start", "end"] as const) {
        await expect(path).toHaveAttribute(`marker-${end}`, /url/);
        const measured = await approach(path, end);
        expect(measured.deviation).toBeLessThan(0.02);
        expect(measured.length).toBeGreaterThan(9.98);
      }
    });
  }

/** Measure the painted marker, its actual terminal shaft, and screen scale. */
async function markerGeometry(
  path: Locator,
): Promise<{ headPixels: number; headWidthPixels: number; shaft: number; markerDepth: number }> {
  return path.evaluate((element) => {
    const line = element as SVGPathElement;
    const reference = line
      .getAttribute("marker-end")!
      .slice(4, -1)
      .replace(/^["']|["']$/g, "")
      .slice(1);
    const marker = document.getElementById(reference) as unknown as SVGMarkerElement;
    if (marker === null) throw new Error("the edge's marker reference has no definition");
    const symbol = marker.querySelector("polyline") as SVGGraphicsElement;
    const box = symbol.getBBox();
    const markerScale = marker.markerWidth.baseVal.value / marker.viewBox.baseVal.width;
    const screen = line.getScreenCTM()!;
    const zoom = Math.hypot(screen.a, screen.b);
    const depth = (-box.x + Number.parseFloat(getComputedStyle(symbol).strokeWidth) / 2) * markerScale;
    const total = line.getTotalLength();
    const tip = line.getPointAtLength(total);
    const tangentPoint = line.getPointAtLength(total - 0.1);
    const dx = tangentPoint.x - tip.x;
    const dy = tangentPoint.y - tip.y;
    const length = Math.hypot(dx, dy);
    let straight = 0;
    for (let distance = 0.25; distance <= Math.min(120, total); distance += 0.25) {
      const point = line.getPointAtLength(total - distance);
      if (Math.abs((point.x - tip.x) * dy - (point.y - tip.y) * dx) / length > 0.05) break;
      straight = distance;
    }
    return {
      headPixels: -box.x * markerScale * zoom,
      headWidthPixels: box.height * markerScale * zoom,
      shaft: straight - depth,
      markerDepth: depth,
    };
  });
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    for (const diagram of ["containers", "deployment"] as const) {
      test(`${diagram}: ${width}px ${theme} marker has a readable head and a separate straight shaft after Show all`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await open(page, diagram);
        await expect(page.locator(".react-flow__node").first()).toBeVisible();
        await page.locator(".react-flow__controls-fitview").click();
        let previous = "";
        await expect
          .poll(async () => {
            const current = await page.locator(".react-flow__viewport").getAttribute("style");
            const still = current !== "" && current === previous;
            previous = current ?? "";
            return still;
          })
          .toBe(true);
        const ids = diagram === "containers" ? ["api--payments", "worker--jobs"] : ["backoffice--api", "api--queue"];
        for (const id of ids) {
          const path = page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
          const measured = await markerGeometry(path);
          await test
            .info()
            .attach(`${id}-geometry`, { body: JSON.stringify(measured), contentType: "application/json" });
          expect(
            measured.shaft,
            `${id}: the painted arrowhead must not consume the turn; ${JSON.stringify(measured)}`,
          ).toBeGreaterThanOrEqual(11.5);
          expect(
            measured.headPixels,
            `${id}: a visible arrowhead needs at least four screen pixels along its direction`,
          ).toBeGreaterThanOrEqual(3.98);
          expect(
            measured.headWidthPixels,
            `${id}: the arrowhead must be visible across the shaft`,
          ).toBeGreaterThanOrEqual(3.98);
        }
        if (process.env.ARCHER_SHOTS)
          await page.screenshot({ path: `${process.env.ARCHER_SHOTS}/marker-${diagram}-${width}-${theme}.png` });
      });
    }

// The bound is compared with Chromium's actual path, not another route parser.
test("terminal bounds follow the rounded SVG for duplicate and collinear terminal points", async ({ page }) => {
  const routes = [
    [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 40 },
      { x: 80, y: 40 },
    ],
    [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 20 },
      { x: 80, y: 60 },
    ],
    [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 10 },
    ],
  ];
  for (const route of routes)
    for (const points of [route, [...route].reverse()]) {
      const ends = { arrowEnd: true };
      const available = terminalStraightLength(points, "end", ends);
      await page.setContent(
        `<svg width="400" height="400"><path id="route" d="${roundedRoute(points, ends)}" /></svg>`,
      );
      const deviation = await page.locator("#route").evaluate((element, distance) => {
        const line = element as SVGPathElement;
        const total = line.getTotalLength();
        const tip = line.getPointAtLength(total);
        const near = line.getPointAtLength(total - 0.1);
        const point = line.getPointAtLength(total - distance);
        return (
          Math.abs((point.x - tip.x) * (near.y - tip.y) - (point.y - tip.y) * (near.x - tip.x)) /
          Math.hypot(near.x - tip.x, near.y - tip.y)
        );
      }, available);
      expect(deviation, JSON.stringify(points)).toBeLessThan(0.02);
    }
});
