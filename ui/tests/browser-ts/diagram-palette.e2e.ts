/**
 * The diagram palette as painted (DESIGN.md, "Diagram palette"; owner, 2026-11-11), in both themes, at
 * scale 1: inked connections and borders, a 700 title over a 400 description in the same full ink that stays
 * inside its box, neutral structure (a clear outer panel, a pale nested one), light cards in a family panel,
 * and the owner's `gpu` (teal) and `sandbox` (rust, dashed) categories (owner, 2026-11-12). The unit tests hold the tokens and the measurement; this holds what reaches the
 * screen.
 */
import { expect, test, type Page } from "@playwright/test";
import { grab, park, ratio, type Rgb } from "./support/pixels";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = `flowchart TB
  you["You<br/>A laptop or a phone, at home or away"]:::person
  subgraph farm["Agent Farm"]
    core["Farm Core<br/>The board, the chat, the task store, and a documented API that agents can read"]
    staging["Staging VM<br/>No real keys or data"]:::sandbox
  end
  subgraph cluster["Cluster"]
    gateway["Model Gateway<br/>One API in front of every model server"]
    subgraph gpu1["GPU 1"]
      model["Model Server"]
    end
    subgraph pool["Pool"]
      spare["Spare"]
    end
  end
  you you_core@--> core
  core core_gateway@--> gateway
  staging staging_gateway@--> gateway
  gateway gateway_model@--> model
  gateway gateway_spare@--> spare
  class gpu1 gpu
  classDef gpu fill:#ecfdf5,stroke:#0f766e
  classDef sandbox fill:#fdf1e7,stroke:#c2410c,stroke-dasharray: 5 3
`;

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const px = (value: string): number => Number.parseFloat(value);
/** `#rrggbb` or `rgb(r, g, b)`, as a computed style or a token gives it. */
const channels = (css: string): Rgb => {
  const value = css.trim();
  if (value.startsWith("#")) {
    // The build minifies a token to three digits where it can (`#ffffff` is served as `#fff`).
    const hex = value.length === 4 ? `#${[...value.slice(1)].map((digit) => digit + digit).join("")}` : value;
    return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
  }
  return value
    .match(/\d+(\.\d+)?/g)!
    .slice(0, 3)
    .map(Number) as unknown as Rgb;
};
const token = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** Zoom 1, so a CSS pixel is a screen pixel: what the owner judged lines by. */
async function atScaleOne(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const [, , , , x, y] = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).toFloat64Array();
    viewport.style.transform = `translate(${x}px, ${y}px) scale(1)`;
  });
}

