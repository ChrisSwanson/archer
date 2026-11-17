import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sharedTsProject } from "./support/shared-service";

const cases = [
  {
    type: "graph",
    kind: "freeform",
    source: "flowchart LR\n a[Customer]:::external e1@--> b[Shop]\n",
    node: "a",
    drawing: ".react-flow",
  },
  {
    type: "sequence",
    kind: "sequence",
    source: readFileSync(resolve(import.meta.dirname, "../../../ts/test/fixtures/sequence/minimal.mmd"), "utf8"),
    node: "A",
    drawing: ".archer-seq-canvas",
  },
  {
    type: "journey",
    kind: "journey",
    source: readFileSync(resolve(import.meta.dirname, "../../../ts/test/fixtures/journey/minimal.mmd"), "utf8"),
    node: "search-the-shop",
    drawing: ".archer-journey-board",
  },
];
for (const width of [1440, 390])
  for (const diagram of cases) {
    test(`diagram key and emphasis have separate reachable footprints: ${diagram.type} ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const server = await sharedTsProject({
        files: {
          "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${diagram.kind}"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n`,
          ".archer/drawing.mmd": diagram.source,
        },
      });
      try {
        await page.goto(server.url);
        await server.present("drawing");
        const key = page.getByRole("region", { name: "Diagram Key", exact: true });
        const docked = width < 600;
        if (docked) await expect(page.locator(".archer-stage-dock .archer-dock-chip--panel")).toBeVisible();
        else await expect(key).toBeVisible();
        const drawing = page.locator(diagram.drawing);
        await server.setEmphasis("drawing", [
          {
            id: "focus",
            title: "Review focus",
            groups: Array.from({ length: 3 }, (_, i) => ({
              id: `group-${i}`,
              label: `Review group ${i}`,
              nodes: [diagram.node],
              edges: [],
              style: "highlight",
            })),
          },
        ]);
        const legend = page.getByRole("region", { name: "Highlights", exact: true });
        if (docked) {
          // A phone: the panel is a chip in the strip under the drawing, opening one sheet with both (G1, D5).
          const before = await drawing.boundingBox();
          const content = (await page.locator(".archer-diagram-content").boundingBox())!;
          const dock = page.locator(".archer-stage-dock");
          const chip = dock.locator(".archer-dock-chip--panel");
          expect((await chip.boundingBox())!.y).toBeGreaterThanOrEqual(content.y + content.height - 1);
          await chip.click();
          const last = legend.getByRole("button", { name: /^Review group 2/ });
          await last.scrollIntoViewIfNeeded();
          await expect(last).toBeInViewport();
          expect(
            await last.evaluate((e) => {
              const r = e.getBoundingClientRect();
              return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".archer-dock-sheet");
            }),
          ).toBe(true);
          await page.keyboard.press("Escape");
          await chip.click();
          const explanation = key.locator(".archer-diagram-key-voices");
          await explanation.scrollIntoViewIfNeeded();
          await expect(explanation).toBeInViewport();
          expect(await drawing.boundingBox()).toEqual(before);
          await page.screenshot({ path: `/tmp/archer-key-emphasis-${diagram.type}-${width}.png` });
          return;
        }
        await expect(legend).toBeVisible();
        // AgentBar appearance is intentional; disclosure must not change the settled canvas.
        const before = await drawing.boundingBox();
        const camera = () =>
          drawing.evaluate((element) => {
            const viewport =
              element.querySelector(".react-flow__viewport,.archer-seq-viewport") ??
              element.parentElement?.querySelector(".archer-seq-viewport");
            return {
              transform: viewport?.getAttribute("transform"),
              style: viewport?.getAttribute("style"),
              scrollLeft: element.scrollLeft,
              scrollTop: element.scrollTop,
            };
          });
        const beforeCamera = await camera();
        const keyBox = await key.boundingBox(),
          legendBox = await legend.boundingBox();
        const overlapWidth = Math.max(
          0,
          Math.min(keyBox!.x + keyBox!.width, legendBox!.x + legendBox!.width) - Math.max(keyBox!.x, legendBox!.x),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(keyBox!.y + keyBox!.height, legendBox!.y + legendBox!.height) - Math.max(keyBox!.y, legendBox!.y),
        );
        expect(overlapWidth * overlapHeight, "the emphasis legend must not cover the diagram key").toBe(0);
        expect(await drawing.boundingBox()).toEqual(before);
        const content = await page.locator(".archer-diagram-content").boundingBox();
        expect(legendBox!.y).toBeGreaterThanOrEqual(content!.y);
        expect(legendBox!.y + legendBox!.height).toBeLessThanOrEqual(content!.y + content!.height);
        const last = legend.getByRole("button", { name: /^Review group 2/ });
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
        expect(
          await last.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".archer-emph-legend");
          }),
        ).toBe(true);
        await last.focus();
        await expect(last).toBeFocused();
        // The Key opens expanded wherever it appears (owner, 2026-11-12, 2e9252e0), so its rows are already there,
        // beside the legend: it used to start closed and was opened here with a click.
        const keyButton = key.getByRole("button", { name: "Diagram Key", exact: true });
        await expect(keyButton).toHaveAttribute("aria-expanded", "true");
        const explanation = key.locator(".archer-diagram-key-voices");
        await explanation.scrollIntoViewIfNeeded();
        await expect(explanation).toBeInViewport();
        expect(
          await explanation.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".archer-diagram-key");
          }),
        ).toBe(true);
        expect(await drawing.boundingBox()).toEqual(before);
        expect(await camera()).toEqual(beforeCamera);
        // Free canvas: beside the toolbar's column on a phone; on a desktop the key and the legend rest at the left, so the right.
        const point = {
          x: width < 720 ? content!.x + 20 : content!.x + content!.width - 80,
          y: content!.y + content!.height / 2,
        };
        expect(
          await page.evaluate(({ x, y }) => {
            const e = document.elementFromPoint(x, y);
            return (
              !!e?.closest(".archer-diagram-content") &&
              !e.closest(".archer-diagram-key,.archer-emph-legend,.react-flow__controls,.archer-canvas-controls")
            );
          }, point),
        ).toBe(true);
        if (diagram.type === "graph") {
          const viewport = page.locator(".react-flow__viewport"),
            transform = await viewport.getAttribute("style");
          await page.mouse.move(point.x, point.y);
          await page.mouse.down({ button: "middle" });
          await page.mouse.move(point.x + 35, point.y + 20, { steps: 5 });
          await page.mouse.up({ button: "middle" });
          await expect.poll(() => viewport.getAttribute("style")).not.toBe(transform);
        }
        await page.screenshot({ path: `/tmp/archer-key-emphasis-${diagram.type}-${width}.png` });
      } finally {
        await server.stop();
      }
    });
  }
