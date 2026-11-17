import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { projectPath } from "./support/address";
import { sharedTsProject } from "./support/shared-service";

for (const width of [1280, 390]) {
  test(`overview and read-only source expose working workspace actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const project = await sharedTsProject({
      files: {
        "archer.toml":
          'version=1\n[discovery]\nroots=[".archer","docs"]\n[[views]]\nid="flow"\nkind="freeform"\ntitle="Flow"\nsource=".archer/flow.mmd"\n',
        ".archer/flow.mmd": "flowchart LR\n a[Request] e@--> b[Response]\n",
        "docs/reference.md": "# Reference\n\nRead-only source.\n",
      },
    });
    try {
      const annotationWrites: string[] = [];
      let readingSource = false;
      page.on("request", (request) => {
        if (
          readingSource &&
          !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
          /\/api\/(?:comments|notes|note-emphasis|documents)/.test(new URL(request.url()).pathname)
        )
          annotationWrites.push(request.method());
      });
      await project.agentCreateComment("view:flow", { kind: "view" }, "A workspace answer.");
      const access = await project.issueAccess("Workspace actions regression");
      await page.goto(access.url);
      await expect(page.getByRole("searchbox")).toBeVisible();
      const origin = new URL(page.url()).origin;
      const slug = new URL(project.url).pathname.split("/")[2]!;
      for (const route of ["/projects/", `/projects/${slug}/-/repo/docs/reference.md`]) {
        readingSource = route.includes("/documents/");
        await page.goto(origin + route);
        const bell = page.getByRole("button", { name: /^Notifications/ });
        await expect(bell).toBeVisible();
        await bell.click();
        await expect(page.getByText("A workspace answer.", { exact: true })).toBeVisible();
        const panel = page.getByRole("dialog", { name: /Notifications/ });
        await expect(panel).toBeVisible();
        const bounds = await panel.boundingBox();
        const headerBounds = await page.locator(".primary-document-bar").boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `/tmp/archer-shell-actions-${route.includes("documents") ? "source" : "global"}-${width}.png`,
        });
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        if (width === 1280 && route === "/projects/") {
          await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
          const help = page.getByRole("dialog", { name: "Keyboard & Pointer", exact: true });
          await expect(help).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(help).toBeHidden();
          await expect(panel).toBeHidden(); // a press outside closes the popover
          await page.getByRole("button", { name: "Archer settings", exact: true }).click();
          const settings = page.getByRole("dialog", { name: "Archer Settings", exact: true });
          await expect(settings.getByRole("listitem", { name: "Comment submission", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(settings).toBeHidden();
          await bell.click();
          await expect(panel).toBeVisible();
          await panel.focus();
        }
        if (route.includes("/documents/")) await panel.getByRole("button", { name: "Mark read", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused();
        if (width === 390) await page.getByRole("button", { name: "Menu", exact: true }).click();
        await page.getByRole("button", { name: "Archer settings", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Archer Settings", exact: true });
        await expect(settings.getByRole("listitem", { name: "Comment submission", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(settings).toBeHidden();
        if (route.includes("/documents/")) {
          await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: /Add comment|Save highlight/ })).toHaveCount(0);
        }
      }
      expect(annotationWrites).toEqual([]);
      readingSource = false;
      await page.goto(origin + "/projects/");
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await page.getByRole("link").filter({ hasText: "A workspace answer." }).click();
      await expect(page).toHaveURL(/\/projects\/[^/]+\/flow\.mmd\?thread=/);
      await expect(page.locator('[id^="archer-thread-"]').filter({ hasText: "A workspace answer." })).toBeVisible();
    } finally {
      await project.stop();
    }
  });
}

test("a notification thread address opens the requested discussion after hydration", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml": 'version=1\n[[views]]\nid="flow"\nkind="freeform"\ntitle="Flow"\nsource=".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Request] e@--> b[Response]\n",
    },
  });
  try {
    const thread = await project.agentCreateComment("view:flow", { kind: "view" }, "The requested thread.");
    const second = await project.agentCreateComment("view:flow", { kind: "view" }, "The second requested thread.");
    const access = await project.issueAccess("Thread address regression");
    await page.goto(access.url);
    await expect(page.getByRole("searchbox")).toBeVisible();
    const slug = new URL(project.url).pathname.split("/")[2]!;
    await page.goto(
      new URL(`/projects/${slug}/?follow&view=flow&thread=${encodeURIComponent(thread.id)}`, page.url()).href,
    );
    const discussion = page.locator(`#archer-thread-${thread.id}`);
    await expect(discussion).toBeVisible();
    await expect(discussion).toContainText("The requested thread.");
    await expect(discussion).toBeFocused();
    await page.reload();
    await expect(discussion).toBeVisible();
    await page.evaluate((id) => {
      const next = new URL(location.href);
      next.searchParams.set("thread", id);
      history.pushState(null, "", next);
      dispatchEvent(new PopStateEvent("popstate"));
    }, second.id);
    await expect(page.locator(`#archer-thread-${second.id}`)).toBeFocused();
    await page.goBack();
    await expect(discussion).toBeFocused();
  } finally {
    await project.stop();
  }
});

