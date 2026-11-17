import { test, expect } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import AxeBuilder from "@axe-core/playwright";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

async function issuedLink(socket: string): Promise<string> {
  const module = pathToFileURL(resolve(import.meta.dirname, "../../../ts/src/service/index.ts")).href;
  const { connectService } = await import(/* @vite-ignore */ module);
  const client = await connectService(socket);
  try {
    return (await client.call("issueAccess", { label: "Browser regression" })).url;
  } finally {
    client.close();
  }
}
test("the same header filters global, project and nested folder browsing in place", async ({ page }) => {
  const project = await startTsProject({
    files: {
      "archer.toml": "version = 1\n",
      ".archer/notes/guide.md": "# Guide\n\nIntro.",
      ".archer/notes/deep/setup.md": "# Setup\n\nDetailed setup.",
      ".archer/other/unrelated.md": "# Unrelated\n\nOther.",
    },
    pagePath: testPage(),
  });
  try {
    const url = await issuedLink(join(dirname(project.configPath), "archer.sock"));
    await page.goto(url);
    const input = page.getByRole("searchbox", { name: "Search projects and files" });
    await expect(input).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/$/);
    await expect(page.getByRole("button", { name: "Guide", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const geometry = await input.boundingBox();
    const slug = new URL(project.url).pathname.split("/")[2]!;
    const projectName = await page
      .getByRole("region", { name: "Project documents", exact: true })
      .locator("[data-project-root] .archer-folder-tree-folder-link")
      .first()
      .innerText();
    await page
      .getByRole("region", { name: "Project documents", exact: true })
      .getByRole("link", { name: projectName, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/projects/${slug}/$`));
    await expect(input).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const scopedGeometry = await input.boundingBox();
    expect(scopedGeometry!.x).toBeCloseTo(geometry!.x, 1);
    expect(scopedGeometry!.width).toBeCloseTo(geometry!.width, 1);
    await page.screenshot({ path: "/tmp/archer-unified-browser-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(input).toBeVisible();
    await expect
      .poll(() => page.locator(".primary-navigation").evaluate((element) => getComputedStyle(element).visibility))
      .toBe("hidden");
    await page.screenshot({ path: "/tmp/archer-unified-browser-phone.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const metrics = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(".primary-drawer-button")!;
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        viewport: innerHeight,
        html: document.documentElement.scrollHeight,
        body: document.body.scrollHeight,
        panelHeight: document.querySelector(".archer-contents-panel")?.clientHeight,
        panelScroll: document.querySelector(".archer-contents-panel")?.scrollHeight,
        menu: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          receives: button === hit || button.contains(hit),
        },
      };
    });
    writeFileSync("/tmp/archer-unified-phone-geometry.json", JSON.stringify(metrics, null, 2));
    expect(metrics.menu.receives).toBe(true);
    expect(metrics.menu.width).toBeGreaterThanOrEqual(44);
    expect(metrics.menu.height).toBeGreaterThanOrEqual(44);
    expect(metrics.html).toBeLessThanOrEqual(metrics.viewport);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByRole("button", { name: /^(Expand|Collapse) notes$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.goto(new URL("notes/", page.url()).href);
    await expect(page).toHaveURL(/\/projects\/[^/]+\/notes\/$/);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await input.fill("Setup");
    await expect(page.getByRole("button", { name: "Guide", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeVisible();
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: /^(Expand|Collapse) deep$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.goto(new URL("deep/", page.url()).href);
    await expect(input).toHaveValue("");
    await expect(page).toHaveURL(/\/projects\/[^/]+\/notes\/deep\/$/);
    await input.fill("Setup");
    await page.getByRole("button", { name: "Search all projects" }).click();
    await expect(page).toHaveURL(/\/projects\/\?q=Setup$/);
    await expect(input).toHaveValue("Setup");
    await expect(page.getByRole("button", { name: "Clear folder filter" })).toHaveCount(0);
    await page.goto(project.url);
    await expect(input).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.locator(".primary-navigation").evaluate((element) => getComputedStyle(element).visibility))
      .toBe("hidden");
    const baseline = await page.evaluate(() => ({
      viewport: innerHeight,
      html: document.documentElement.scrollHeight,
      body: document.body.scrollHeight,
      panel: document.querySelector(".archer-contents-panel")?.scrollHeight,
      outliers: [...document.querySelectorAll<HTMLElement>(".archer-visually-hidden")]
        .filter((element) => element.getBoundingClientRect().top > innerHeight)
        .map((element) => ({
          top: element.getBoundingClientRect().top,
          parent: element.offsetParent?.className,
          text: element.textContent?.slice(0, 30),
        }))
        .slice(0, 5),
    }));
    writeFileSync("/tmp/archer-incumbent-phone-geometry.json", JSON.stringify(baseline, null, 2));
  } finally {
    await project.stop();
  }
});
test("Back restores the filtered folder, scroll and originating document focus", async ({ page }) => {
  const files: Record<string, string> = { "archer.toml": "version = 1\n" };
  for (let index = 1; index <= 30; index++) {
    const number = String(index).padStart(2, "0");
    files[`.archer/notes/setup-${number}.md`] = `# Setup ${number}\n\nInstructions ${number}.`;
  }
  const project = await startTsProject({ files, pagePath: testPage() });
  try {
    const url = new URL(await issuedLink(join(dirname(project.configPath), "archer.sock")));
    const slug = new URL(project.url).pathname.split("/")[2]!;
    url.pathname = `/projects/${slug}/notes/`;
    await page.goto(url.href);
    // Edited order depends on filesystem timestamps; the target must be well below the fold.
    await page.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ }).click();
    await page
      .getByRole("dialog", { name: "Project Filters" })
      .getByRole("combobox", { name: "Sort by", exact: true })
      .selectOption("name:asc");
    await page.keyboard.press("Escape");
    const input = page.getByRole("searchbox", { name: "Search projects and files" });
    await input.fill("Setup");
    await expect(page.getByRole("list", { name: "Matches in Setup 30", exact: true })).toBeAttached();
    const documentLink = page.getByRole("button", { name: "Setup 30", exact: true });
    const panel = page.locator(".archer-contents-panel");
    await documentLink.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await page.evaluate(() =>
      document.addEventListener(
        "pointerdown",
        () => {
          document.body.dataset.browserScrollBeforeOpen = String(
            document.querySelector(".archer-contents-panel")!.scrollTop,
          );
        },
        { once: true, capture: true },
      ),
    );
    await documentLink.click();
    const before = await page.evaluate(() => Number(document.body.dataset.browserScrollBeforeOpen));
    expect(before).toBeGreaterThan(100);
    await expect(page).toHaveURL(/\/projects\/[^/]+\/notes\/setup-30.md$/);
    await expect(page.locator(".primary-note-reader")).toContainText("Instructions 30.");
    await page.goBack();
    await expect(input).toHaveValue("Setup");
    await expect(documentLink).toBeFocused();
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  } finally {
    await project.stop();
  }
});
test("a retained legacy folder link uses the same scoped header, its subfolders open in the tree", async ({ page }) => {
  const project = await startTsProject({
    files: {
      "archer.toml": "version=1\n",
      ".archer/notes/guide.md": "# Guide\n\nIntro.",
      ".archer/notes/deep/setup.md": "# Setup\n\nSetup details.",
    },
    pagePath: testPage(),
  });
  try {
    await page.goto(project.address("folder=notes"));
    const input = page.getByRole("searchbox", { name: "Search projects and files" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear project filter" })).toHaveCount(0);
    await input.fill("Setup");
    await expect(page.getByRole("button", { name: "Guide", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Expand|Collapse) deep$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("Back starts a fresh typing history entry rather than replacing the restored page", async ({ page }) => {
  const project = await startTsProject({
    files: { "archer.toml": "version=1\n", ".archer/notes/guide.md": "# Guide", ".archer/notes/setup.md": "# Setup" },
    pagePath: testPage(),
  });
  try {
    const url = new URL(await issuedLink(join(dirname(project.configPath), "archer.sock")));
    const slug = new URL(project.url).pathname.split("/")[2]!;
    url.pathname = `/projects/${slug}/`;
    await page.goto(url.href);
    const input = page.getByRole("searchbox", { name: "Search projects and files" });
    await input.fill("Setup");
    await expect(page).toHaveURL(/q=Setup$/);
    await page.goBack();
    await expect(input).toHaveValue("");
    await input.fill("Guide");
    await expect(page).toHaveURL(/q=Guide$/);
    await page.goBack();
    await expect(input).toHaveValue("");
    await expect(page).toHaveURL(/\/projects\/[^/]+\/$/);
  } finally {
    await project.stop();
  }
});
test("opening a document in another attached project preserves filtered Back scroll and focus", async ({ page }) => {
  const project = await startTsProject({
    files: { "archer.toml": "version=1\n", ".archer/here.md": "# Here" },
    pagePath: testPage(),
  });
  const other = mkdtempSync(join(tmpdir(), "archer-cross-project-"));
  mkdirSync(join(other, ".archer", "notes"), { recursive: true });
  writeFileSync(join(other, "archer.toml"), "version=1\n");
  for (let index = 1; index <= 30; index++) {
    const number = String(index).padStart(2, "0");
    writeFileSync(
      join(other, ".archer", "notes", `setup-${number}.md`),
      `# Setup ${number}\n\nInstructions ${number}.`,
    );
  }
  try {
    const module = pathToFileURL(resolve(import.meta.dirname, "../../../ts/src/service/index.ts")).href;
    const { connectService } = await import(/* @vite-ignore */ module);
    const client = await connectService(join(dirname(project.configPath), "archer.sock"));
    try {
      await client.call("attach", { root: other });
    } finally {
      client.close();
    }
    await page.goto(project.address("q=Setup"));
    const input = page.getByRole("searchbox", { name: "Search projects and files" });
    await expect(page.locator(".archer-search-summary")).toHaveText("30 files");
    // Edited order depends on filesystem timestamps; sort by name so Setup 30 is below the fold.
    await page.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ }).click();
    await page
      .getByRole("dialog", { name: "Project Filters" })
      .getByRole("combobox", { name: "Sort by", exact: true })
      .selectOption("name:asc");
    await page.keyboard.press("Escape");
    const link = page.getByRole("button", { name: "Setup 30", exact: true });
    await expect(page.getByRole("list", { name: "Matches in Setup 30", exact: true })).toBeAttached();
    const panel = page.locator(".archer-contents-panel");
    await link.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await page.evaluate(() =>
      document.addEventListener(
        "pointerdown",
        () => {
          sessionStorage.setItem(
            "archer-test-scroll-before-open",
            String(document.querySelector(".archer-contents-panel")!.scrollTop),
          );
        },
        { once: true, capture: true },
      ),
    );
    await link.click();
    const before = await page.evaluate(() => Number(sessionStorage.getItem("archer-test-scroll-before-open")));
    expect(before).toBeGreaterThan(100);
    await expect(page.locator(".primary-note-reader")).toContainText("Instructions 30.");
    await page.goBack();
    await page.reload();
    await expect(input).toHaveValue("Setup");
    await expect(link).toBeFocused();
    await expect
      .poll(() => page.locator(".archer-contents-panel").evaluate((element) => element.scrollTop))
      .toBeCloseTo(before, 0);
  } finally {
    await project.stop();
    rmSync(other, { recursive: true, force: true });
  }
});

test("the agent link keeps configured coverage, body search and nested reader transport", async ({ page }) => {
  const project = await startTsProject({
    files: {
      "archer.toml": 'version=1\n[discovery]\nroots=["docs"]\n',
      ".archer/hidden.md": "# Excluded legacy note",
      "docs/deep/guide.md": "# External guide\n\nBody-only discovery phrase.",
    },
    pagePath: testPage(),
  });
  try {
    await page.goto(project.url);
    const input = page.getByRole("searchbox", { name: "Search projects and files" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("button", { name: "Excluded legacy note", exact: true })).toHaveCount(0);
    await input.fill("Body-only discovery phrase");
    const guide = page.getByRole("button", { name: "External guide", exact: true });
    await expect(guide).toBeVisible();
    await guide.click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/docs\/deep\/guide.md$/);
    await expect(page.getByRole("heading", { name: "External guide", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "External guide", exact: true })).toBeVisible();
    writeFileSync(join(project.root, "docs/deep/guide.md"), "# Refreshed external guide\n\nLive content.");
    await expect(page.getByRole("heading", { name: "Refreshed external guide", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button").nth(1).click();
    await expect(input).toBeVisible();
    expect(new URL(page.url()).pathname.startsWith(`/projects/`)).toBe(true);
    await page.getByRole("button", { name: "Refreshed external guide", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/docs\/deep\/guide.md$/);
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "Projects", exact: true })
      .click();
    await expect(page).toHaveURL(/\/projects\/$/);
    await expect(input).toBeVisible();
    await expect(page.getByRole("button", { name: "Refreshed external guide", exact: true })).toBeVisible();
  } finally {
    await project.stop();
  }
});
