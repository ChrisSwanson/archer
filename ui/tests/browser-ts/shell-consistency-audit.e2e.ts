import { expect, test, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

async function fixture(page: Page) {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version=1\n[discovery]\nroots=[".archer","docs"]\n[[views]]\nid="flow"\nkind="freeform"\ntitle="Flow"\nsource=".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Request] e@--> b[Response]\n",
      "docs/reference.md": "# Reference\n\nRead-only source.\n",
    },
  });
  try {
    const access = await project.issueAccess("Shell consistency regression");
    await page.goto(access.url);
    await expect(page.getByRole("searchbox")).toBeVisible();
    const origin = new URL(page.url()).origin;
    const slug = new URL(project.url).pathname.split("/")[2]!;
    return { project, origin, slug };
  } catch (error) {
    await project.stop();
    throw error;
  }
}

for (const width of [1280, 390])
  for (const scope of ["global", "project", "source"] as const) {
    test(`shell help closes with Escape in ${scope} scope at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { project, origin, slug } = await fixture(page);
      try {
        if (scope === "project") {
          await page.goto(`${origin}/projects/${slug}/`);
          await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
        } else if (scope === "source") {
          await page.goto(`${origin}/projects/${slug}/-/repo/docs/reference.md`);
          await expect(page.getByRole("article", { name: "Reading reference.md" })).toBeVisible();
        }
        await expect(page.locator(".primary-document-bar")).toHaveCount(1);
        await expect(page.getByRole("main")).toHaveCount(1);
        const bar = await page.locator(".primary-document-bar").boundingBox();
        expect(bar!.x).toBeGreaterThanOrEqual(0);
        expect(bar!.x + bar!.width).toBeLessThanOrEqual(width);
        if (width === 390) await page.getByRole("button", { name: "Menu", exact: true }).click();
        const opener = page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
        await opener.click();
        const help = page.getByRole("dialog", { name: "Keyboard & Pointer", exact: true });
        await expect(help).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(help).toBeHidden();
        await expect(width === 390 ? page.getByRole("button", { name: "Menu", exact: true }) : opener).toBeFocused();
        if (width === 390) await expect(page.locator(".primary-navigation")).toBeHidden();
        if (scope === "global") await page.screenshot({ path: `/tmp/archer-shell-global-${width}.png` });
      } finally {
        await project.stop();
      }
    });
  }

test("reading an agent answer persists across canonical routes in one project", async ({ page }) => {
  const { project, origin, slug } = await fixture(page);
  try {
    await project.agentCreateComment("view:flow", { kind: "view" }, "An agent answer for the shell regression.");
    await page.goto(`${origin}/projects/${slug}/`);
    const bell = page.getByRole("button", { name: /^Notifications/ });
    await expect(bell).toHaveAttribute("aria-label", "Notifications, 1 unread agent answer");
    const sibling = await page.context().newPage();
    await sibling.goto(`${origin}/projects/${slug}/?follow&view=flow`);
    await expect(sibling.getByRole("button", { name: /^Notifications/ })).toHaveAttribute(
      "aria-label",
      "Notifications, 1 unread agent answer",
    );
    await bell.click();
    await page.getByRole("button", { name: /^Mark read/ }).click();
    await expect(bell).toHaveAttribute("aria-label", "Notifications");
    await expect(sibling.getByRole("button", { name: /^Notifications/ })).toHaveAttribute(
      "aria-label",
      "Notifications",
    );
    await sibling.close();
    await page.reload();
    await bell.click();
    await expect(
      page.locator(".primary-inbox-item").filter({ hasText: "An agent answer for the shell regression." }),
    ).toBeVisible();
    await expect(bell).toHaveAttribute("aria-label", "Notifications");
    await page.goto(`${origin}/projects/${slug}/?follow&view=flow`);
    // The initial zero before thread hydration is not evidence of remembered read state.
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(
      page.locator(".primary-inbox-item").filter({ hasText: "An agent answer for the shell regression." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Notifications/ })).toHaveAttribute("aria-label", "Notifications");
    await page.goto(project.url);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(
      page.locator(".primary-inbox-item").filter({ hasText: "An agent answer for the shell regression." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Notifications/ })).toHaveAttribute("aria-label", "Notifications");
  } finally {
    await project.stop();
  }
});

test("widening a project search to all projects selects the global shell before and after reload", async ({ page }) => {
  const { project, origin, slug } = await fixture(page);
  try {
    await page.goto(`${origin}/projects/${slug}/`);
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search projects and files" }).fill("guide");
    await page.getByRole("button", { name: "Search all projects", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/projects/\\?`));
    await expect(page.getByRole("heading", { level: 1, name: "Projects", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Projects", exact: true })).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("shared keys preserve typed search and active filter dialog ownership", async ({ page }) => {
  const { project } = await fixture(page);
  try {
    const search = page.getByRole("searchbox");
    await search.click();
    await search.pressSequentially("?");
    await expect(search).toHaveValue("?");
    await expect(page.getByRole("dialog", { name: "Keyboard & Pointer", exact: true })).toBeHidden();
    await search.clear();
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const filters = page.getByRole("dialog", { name: "Project Filters", exact: true });
    await expect(filters).toBeVisible();
    await page.keyboard.press("?");
    await expect(filters).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Keyboard & Pointer", exact: true })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(filters).toBeHidden();
  } finally {
    await project.stop();
  }
});
