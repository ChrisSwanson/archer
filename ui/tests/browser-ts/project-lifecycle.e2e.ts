import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const PAGE = testPage();

/** All projects' page, signed in by the agent link's token (`/projects/?token=…`). */
function projectsUrl(projectUrl: string): string {
  const url = new URL(projectUrl);
  const token = url.searchParams.get("token")!;
  url.pathname = "/projects/";
  url.search = `?token=${token}`;
  return url.href;
}

function slugOf(projectUrl: string): string {
  return /^\/projects\/([^/]+)\//.exec(new URL(projectUrl).pathname)![1]!;
}

async function revealProjects(page: Page): Promise<void> {
  if ((await page.locator(".primary-navigation").getAttribute("data-expanded")) !== "true") {
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (await menu.isVisible()) await menu.click();
    else await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
  }
  await expect(
    page.locator(".primary-navigation").getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
}

/**
 * Changes a project's visibility as the page does (`mutateProjectLifecycle`): the
 * controls left the project page for Project settings, a later slice.
 */
async function setLifecycle(page: Page, projectUrl: string, action: "archive" | "show" | "auto"): Promise<void> {
  const url = new URL(projectUrl);
  url.pathname = "/api/project-lifecycle";
  url.search = "";
  const status = await page.evaluate(
    async ({ href, slug, action }) =>
      (
        await fetch(href, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, action }),
        })
      ).status,
    { href: url.href, slug: slugOf(projectUrl), action },
  );
  expect(status).toBe(200);
}

test("a manually archived project stays usable and searchable, partitions both browsers, and is restored on a phone", async ({
  page,
}) => {
  const project = await startTsProject({
    pagePath: PAGE,
    files: {
      "archer.toml": "version = 1\n",
      ".archer/notes/guide.md": "# Recovery guide\n\nRestore the queue safely.\n",
    },
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(project.address(`overview=1`));
    // Archive project left the page for Project settings.
    await expect(page.getByRole("button", { name: "Recovery guide", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive project", exact: true })).toHaveCount(0);
    await setLifecycle(page, project.url, "archive");

    await page.reload();
    await expect(page.getByRole("button", { name: "Recovery guide", exact: true })).toBeVisible();
    await page.goto(project.address(`note=notes/guide.md`));
    const directNote = page.getByRole("article", { name: "Reading Recovery guide" });
    await expect(directNote).toContainText("Restore the queue safely.");
    await page.reload();
    await expect(directNote).toContainText("Restore the queue safely.");
    await revealProjects(page);
    const currentGroup = page
      .getByRole("navigation", { name: "Projects" })
      .getByRole("group", { name: "Inactive projects (1)" });
    await expect(currentGroup).toHaveAttribute("open", "");

    const global = projectsUrl(project.url);
    await page.goto(global);
    const mainGroup = page.locator("main").getByRole("group", { name: "Inactive projects (1)" });
    await expect(mainGroup).not.toHaveAttribute("open", "");
    await expect(mainGroup.getByRole("button", { name: "Recovery guide", exact: true })).toBeHidden();
    await page.screenshot({ path: "/tmp/archer-inactive-phone.png", fullPage: true });
    await revealProjects(page);
    const sidebarGroup = page
      .getByRole("navigation", { name: "Projects" })
      .getByRole("group", { name: "Inactive projects (1)" });
    await expect(sidebarGroup).not.toHaveAttribute("open", "");

    const filtered = new URL(global);
    filtered.searchParams.set("project", slugOf(project.url));
    filtered.searchParams.set("kind", "note");
    await page.goto(filtered.href);
    const matchingGroup = page.locator("main").getByRole("group", { name: "Inactive projects (1)" });
    await expect(matchingGroup).toHaveAttribute("open", "");
    await expect(matchingGroup.getByRole("button", { name: "Recovery guide", exact: true })).toBeVisible();
    await expect(matchingGroup).toContainText("1 matching file");
    expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);

    filtered.searchParams.set("q", "queue");
    await page.goto(filtered.href);
    const bodyMatchGroup = page.locator("main").getByRole("group", { name: "Inactive projects (1)" });
    await expect(bodyMatchGroup).toHaveAttribute("open", "");
    await expect(bodyMatchGroup.getByRole("button", { name: "Recovery guide", exact: true })).toBeVisible();
    await expect(bodyMatchGroup).toContainText("1 matching file");

    await page.goto(project.address(`overview=1`));
    await setLifecycle(page, project.url, "show");
    await page.goto(global);
    await expect(page.locator("main").getByRole("group", { name: /Inactive projects/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Recovery guide", exact: true })).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("an open sidebar crosses the ten-minute deadline and new content resurfaces the automatic project", async ({
  page,
}) => {
  let serviceNow = Date.parse("2026-10-15T12:00:00.000Z");
  const project = await startTsProject({
    pagePath: PAGE,
    now: () => serviceNow,
    files: { "archer.toml": "version = 1\n" },
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install({ time: new Date(serviceNow) });
    await page.goto(project.address(`overview=1`));
    await revealProjects(page);
    const navigation = page.getByRole("navigation", { name: "Projects" });
    await expect(navigation.getByRole("button", { name: /archer-ui-proj-/ })).toBeVisible();

    serviceNow += 10 * 60 * 1000 + 1;
    await page.clock.fastForward(15_001);
    const currentGroup = navigation.getByRole("group", { name: "Inactive projects (1)" });
    await expect(currentGroup).toHaveAttribute("open", "");

    const global = projectsUrl(project.url);
    await page.goto(global);
    await expect(page.locator("main").getByRole("group", { name: "Inactive projects (1)" })).not.toHaveAttribute(
      "open",
      "",
    );
    await page.screenshot({ path: "/tmp/archer-inactive-desktop.png", fullPage: true });

    mkdirSync(join(project.root, ".archer", "notes"), { recursive: true });
    writeFileSync(join(project.root, ".archer", "notes", "arrived.md"), "# Arrived\n\nNew project content.\n");
    await expect
      .poll(async () => {
        const response = await page.request.get(project.api(`api/browser-projects`));
        const catalog = (await response.json()) as { projects: { slug: string; lifecycle: { state: string } }[] };
        return catalog.projects.find((entry) => entry.slug === slugOf(project.url))?.lifecycle.state;
      })
      .toBe("active");
    await page.reload();
    await expect(page.locator("main").getByRole("group", { name: "Inactive projects (1)" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Arrived", exact: true })).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("a catalog without lifecycle metadata remains compatible and visible", async ({ page }) => {
  const project = await startTsProject({ pagePath: PAGE, files: { ".archer/notes/legacy.md": "# Legacy guide\n" } });
  try {
    await page.route("**/api/browser-projects", async (route) => {
      const response = await route.fetch();
      const catalog = (await response.json()) as { projects: Record<string, unknown>[] };
      await route.fulfill({
        response,
        json: { ...catalog, projects: catalog.projects.map(({ lifecycle: _lifecycle, ...entry }) => entry) },
      });
    });
    await page.goto(projectsUrl(project.url));
    await expect(page.locator("main").getByRole("group", { name: /Inactive projects/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Legacy guide", exact: true })).toBeVisible();
  } finally {
    await project.stop();
  }
});
