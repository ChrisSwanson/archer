/** Companion coverage for the remaining C4 kinds and every built-in architecture icon. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";
const icons = ["cloud", "database", "disk", "internet", "server"];
const kinds = ["Person", "System", "Container", "Component"];
for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const) {
    for (const notation of ["c4", "architecture", "demo"] as const) {
      test(`${notation} silhouettes at ${width}px in ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        const plain = kinds.flatMap((kind) =>
          [false, true].map((external) => ({
            id: `${kind.toLowerCase()}${external ? "ext" : ""}`,
            kind,
            external,
          })),
        );
        const source =
          notation === "architecture"
            ? "architecture-beta\nservice plain[No icon]\n" +
              icons.map((icon) => `service ${icon}(${icon})[${icon}]`).join("\n")
            : notation === "demo"
              ? readFileSync(
                  resolve(import.meta.dirname, "../../../ts/test/fixtures/pageturner/.archer/diagrams/containers.mmd"),
                  "utf8",
                )
              : "C4Component\n" +
                plain
                  .map(
                    (v) =>
                      `${v.kind}${v.external ? "_Ext" : ""}(${v.id}, "${v.kind}", "${v.kind === "Container" || v.kind === "Component" ? 'Technology", "Description' : "Description"}")`,
                  )
                  .join("\n");
        const project = await sharedTsProject({
          files: {
            "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${notation === "architecture" ? "architecture" : "c4"}"\ntitle = "Silhouettes"\nsource = ".archer/drawing.mmd"\n`,
            ".archer/drawing.mmd": source,
          },
        });
        try {
          await page.goto(project.url);
          await project.present("drawing");
          if (notation === "architecture")
            for (const icon of icons) {
              const node = page.locator(`.react-flow__node[data-id="${icon}"]`);
              await expect(node.locator(`.archer-arch-icon-${icon}`)).toHaveCount(1);
              await expect(node).toHaveAttribute("aria-label", new RegExp(icon));
              expect(
                await node.evaluate((el) => {
                  const text = el.querySelector(".archer-service-text")!.getBoundingClientRect();
                  const box = el.getBoundingClientRect();
                  return (
                    text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom
                  );
                }),
              ).toBe(true);
            }
          if (notation === "architecture")
            await expect(page.locator('.react-flow__node[data-id="plain"] .archer-arch-icon')).toHaveCount(0);
          if (notation === "c4")
            for (const v of plain) {
              const node = page.locator(`.react-flow__node[data-id="${v.id}"]`);
              await expect(node).toHaveClass(new RegExp(`archer-c4-${v.kind.toLowerCase()}`));
              await expect(node.locator(".archer-c4-person-glyph")).toHaveCount(v.kind === "Person" ? 1 : 0);
              await expect(node.locator(".archer-c4-database-cap, .archer-c4-queue-cap")).toHaveCount(0);
              expect(await node.evaluate((el) => getComputedStyle(el).borderStyle)).toBe(
                v.external ? "dashed" : "solid",
              );
            }
          if (notation === "demo") await expect(page.locator(".archer-c4-database-cap ellipse")).toHaveCount(1);
          const showAll = page.getByRole("button", { name: "Show all" });
          if (await showAll.isVisible()) await showAll.click();
          let previous = "";
          await expect
            .poll(async () => {
              const current = await page.locator(".react-flow__viewport").getAttribute("style");
              const stable = current !== null && current === previous;
              previous = current ?? "";
              return stable;
            })
            .toBe(true);
          if (process.env.ARCHER_SHOTS)
            await page.screenshot({ path: `${process.env.ARCHER_SHOTS}/${notation}-${width}-${scheme}.png` });
        } finally {
          await project.stop();
        }
      });
    }
  }
