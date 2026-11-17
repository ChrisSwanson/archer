import { expect, test } from "@playwright/test";
import { expectChevronsMoving } from "./support/emphasis-motion";
import { openFile } from "./support/primary-navigation";
import { sharedTsProject } from "./support/shared-service";

for (const width of [1440, 390])
  for (const diagram of [
    { kind: "freeform", source: "flowchart LR\n a[Customer] e1@--> b[Shop]\n", edge: "e1" },
    {
      kind: "sequence",
      source: "sequenceDiagram\n participant A as Customer\n participant B as Shop\n A->>B: Request\n",
      edge: "msg-0",
    },
  ]) {
    test(`${diagram.kind} flow arrows move on publication and reload, and keep moving under reduced motion until Auto is chosen at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const server = await sharedTsProject({
        files: {
          "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${diagram.kind}"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n`,
          ".archer/drawing.mmd": diagram.source,
        },
      });
      try {
        await server.present("drawing");
        await page.goto(server.url);
        await expect(page.locator(".react-flow__node, .archer-seq-participant").first()).toBeVisible();
        await server.setEmphasis("drawing", [
          {
            id: "path",
            title: "Request flow",
            groups: [{ id: "request", label: "request", style: "flow", edges: [diagram.edge], nodes: [] }],
          },
        ]);
        const packet = page.locator(`.archer-emph-chevrons[data-edge="${diagram.edge}"]`);
        await expectChevronsMoving(packet);
        await page.reload();
        await expectChevronsMoving(packet);
        // Flow animation is On by default: a browser asking for less motion does not stop it on its own.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectChevronsMoving(packet);
        await page.reload();
        await expectChevronsMoving(packet);
        const control = page.getByRole("combobox", { name: "Flow animation", exact: true });
        // A phone keeps the legend, and so this control, in a sheet its dock chip opens (G1).
        const legendOpen = async (): Promise<void> => {
          if (width === 390 && (await page.locator(".archer-dock-sheet").count()) === 0)
            await page
              .locator(".archer-stage-dock")
              .getByRole("button", { name: /^Highlights/ })
              .click();
        };
        await legendOpen();
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
        await expect(control).toHaveValue("on");
        if (width === 390) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        // Auto follows the browser: still, and still after a reload.
        await control.selectOption("auto");
        await expect(packet).toBeVisible();
        await expect(packet.locator("animateMotion")).toHaveCount(0);
        await page.reload();
        await legendOpen();
        await expect(control).toHaveValue("auto");
        await expect(packet).toBeVisible();
        await expect(packet.locator("animateMotion")).toHaveCount(0);
        await control.selectOption("on");
        expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
        await expectChevronsMoving(packet);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.reload();
        await legendOpen();
        await expect(control).toHaveValue("on");
        await expectChevronsMoving(packet);
        await control.selectOption("off");
        await expect(packet.locator("animateMotion")).toHaveCount(0);
        await page.reload();
        await legendOpen();
        await expect(control).toHaveValue("off");
        await expect(packet.locator("animateMotion")).toHaveCount(0);
        if (width === 1440 && diagram.kind === "freeform") {
          await control.selectOption("on");
          await page.getByRole("button", { name: "Archer contents", exact: true }).click();
          await expect(page.getByRole("region", { name: "Project files", exact: true })).toBeVisible();
          const other = await page.context().newPage();
          try {
            await other.goto(server.address("view=drawing"));
            await other.getByRole("combobox", { name: "Flow animation", exact: true }).selectOption("off");
          } finally {
            await other.close();
          }
          await openFile(page, { id: "drawing" });
          await expect(control).toHaveValue("off");
          await expect(packet.locator("animateMotion")).toHaveCount(0);
        }
        await control.selectOption("auto");
        await expect(packet.locator("animateMotion")).toHaveCount(0);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expectChevronsMoving(packet);
      } finally {
        await server.stop();
      }
    });
  }
