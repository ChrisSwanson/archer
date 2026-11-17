import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ConsoleMessage, expect, type Page, test } from "@playwright/test";
import { type PlaygroundIndex, unpackProject } from "../../../shared/playground-delivery.mts";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// The Playground as its published catalog says it is: every project's notes read, every saved walkthrough stepped
// with its own explanation, and a reader's comment that outlives a reload until Reset. Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
const app = `${base}playground/app/index.html`;
let server: StaticServer;
let origin: string;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
  origin = server.origin;
});
test.afterAll(() => server.close());

type Walk = { id: string; title: string; steps: { what?: string; title: string }[] };
/** What the built Playground publishes: each project's notes and each diagram's saved walkthroughs. */
function catalog() {
  const folder = resolve(root, "playground/app");
  const html = readFileSync(resolve(folder, "index.html"), "utf8");
  const json = /<script id="archer-playground-index" type="application\/json">([\s\S]*?)<\/script>/u.exec(html)?.[1];
  const index = JSON.parse(json ?? "null") as PlaygroundIndex;
  const shared = JSON.parse(readFileSync(resolve(folder, index.shared), "utf8"));
  return index.projects.map((entry) => {
    const project = unpackProject(entry, JSON.parse(readFileSync(resolve(folder, entry.data), "utf8")), shared);
    const notes = (project.responses["api/notes/all"] as { notes: { path: string; title: string }[] }).notes;
    const views = (project.responses["api/diagrams"] as { views: { id: string; sourcePath?: string }[] }).views;
    const walks = views.flatMap((view) => {
      const saved = project.responses[`api/walkthroughs?viewId=${encodeURIComponent(view.id)}`] as
        | { walkthroughs?: Walk[] }
        | undefined;
      return (saved?.walkthroughs ?? [])
        .filter((walk) => walk.steps.length > 1)
        .map((walk) => ({ walk, path: view.sourcePath! }));
    });
    return { slug: entry.slug, name: entry.name, notes, walks };
  });
}
const address = (logical: string) => `${origin}${app}?route=${encodeURIComponent(logical)}`;

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") problems.push(`console ${message.text()}`);
  });
  return problems;
}

test("every project's notes read and every saved walkthrough steps with its own explanation", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  const projects = catalog();
  expect(projects.map((project) => project.slug).sort()).toEqual(["archer-tour", "rfc-1149-ipoac", "rfc-2324-htcpcp"]);
  let walked = 0;
  for (const project of projects) {
    expect(project.notes.length, project.name).toBeGreaterThan(0);
    for (const note of project.notes) {
      await page.goto(address(`/projects/${project.slug}/${note.path}`));
      const article = page.getByRole("article", { name: `Reading ${note.title}` });
      await expect(article, `${project.slug}/${note.path}`).toBeVisible();
      expect((await article.textContent())?.length, `${project.slug}/${note.path} has its text`).toBeGreaterThan(200);
    }
    for (const { walk, path } of project.walks) {
      const what = `${project.slug}/${path}: ${walk.title}`;
      await page.goto(address(`/projects/${project.slug}/${path}`));
      await page
        .getByRole("button", { name: new RegExp(`^${walk.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u") })
        .click();
      const panel = page.getByRole("region", { name: "Walkthrough" });
      const step = panel.getByRole("slider", { name: "Step" });
      const explanation = panel
        .getByRole("listitem")
        .filter({ has: page.getByRole("button", { expanded: true }) })
        .getByRole("definition")
        .first();
      await expect(step, what).toHaveValue("1");
      if (walk.steps[0]!.what) await expect(explanation, what).toHaveText(walk.steps[0]!.what);
      await panel.getByRole("button", { name: "Next step", exact: true }).click();
      await expect(step, what).toHaveValue("2");
      if (walk.steps[1]!.what) await expect(explanation, what).toHaveText(walk.steps[1]!.what);
      walked++;
    }
  }
  expect(walked).toBeGreaterThan(2);
  expect(problems).toEqual([]);
});

test("a saved comment outlives a reload; Reset removes it and keeps the docs' own preferences", async ({ page }) => {
  const problems = watch(page);
  const body = `A local review ${Date.now()}`;
  await page.goto(address("/projects/archer-tour/diagrams/containers.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // The docs site's own preference, in the same origin's storage.
  await page.evaluate(() => localStorage.setItem("vitepress-theme-appearance", "dark"));
  await page.keyboard.press("c");
  await page.getByRole("textbox", { name: "Comment" }).fill(body);
  await page.getByRole("button", { name: "Save comment" }).click();
  // The saved comment, not the editor still holding its text (getByText also matches a textarea's value).
  const saved = page.locator(".archer-comment-body", { hasText: new RegExp(`^${body}$`, "u") });
  await expect(saved).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // Kept in this browser: the review inbox lists it after the reload.
  const listed = page.locator(".primary-inbox-text", { hasText: body });
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(listed).toBeVisible();
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await page.waitForLoadState("load");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.reload();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "Notifications" }).click();
  // Loaded (its tabs carry their counts), and without the comment: the Tour ships with none of the reader's.
  await expect(page.locator(".primary-inbox-tabs").getByRole("tab").first()).toHaveAttribute("aria-label", /, /u);
  await expect(listed).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("vitepress-theme-appearance"))).toBe("dark");
  expect(problems).toEqual([]);
});