test("an empty catalog keeps service actions without bootstrapping a fabricated project", async ({ page }) => {
  const project = await sharedTsProject({ files: { "archer.toml": "version=1\n" } });
  try {
    let bootstraps = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/api/bootstrap")) bootstraps += 1;
    });
    await page.route("**/api/browser-projects", (route) => route.fulfill({ json: { schemaVersion: 1, projects: [] } }));
    const access = await project.issueAccess("Empty catalog regression");
    await page.goto(access.url);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toContainText("No notifications.");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Archer settings", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Archer Settings" })
        .getByRole("listitem", { name: "Comment submission", exact: true }),
    ).toBeVisible();
    expect(bootstraps).toBe(0);
  } finally {
    await project.stop();
  }
});

test("notification links open an encoded note's own discussion", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml": "version=1\n",
      ".archer/notes/topic details.md": "# Topic details\n\nImportant passage.\n",
    },
  });
  try {
    const thread = await project.agentCreateComment(
      "note:notes/topic details.md",
      { kind: "passage", quote: "Important passage", prefix: "", suffix: "." },
      "Review this topic.",
    );
    const access = await project.issueAccess("Note thread regression");
    await page.goto(access.url);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("link").filter({ hasText: "Review this topic." }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/notes\/topic%20details.md\?thread=/);
    const discussion = page.locator(`.primary-note-discussion[data-thread-id="${thread.id}"]`);
    await expect(discussion).toHaveAttribute("data-expanded", "true");
    await expect(discussion).toContainText("Review this topic.");
  } finally {
    await project.stop();
  }
});

test("all projects' page and a source document page have workspace actions that open the actual thread", async ({
  page,
}) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version=1\n[discovery]\nroots=[".archer","docs"]\n[[views]]\nid="flow"\nkind="freeform"\ntitle="Flow"\nsource=".archer/flow.mmd"\n',
      ".archer/flow.mmd": "flowchart LR\n a[Request] e@--> b[Response]\n",
      "docs/reference.md": "# Reference\n\nRead-only source.\n",
    },
  });
  try {
    const thread = await project.agentCreateComment("view:flow", { kind: "view" }, "A legacy workspace answer.");
    const address = new URL(project.url);
    // The owner's browser signs in once with the agent's link.
    await page.goto(project.url);
    for (const path of ["/projects/", `${address.pathname}-/repo/docs/reference.md`]) {
      await page.goto(address.origin + path);
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await page.getByRole("link").filter({ hasText: "A legacy workspace answer." }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectPath(project.url)}flow.mmd`);
      expect(new URL(page.url()).searchParams.get("thread")).toBe(thread.id);
      await expect(page.locator(`#archer-thread-${thread.id}`)).toBeVisible();
    }
    const old = new URL(project.url);
    old.searchParams.set("view", "flow");
    old.searchParams.set("thread", thread.id);
    await page.goto(old.href);
    await expect(page.locator(`#archer-thread-${thread.id}`)).toBeVisible();
  } finally {
    await project.stop();
  }
});