for (const scheme of ["light", "dark"] as const)
  test(`the diagram palette is painted in ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const project = await sharedTsProject({
      files: {
        "archer.toml": `version = 1\n[[views]]\nid = "rig"\nkind = "freeform"\ntitle = "Rig"\nsource = ".archer/rig.mmd"\n`,
        ".archer/rig.mmd": SOURCE,
      },
    });
    try {
      await page.goto(project.url);
      await project.present("rig");
      await expect(node(page, "core")).toBeVisible();
      await atScaleOne(page);
      await park(page);

      // A. Inked lines: 2px connections, 1.5px node borders, 2px group borders (owner, 2026-11-15: lighter, less
      // cartoony), at 4.5:1 or more on the canvas.
      const edge = page.locator('.react-flow__edge[data-id="core_gateway"] .react-flow__edge-path');
      expect(px(await edge.evaluate((el) => getComputedStyle(el).strokeWidth))).toBe(2);
      // 1.5px as authored; Chromium draws a border over 1px in whole pixels, so it may compute 1px.
      const border = px(await node(page, "core").evaluate((el) => getComputedStyle(el).borderTopWidth));
      expect(border).toBeGreaterThanOrEqual(1);
      expect(border).toBeLessThanOrEqual(1.5);
      const frame = page.locator('.react-flow__node[data-id="group:farm"]');
      expect(px(await frame.evaluate((el) => getComputedStyle(el).borderTopWidth))).toBeGreaterThanOrEqual(2);
      const canvas = channels(await token(page, "--bg"));
      const stroke = channels(await edge.evaluate((el) => getComputedStyle(el).stroke));
      expect(ratio(stroke, canvas), "connection on the canvas").toBeGreaterThanOrEqual(4.5);
      // Painted, not only computed: the darkest (light) or brightest (dark) pixel across the line is its ink.
      const box = (await edge.boundingBox())!;
      const across = await grab(page, { x: box.x - 4, y: box.y + box.height / 2 - 1, width: box.width + 8, height: 3 });
      let best = 1;
      for (let x = 0; x < across.w; x++) best = Math.max(best, ratio(across.get(x, 1), canvas));
      expect(best, "painted connection on the canvas").toBeGreaterThanOrEqual(4.5);
      const plain = channels(await token(page, "--node-border"));
      expect(ratio(plain, canvas), "neutral node border on the canvas").toBeGreaterThanOrEqual(4.5);

      // B. A 700 (bold) title over 400 description rows, all inside the node.
      for (const id of ["core", "gateway", "you"]) {
        const rows = node(page, id).locator(".archer-node-label-row");
        expect(await rows.first().evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700");
        // Every row after the title is the description, at 400 (polled: the rows fill as the node renders).
        await expect
          .poll(() => rows.evaluateAll((els) => els.slice(1).map((el) => getComputedStyle(el).fontWeight)), {
            message: id,
          })
          .toEqual(expect.arrayContaining(["400"]));
        const weights = await rows.evaluateAll((els) => els.slice(1).map((el) => getComputedStyle(el).fontWeight));
        for (const weight of weights) expect(weight, id).toBe("400");
        const inside = await node(page, id).evaluate((el) => {
          const outer = el.getBoundingClientRect();
          return [...el.querySelectorAll(".archer-node-label-row")].every((row) => {
            const range = document.createRange();
            range.selectNodeContents(row);
            const r = range.getBoundingClientRect();
            return r.left >= outer.left && r.right <= outer.right && r.top >= outer.top && r.bottom <= outer.bottom;
          });
        });
        expect(inside, `${id}'s text inside its box`).toBe(true);
        // The description is the title's own full ink, never the chrome's dim grey.
        const inks = await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
        expect(new Set(inks).size, `${id}'s rows in one ink`).toBe(1);
      }

      // D. Plain structure is neutral: the outermost group a clear panel with the dark outline, a nested one
      // the pale step with the quieter outline, and a plain node in either is the neutral slate card.
      const backgroundOf = async (locator: ReturnType<Page["locator"]>) =>
        channels(await locator.evaluate((el) => getComputedStyle(el).backgroundColor));
      const borderOf = async (locator: ReturnType<Page["locator"]>) =>
        channels(await locator.evaluate((el) => getComputedStyle(el).borderTopColor));
      const cluster = page.locator('.react-flow__node[data-id="group:cluster"]');
      await expect(frame).not.toHaveClass(/archer-family-/);
      await expect(cluster).not.toHaveClass(/archer-family-/);
      expect(await backgroundOf(frame)).toEqual(channels(await token(page, "--group-bg")));
      expect(await borderOf(frame)).toEqual(channels(await token(page, "--group-border")));
      const pool = page.locator('.react-flow__node[data-id="group:pool"]');
      await expect(pool).toHaveClass(/archer-group-nested/);
      expect(await backgroundOf(pool)).toEqual(channels(await token(page, "--group-bg-alt")));
      expect(await borderOf(pool)).toEqual(channels(await token(page, "--group-border-alt")));
      await expect(node(page, "core")).not.toHaveClass(/archer-family-/);
      expect(await backgroundOf(node(page, "core"))).toEqual(channels(await token(page, "--node-bg")));
      await expect(node(page, "you")).toHaveClass(/archer-family-violet/);

      // E. The owner's categories: the gpu panel teal, its plain node a light card in teal border and ink; the
      // sandbox rust and dashed.
      const gpu = page.locator('.react-flow__node[data-id="group:gpu1"]');
      await expect(gpu).toHaveClass(/archer-family-teal/);
      expect(await backgroundOf(gpu)).toEqual(channels(await token(page, "--family-teal-panel")));
      expect(await backgroundOf(node(page, "model"))).toEqual(channels(await token(page, "--family-teal-card")));
      expect(await borderOf(node(page, "model"))).toEqual(channels(await token(page, "--family-teal-border")));
      const modelInk = channels(await node(page, "model").evaluate((el) => getComputedStyle(el).color));
      expect(modelInk).toEqual(channels(await token(page, "--family-teal-ink")));
      await expect(node(page, "staging")).toHaveClass(/archer-family-rust/);
      await expect(node(page, "staging")).toHaveClass(/archer-category-dashed/);
      expect(await node(page, "staging").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
      expect(await borderOf(node(page, "staging"))).toEqual(channels(await token(page, "--family-rust-border")));

      // C. Words read on every box (4.5:1 or more); in dark the borders are bright on the canvas.
      for (const id of ["you", "core", "model", "staging"]) {
        const box = node(page, id);
        const words = channels(await box.evaluate((el) => getComputedStyle(el).color));
        expect(ratio(words, await backgroundOf(box)), `${id}'s words on its fill`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(await borderOf(box), canvas), `${id}'s border on the canvas`).toBeGreaterThanOrEqual(3);
      }
      const caption = gpu.locator(".archer-frame-caption");
      const ink = channels(await caption.evaluate((el) => getComputedStyle(el).color));
      expect(ratio(ink, await backgroundOf(gpu)), "gpu caption on its panel").toBeGreaterThanOrEqual(4.5);
    } finally {
      await project.stop();
    }
  });
