// "Curved lines" in Archer Settings, in a real browser, in both schemes (`mermaid-curve.ts`, `curved-lines.ts`).
// Off, the lines turn square corners (rounded at 10px with quadratic `Q`s). On, the boxes stay where they were and
// each line is one smooth run of true cubic curves (`C`) from box border to box border, Mermaid style; the pointer
// band follows it, each arrowhead's tip touches its box, the choice survives a reload, a hovered node's own lines
// still stand out, and no curve enters a box.
import { expect, test, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

// Two paths from Customer to Ledger: the long one (e6) runs under the rest and turns four times.
const SOURCE = [
  "flowchart LR",
  "  a[Customer] e1@--> b[Shop]",
  "  b e2@--> c[Bank]",
  "  a e3@--> d[Courier]",
  "  d e4@--> c",
  "  c e5@--> e[Ledger]",
  "  a e6@--> e",
  "",
].join("\n");
const EDGES = ["e1", "e2", "e3", "e4", "e5", "e6"];
const ENDS: Record<string, readonly [string, string]> = {
  e1: ["a", "b"],
  e2: ["b", "c"],
  e3: ["a", "d"],
  e4: ["d", "c"],
  e5: ["c", "e"],
  e6: ["a", "e"],
};

const pathOf = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
const bandOf = (page: Page, id: string) =>
  page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-interaction`);

async function setCurved(page: Page, on: boolean): Promise<void> {
  const launcher = page.getByRole("button", { name: "Archer settings" });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Archer Settings" });
  const toggle = dialog.getByRole("checkbox", { name: "Curved lines" });
  await expect(toggle).toBeVisible();
  // From the keyboard, as a person does: Tab to it and press Space.
  await toggle.focus();
  await expect(toggle).toBeFocused();
  if ((await toggle.isChecked()) !== on) await page.keyboard.press("Space");
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/** Points along each drawn line, on screen, and the screen boxes of every node. */
async function geometry(page: Page) {
  return page.evaluate((ids) => {
    const lines: Record<string, { x: number; y: number }[]> = {};
    for (const id of ids) {
      const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`)!;
      const matrix = path.getScreenCTM()!;
      const total = path.getTotalLength();
      const points: { x: number; y: number }[] = [];
      for (let at = 0; at <= total; at += 2) {
        const p = path.getPointAtLength(at).matrixTransform(matrix);
        points.push({ x: p.x, y: p.y });
      }
      lines[id] = points;
    }
    const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const node of document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
      const box = node.getBoundingClientRect();
      boxes[node.dataset.id!] = { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    return { lines, boxes };
  }, EDGES);
}

for (const scheme of ["light", "dark"] as const) {
  test(`curved lines turn wide curves that stay out of every box and survive a reload: ${scheme}`, async ({ page }) => {
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
      await expect(page.locator('.react-flow__node[data-id="e"]')).toBeVisible();
      await page.mouse.move(1200, 780);

      // Off by default: square corners, no cubic curves.
      for (const id of EDGES) await expect(pathOf(page, id)).not.toHaveAttribute("d", / C /);
      const square = await pathOf(page, "e6").getAttribute("d");

      await setCurved(page, true);
      await expect(pathOf(page, "e6")).toHaveAttribute("d", / C /);
      const curved: Record<string, string> = {};
      for (const id of EDGES) {
        const d = (await pathOf(page, id).getAttribute("d"))!;
        curved[id] = d;
        // One smooth curve from node to node: cubic pieces only (or one straight run), never a sampled polyline.
        expect(d, id).toMatch(/^M [\d.,-]+(( C [\d.,-]+ [\d.,-]+ [\d.,-]+)+| L [\d.,-]+)$/);
        // The click band is the same curve as the line.
        await expect(bandOf(page, id)).toHaveAttribute("d", d);
      }
      expect(curved.e6).not.toBe(square);

      // Kept in this browser: the reload draws curves again, the same ones.
      await page.reload();
      await expect(page.locator('.react-flow__node[data-id="e"]')).toBeVisible();
      await page.mouse.move(1200, 780);
      for (const id of EDGES) await expect(pathOf(page, id)).toHaveAttribute("d", curved[id]!);

      // No curve enters a box: not another node, and not its own ends beyond the point where it meets them.
      const { lines, boxes } = await geometry(page);
      for (const id of EDGES) {
        for (const [node, box] of Object.entries(boxes)) {
          const own = ENDS[id]!.includes(node);
          const inset = own ? 2 : -1;
          const inside = lines[id]!.filter(
            (p) =>
              p.x > box.x + inset &&
              p.x < box.x + box.width - inset &&
              p.y > box.y + inset &&
              p.y < box.y + box.height - inset,
          );
          expect(inside, `${id} inside ${node}`).toEqual([]);
        }
      }

      // Each arrowhead points into its box the way the curve arrives: carried on along the end tangent, the line
      // goes into its target.
      for (const id of EDGES) {
        const target = boxes[ENDS[id]![1]]!;
        const ahead = await pathOf(page, id).evaluate((element) => {
          const path = element as SVGPathElement;
          const matrix = path.getScreenCTM()!;
          const total = path.getTotalLength();
          const tip = path.getPointAtLength(total).matrixTransform(matrix);
          const near = path.getPointAtLength(total - 0.5).matrixTransform(matrix);
          const l = Math.hypot(tip.x - near.x, tip.y - near.y) || 1;
          return {
            x: tip.x + ((tip.x - near.x) / l) * 4,
            y: tip.y + ((tip.y - near.y) / l) * 4,
            tip: { x: tip.x, y: tip.y },
          };
        });
        // The tip touches the box's border: neither short of it nor inside.
        const gap = Math.hypot(
          Math.max(target.x - ahead.tip.x, 0, ahead.tip.x - (target.x + target.width)),
          Math.max(target.y - ahead.tip.y, 0, ahead.tip.y - (target.y + target.height)),
        );
        expect(gap, `${id} tip on ${ENDS[id]![1]}`).toBeLessThan(1.5);
        expect(
          ahead.x > target.x &&
            ahead.x < target.x + target.width &&
            ahead.y > target.y &&
            ahead.y < target.y + target.height,
          `${id} heads into ${ENDS[id]![1]}`,
        ).toBe(true);
      }

      // A hovered node's own lines still stand out, and stay curved.
      const accent = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.color = "var(--accent)";
        document.querySelector(".react-flow")!.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      await page.locator('.react-flow__node[data-id="a"]').hover();
      for (const id of ["e1", "e3", "e6"]) {
        await expect(page.locator(`.react-flow__edge[data-id="${id}"]`)).toHaveClass(/archer-edge-attached/);
        await expect.poll(async () => pathOf(page, id).evaluate((p) => getComputedStyle(p).stroke)).toBe(accent);
        await expect(pathOf(page, id)).toHaveAttribute("d", curved[id]!);
      }

      // And off again puts the square corners back.
      await page.mouse.move(1200, 780);
      await setCurved(page, false);
      await expect(pathOf(page, "e6")).toHaveAttribute("d", square!);
    } finally {
      await server.stop();
    }
  });
}
