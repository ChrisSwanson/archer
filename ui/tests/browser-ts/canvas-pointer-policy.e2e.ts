import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("registered flowchart subgraph stays decorative across pointer mode changes", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "grouped"\nkind = "freeform"\ntitle = "Grouped graph"\nsource = ".archer/grouped.mmd"\n',
      // Same supported explicit-ID subgraph form as the production browser graph fixtures.
      ".archer/grouped.mmd": "flowchart LR\nsubgraph app[Application]\n  a[Client]\n  b[Server]\nend\na e1@--> b\n",
    },
  });
  try {
    await page.goto(project.url);
    await project.present("grouped");
    const client = page.locator('.react-flow__node[data-id="a"]');
    const server = page.locator('.react-flow__node[data-id="b"]');
    const frame = page.locator('.react-flow__node[data-id="group:app"]');
    await expect(client).toBeVisible();
    await expect(frame).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await client.click();
    await expect
      .poll(() => project.selection())
      .toMatchObject({ viewId: "grouped", nodes: [{ id: "a", label: "Client" }], edges: [] });
    const held = await project.selection();
    await expect(client).toHaveClass(/\bselectable\b/);
    await expect(frame).not.toHaveClass(/\bselectable\b/);
    await page.getByRole("button", { name: "Hand mode", exact: true }).click();
    await expect(client).not.toHaveClass(/\bselectable\b/);
    await expect(frame).not.toHaveClass(/\bselectable\b/);
    await server.click();
    await expect.poll(() => project.selection()).toEqual(held);
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await expect(client).toHaveClass(/\bselectable\b/);
    await expect(frame).not.toHaveClass(/\bselectable\b/);
    await expect.poll(() => project.selection()).toEqual(held);
    await server.click();
    await expect
      .poll(() => project.selection())
      .toMatchObject({ viewId: "grouped", nodes: [{ id: "b", label: "Server" }], edges: [] });
  } finally {
    await project.stop();
  }
});
