// ADR 0030 in a real browser: an edge caption never hides its line. For every
// labelled edge, measured on the drawn path and the drawn plate, at least 12px
// of line shows between the plate and each end -- the arrowhead excluded --
// and no caption takes more than two lines.
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const SOURCES = {
  lr: "flowchart LR\n  web[Web app] e1@-->|Places order| api[Orders API]\n  api e2@<-->|Reads and writes| db[(Orders DB)]\n  api e3@-->|Charges card| pay[Payment provider]\n  api e4@-.->|Queues refund| queue[Refund queue]\n",
  tb: "flowchart TB\n  web[Web app] e1@-->|Places order| api[Orders API]\n  api e2@<-->|Reads and writes| db[(Orders DB)]\n  api e3@-->|Charges the customer card| pay[Payment provider]\n",
} as const;

for (const [direction, source] of Object.entries(SOURCES)) {
  test(`every caption leaves its line showing on both sides: ${direction}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
        ".archer/drawing.mmd": source,
      },
    });
    try {
      await server.present("drawing");
      await page.goto(server.url);
      await expect(page.locator(".archer-edge-label").first()).toBeVisible();
      const measured = await page.evaluate(() => {
        return [...document.querySelectorAll<HTMLElement>(".archer-edge-label")].map((plate) => {
          const id = plate.dataset.edgeId!;
          const path = document.querySelector<SVGPathElement>(
            `.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`,
          )!;
          const box = plate.getBoundingClientRect();
          const matrix = path.getScreenCTM()!;
          const length = path.getTotalLength();
          const scale = Math.hypot(matrix.a, matrix.b);
          const inside = (at: number) => {
            const p = path.getPointAtLength(at);
            const x = matrix.a * p.x + matrix.c * p.y + matrix.e;
            const y = matrix.b * p.x + matrix.d * p.y + matrix.f;
            return x > box.left && x < box.right && y > box.top && y < box.bottom;
          };
          let first = -1;
          let last = -1;
          for (let at = 0; at <= length; at += 0.5) {
            if (inside(at)) {
              if (first < 0) first = at;
              last = at;
            }
          }
          const marker = (end: "start" | "end") => path.getAttribute(`marker-${end}`) !== null;
          const head = 9;
          return {
            id,
            rows: plate.querySelectorAll(".archer-edge-label-row").length,
            before: first < 0 ? null : (first - (marker("start") ? head : 0)) * scale,
            after: first < 0 ? null : (length - last - (marker("end") ? head : 0)) * scale,
          };
        });
      });
      expect(measured.length).toBeGreaterThan(2);
      for (const edge of measured) {
        expect(edge.rows, `${edge.id} rows`).toBeLessThanOrEqual(2);
        if (edge.before === null) continue; // a caption beside its line hides nothing
        expect(edge.before, `${edge.id}: line before the plate`).toBeGreaterThanOrEqual(12);
        expect(edge.after, `${edge.id}: line after the plate`).toBeGreaterThanOrEqual(12);
      }
    } finally {
      await server.stop();
    }
  });
}
