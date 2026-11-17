// The legend (ADR 0030) in a real browser, desktop and phone, both schemes:
// rows are buttons a tap toggles, with no modifier keys; One / All; All only
// when nothing is shared; the overlap note names the shared parts; tap targets
// are 44px on a phone and the legend stays within its share of the stage.
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const SOURCE =
  "flowchart LR\n  shopper[Shopper] e1@--> web[Web app]\n  web e2@--> api[Orders API]\n  api e3@--> db[(Orders DB)]\n  api e4@--> pay[Payment provider]\n";

for (const [label, size, touch] of [
  ["desktop", { width: 1440, height: 900 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const)
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${label} ${scheme}`, () => {
      test.use({ hasTouch: touch, isMobile: touch });
      test(`rows toggle with a tap; One / All; overlap opens one at a time`, async ({ page }) => {
        await page.setViewportSize(size);
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
          await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
          await server.setEmphasis("drawing", [
            {
              id: "parts",
              title: "Who handles what",
              groups: [
                {
                  id: "store",
                  label: "Storefront",
                  description: "Pages the shopper sees.",
                  style: "highlight",
                  nodes: ["web"],
                  edges: [],
                },
                {
                  id: "orders",
                  label: "Orders",
                  description: "Takes and stores orders.",
                  style: "highlight",
                  nodes: ["api", "db"],
                  edges: ["e3"],
                },
              ],
            },
          ]);
          // A phone docks the panel under the drawing as a chip that opens it as a sheet (G1, D5).
          if (touch) await page.locator(".archer-stage-dock .archer-dock-chip--panel").tap();
          const legend = page.getByRole("region", { name: "Highlights", exact: true });
          await expect(legend).toBeVisible();
          const row = (name: string) => legend.getByRole("button", { name: new RegExp(`^${name}`) });
          const all = legend.getByRole("button", { name: "All", exact: true });
          // Disjoint: opens on All, every row on.
          await expect(all).toHaveAttribute("aria-pressed", "true");
          await expect(row("Storefront")).toHaveAttribute("aria-pressed", "true");
          await expect(row("Orders")).toHaveAttribute("aria-pressed", "true");
          if (touch) {
            for (const target of [row("Storefront"), row("Orders"), all])
              expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            const box = await page.locator(".archer-dock-sheet").boundingBox();
            expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
            expect(box!.height).toBeLessThanOrEqual(size.height * 0.65 + 1);
          }
          // A plain tap turns a group off: it stops being drawn; nothing dims.
          if (touch) await row("Orders").tap();
          else await row("Orders").click();
          await expect(row("Orders")).toHaveAttribute("aria-pressed", "false");
          await expect(page.locator('.react-flow__node[data-id="api"]')).not.toHaveClass(/archer-emph/);
          expect(
            await page
              .locator('.react-flow__node[data-id="db"]')
              .evaluate((element) => getComputedStyle(element).opacity),
          ).toBe("1");
          // Overlapping groups: One, All disabled, the shared part named.
          await server.setEmphasis("drawing", [
            {
              id: "paths",
              title: "Two paths",
              groups: [
                {
                  id: "checkout",
                  label: "Checkout path",
                  style: "highlight",
                  nodes: ["shopper", "web", "api", "pay"],
                  edges: ["e1", "e2", "e4"],
                },
                { id: "storage", label: "Storage", style: "highlight", nodes: ["api", "db"], edges: ["e3"] },
              ],
            },
          ]);
          await expect(legend.getByRole("button", { name: "One", exact: true })).toHaveAttribute(
            "aria-pressed",
            "true",
          );
          await expect(all).toBeDisabled();
          await expect(legend).toContainText("These share Orders API, so they show one at a time.");
          await expect(row("Checkout path")).toHaveAttribute("aria-pressed", "true");
          await expect(row("Storage")).toHaveAttribute("aria-pressed", "false");
          if (touch) await row("Storage").tap();
          else await row("Storage").click();
          await expect(row("Storage")).toHaveAttribute("aria-pressed", "true");
          await expect(row("Checkout path")).toHaveAttribute("aria-pressed", "false");
          await expect(page.locator('.react-flow__node[data-id="web"]')).not.toHaveClass(/archer-emph/);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } finally {
          await server.stop();
        }
      });
    });
  }
