import { files as projectPage } from "./support/primary-navigation";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("primary shell retains real node and edge selection, right-click anchors and layered help", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@-->|Calls| api[API]\n",
    },
  });
  try {
    await project.present("system");
    await page.goto(project.url);
    const node = page.locator('.react-flow__node[data-id="web"]');
    await expect(node).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await node.click();
    await expect(node).toHaveClass(/selected/);
    await expect.poll(async () => (await project.selection())?.nodes.map((n) => n.id)).toEqual(["web"]);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard & Pointer" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard & Pointer" })).toBeHidden();
    await expect(node).toHaveClass(/selected/);
    const edge = page.locator('.react-flow__edge[data-id="e1"]');
    const point = await edge.locator(".react-flow__edge-interaction").evaluate((el) => {
      const path = el as SVGPathElement;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM()!;
      return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    });
    await page.mouse.click(point.x, point.y);
    await expect(edge).toHaveClass(/selected/);
    await expect.poll(async () => (await project.selection())?.edges.map((e) => e.id)).toEqual(["e1"]);
    await page.mouse.click(point.x, point.y, { button: "right" });
    const composer = page.getByRole("form", { name: "New comment" });
    await expect(composer).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Contextual discussion" }).locator(".primary-floating-context"),
    ).toHaveText("Edge: Calls");
    await expect(composer.getByRole("combobox", { name: "Comment on" })).toHaveCount(0);
    await composer.getByRole("textbox", { name: "Comment", exact: true }).fill("Does this call retry on timeout?");
    await composer.getByRole("button", { name: "Add comment", exact: true }).click();
    const response = await page.request.get(project.api("api/comments?target=view%3Asystem"));
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].anchor).toMatchObject({ kind: "edge", id: "e1" });
    expect(data.threads[0].comments[0].body).toBe("Does this call retry on timeout?");
    expect(errors).toEqual([]);
  } finally {
    await project.stop();
  }
});

test("a standalone note opened before any diagram follows actual watched edits", async ({ page }) => {
  const project = await sharedTsProject({
    files: { "archer.toml": "version = 1\n", ".archer/notes/standalone.md": "# Standalone\n\nBefore the edit.\n" },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Standalone", exact: true }).click();
    const note = page.getByRole("article", { name: "Reading Standalone" });
    await expect(note).toContainText("Before the edit.");
    writeFileSync(join(project.root, ".archer/notes/standalone.md"), "# Standalone\n\nAfter the watched edit.\n");
    await expect(note).toContainText("After the watched edit.");
  } finally {
    await project.stop();
  }
});
