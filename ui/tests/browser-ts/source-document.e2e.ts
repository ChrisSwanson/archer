import { expect, test } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startTsProject } from "../support/ts-service";
import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { testPage } from "./support/page-path";

test("external Markdown and embedded diagrams share a confined read-only reader with topics", async ({ page }) => {
  const project = await startTsProject({
    pagePath: testPage(),
    files: {
      "archer.toml": 'version=1\n[discovery]\nroots=[".archer","docs"]\n',
      ".archer/old.md": "# Legacy",
      "docs/guide.md":
        "# External guide\n\n## Introduction\n\n" +
        "Introductory passage.\n\n".repeat(35) +
        "## Diagram\n\n```mermaid\nflowchart LR\n a[Reader] e@--> b[Service]\n```\n\n## Conclusion\n\nClosing remarks.",
    },
  });
  try {
    const { connectService } = await import(
      /* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, "../../../ts/src/service/index.ts")).href
    );
    const client = await connectService(join(dirname(project.configPath), "archer.sock"));
    let issued: string;
    try {
      issued = (await client.call("issueAccess", { label: "Source-reader check" })).url;
    } finally {
      client.close();
    }
    await page.goto(issued);
    await expect(page).toHaveURL(/\/projects\/$/);
    const slug = new URL(project.url).pathname.split("/")[2]!;
    await page.getByRole("searchbox", { name: "Search projects and files" }).fill("Closing remarks");
    await expect(page.getByRole("button", { name: "External guide", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Legacy", exact: true })).toHaveCount(0);
    // The expanded panel owns its whole surface; leave it before opening a result behind it.
    await page.mouse.move(700, 400);
    await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
    await page.getByRole("button", { name: "External guide", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${slug}/docs/guide.md$`));
    await expect(page.getByRole("heading", { name: "External guide", exact: true })).toBeVisible();
    await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Diagram", exact: true })).toBeVisible();
    const outline = page.getByRole("navigation", { name: "Table of contents" });
    await expect(outline.getByRole("link")).toHaveCount(4);
    await outline.getByRole("link", { name: "Conclusion", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Conclusion", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    writeFileSync(
      join(project.root, "docs/guide.md"),
      "# Updated guide\n\n## Live update\n\nThe external document changed.",
    );
    await expect(page.getByRole("heading", { name: "Updated guide", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await project.stop();
  }
});
