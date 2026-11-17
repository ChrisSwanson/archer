import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

const cases = [
  {
    id: "graph",
    kind: "freeform",
    source: "flowchart LR\n customer[Customer]:::external checkout@--> shop[Shop]\n",
    expectedText: ["Customer", "Shop", "Diagram Key", "External"],
  },
  {
    id: "trace",
    kind: "sequence",
    source: "sequenceDiagram\n actor customer as Customer\n participant shop as Shop\n customer->>shop: Buy\n",
    expectedText: ["Customer", "Shop", "Buy", "Diagram Key", "Actor"],
  },
] as const;

for (const fixture of cases) {
  test(`the real service exports ${fixture.id} SVG with the React runtime`, async ({ page }) => {
    const project = await sharedTsProject({
      files: {
        "archer.toml": `version = 1\n[[views]]\nid = "${fixture.id}"\nkind = "${fixture.kind}"\ntitle = "Runtime export"\nsource = ".archer/${fixture.id}.mmd"\n`,
        [`.archer/${fixture.id}.mmd`]: fixture.source,
      },
    });
    try {
      await page.goto(project.url);
      const result = await page.evaluate(async (viewId) => {
        const response = await fetch(
          location.pathname.replace(/^\/projects\/([^/]+)\/.*$/, "/p/$1/") + "api/operations",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "export_diagram",
              arguments: {
                viewId,
                format: "svg",
                mode: "presentation",
                theme: "light",
                diagramKey: true,
              },
            }),
          },
        );
        return { status: response.status, body: await response.json() };
      }, fixture.id);

      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ mimeType: "image/svg+xml", encoding: "base64" });
      expect(result.body.width).toBeGreaterThan(0);
      expect(result.body.height).toBeGreaterThan(0);
      const svg = Buffer.from(String(result.body.data), "base64").toString("utf8");
      expect(svg).toContain("<svg");
      for (const text of fixture.expectedText) expect(svg).toContain(text);
    } finally {
      await project.stop();
    }
  });
}
