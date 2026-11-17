// A node's own connections stand out while the pointer is on it, in a real browser, in both schemes
// (`ATTACHED_EDGE_CLASS`, layout eval 2026-11-15). Hovering a node draws each line with an end on it in the
// accent, heavier than a resting line and lighter than a selected one; leaving the node puts them back. The
// accent clears 3:1 on the canvas. Only the node's own lines change on hover: no other edge is touched, so a
// hover is not a re-render of the drawing (bug class 10).
import { expect, test, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = "flowchart LR\n  a[Customer] e1@--> b[Shop]\n  b e2@--> c[Bank]\n  c e3@--> d[Ledger]\n";

function luminance([r, g, b]: readonly number[]): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v! / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
}
const rgb = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((token) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${token})`;
    document.querySelector(".react-flow")!.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

const stroke = (page: Page, id: string) =>
  page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate((path) => {
    const computed = getComputedStyle(path);
    return { color: computed.stroke, width: parseFloat(computed.strokeWidth) };
  });

for (const scheme of ["light", "dark"] as const) {
  test(`hovering a node draws its own lines in the accent: ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const server = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
        ".archer/drawing.mmd": SOURCE,
      },
    });
    try {
      await server.present("drawing");
      await page.goto(server.url);
      const shop = page.locator('.react-flow__node[data-id="b"]');
      await expect(shop).toBeVisible();
      // Away from the sidebar's hover edge before anything is read (`archer-ui-verification`, class 3).
      await page.mouse.move(1200, 780);

      const resting = await stroke(page, "e1");
      const accent = await token(page, "--accent");
      const bg = await token(page, "--bg");
      expect(contrast(accent, bg), `accent ${accent} on ${bg}`).toBeGreaterThanOrEqual(3);

      // Watch every edge that is not the node's own: a hover must not touch it.
      await page.evaluate(() => {
        const w = window as unknown as { __edgeMutations: number };
        w.__edgeMutations = 0;
        const other = document.querySelector('.react-flow__edge[data-id="e3"]')!;
        new MutationObserver((records) => (w.__edgeMutations += records.length)).observe(other, {
          attributes: true,
          subtree: true,
          childList: true,
        });
      });

      await shop.hover();
      for (const id of ["e1", "e2"]) {
        await expect(page.locator(`.react-flow__edge[data-id="${id}"]`)).toHaveClass(/archer-edge-attached/);
        await expect.poll(async () => (await stroke(page, id)).color, `${id} stroke`).toBe(accent);
        const { width } = await stroke(page, id);
        expect(width, `${id} width`).toBeGreaterThan(resting.width);
        expect(width, `${id} width`).toBeLessThan(6);
      }
      await expect(page.locator('.react-flow__edge[data-id="e3"]')).not.toHaveClass(/archer-edge-attached/);
      expect((await stroke(page, "e3")).color).toBe(resting.color);

      await page.mouse.move(1200, 780);
      await expect(page.locator(".react-flow__edge.archer-edge-attached")).toHaveCount(0);
      await expect.poll(async () => (await stroke(page, "e1")).color).toBe(resting.color);
      expect(await page.evaluate(() => (window as unknown as { __edgeMutations: number }).__edgeMutations)).toBe(0);
    } finally {
      await server.stop();
    }
  });
}
