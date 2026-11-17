// ADR 0030: a line pattern's meaning is its author's, shown in the Diagram key
// and, while an emphasis legend is up, in the legend's Key instead -- never in
// both at once -- and the line is drawn in its pattern.
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = [
  "flowchart LR",
  "  %% archer-key dashed: Person to system",
  "  %% archer-key dotted: Asynchronous",
  "  shopper[Shopper] e1@--> web[Web app]",
  "  web e2@--> api[Orders API]",
  "  api e3@-.-> queue[Refund queue]",
  "  classDef dashed stroke-dasharray: 6 4",
  "  class e1 dashed",
  "",
].join("\n");

for (const scheme of ["light", "dark"] as const) {
  test(`authored line meanings show in one key at a time: ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
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
      const key = page.getByRole("region", { name: "Diagram Key", exact: true });
      await expect(key).toContainText("Dashed line: Person to system");
      await expect(key).toContainText("Dotted line: Asynchronous");
      const dash = (id: string) =>
        page
          .locator(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`)
          .evaluate((element) => getComputedStyle(element).strokeDasharray);
      expect(await dash("e1")).toMatch(/^6(px)?,? 4(px)?$/);
      expect(await dash("e2")).toBe("none");

      await server.setEmphasis("drawing", [
        { id: "e", groups: [{ id: "g", label: "Ordering", style: "highlight", nodes: ["web", "api"], edges: ["e2"] }] },
      ]);
      const legend = page.getByRole("region", { name: "Highlights", exact: true });
      await expect(legend.getByRole("group", { name: "Key" })).toContainText("Dashed line: Person to system");
      // The Diagram key leaves the line to the legend; with nothing else to say here, there is no key at all (G4).
      await expect(
        page
          .getByRole("region", { name: "Diagram Key", exact: true })
          .filter({ hasText: "Dashed line: Person to system" }),
      ).toHaveCount(0);
      // The emphasis never changes a pattern.
      expect(await dash("e1")).toMatch(/^6(px)?,? 4(px)?$/);
    } finally {
      await server.stop();
    }
  });
}
