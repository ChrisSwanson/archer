import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const variants = ["System", "Container", "Component"].flatMap((kind) =>
  [false, true].flatMap((external) =>
    ["Db", "Queue"].map((shape) => ({
      id: `${kind.toLowerCase()}${shape.toLowerCase()}${external ? "ext" : ""}`,
      declaration: `${kind}${shape}${external ? "_Ext" : ""}`,
      shape,
    })),
  ),
);
for (const scheme of ["light", "dark"] as const) {
  test(`all C4 storage symbols preserve caps and text in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const project = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "drawing"\nkind = "c4"\ntitle = "Symbols"\nsource = ".archer/drawing.mmd"\n',
        ".archer/drawing.mmd":
          "C4Component\n" +
          variants
            .map(
              (v) =>
                `  ${v.declaration}(${v.id}, "${v.id}", "Technology"${v.declaration.startsWith("System") ? "" : ', "Stores messages or records"'})`,
            )
            .join("\n"),
      },
    });
    try {
      await page.goto(project.url);
      await project.present("drawing");
      for (const v of variants) {
        const node = page.locator(`.react-flow__node[data-id="${v.id}"]`);
        await expect(node).toBeAttached();
        await expect(node.locator(".archer-c4-type")).toContainText(v.shape === "Queue" ? "queue" : "database");
        const textFits = await node.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const text = el.querySelector(".archer-c4-text")!.getBoundingClientRect();
          return text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom;
        });
        expect(textFits, `${v.declaration} text stays in its painted body`).toBe(true);
        if (v.shape === "Db") {
          const radius = await node.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
          expect(radius, `${v.declaration} must retain a cylindrical outline`).toBe("50% 7px");
          await expect(node.locator(".archer-c4-database-cap ellipse")).toHaveCount(1);
          const lidClear = await node.evaluate((el) => {
            const lid = el.querySelector(".archer-c4-database-cap")!.getBoundingClientRect();
            const text = el.querySelector(".archer-c4-text")!.getBoundingClientRect();
            return text.top > lid.bottom;
          });
          expect(lidClear, `${v.declaration} text clears the lid`).toBe(true);
        }
        if (v.shape === "Queue") {
          await expect(node.locator(".archer-c4-queue-cap ellipse")).toHaveCount(1);
          await expect(node.locator(".archer-c4-queue-slots")).toHaveCount(0);
          const geometry = await node.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const cap = el.querySelector("ellipse")!.getBoundingClientRect();
            const text = el.querySelector(".archer-c4-text")!.getBoundingClientRect();
            return {
              capRatio: cap.height / box.height,
              clear: text.right < cap.left,
              inside: text.left >= box.left && text.bottom <= box.bottom,
            };
          });
          expect(geometry.capRatio).toBeGreaterThan(0.9);
          expect(geometry.clear).toBe(true);
          expect(geometry.inside).toBe(true);
        }
      }
      if (process.env.ARCHER_SHOTS)
        await page.screenshot({ path: `${process.env.ARCHER_SHOTS}/storage-${scheme}.png` });
      // All storage variants must be in the painted viewport before testing
      // pointer states; focus alone does not pan a graph to an offscreen node.
      const showAll = page.getByRole("button", { name: /Show all/ });
      if (await showAll.count()) await showAll.click();
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      for (const shape of ["db", "queue"]) {
        const node = page.locator(`.react-flow__node[data-id="system${shape}"]`);
        await node.hover();
        const colours = () =>
          node.evaluate((el) => ({
            border: getComputedStyle(el).borderColor,
            cap: getComputedStyle(el.querySelector("ellipse")!).stroke,
          }));
        await expect
          .poll(async () => {
            const c = await colours();
            return c.cap === c.border;
          })
          .toBe(true);
        await node.click();
        await expect(node).toHaveClass(/selected/);
        await expect
          .poll(async () => {
            const c = await colours();
            return c.cap === c.border;
          })
          .toBe(true);
        await page.locator(".react-flow__pane").click({ position: { x: 1, y: 1 } });
        await page.mouse.move(0, 0);
        await expect(node).not.toHaveClass(/selected/);
        await project.setEmphasis("drawing", [
          {
            id: "storage",
            groups: [{ id: "g", label: "Storage", style: "highlight", nodes: [`system${shape}`], edges: [] }],
          },
        ]);
        await expect(node).toHaveClass(/archer-emph/);
        await expect
          .poll(async () => {
            const c = await colours();
            return c.cap === c.border;
          })
          .toBe(true);
      }
    } finally {
      await project.stop();
    }
  });
}
