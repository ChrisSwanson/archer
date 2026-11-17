import { resolve } from "node:path";
import { type ConsoleMessage, expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// The built Playground clicked through as a person would: moving between example projects inside the page (each
// project's data downloads on demand), Back and Forward. Run after docs:build.
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

const UNKNOWN = "Cannot tell what Archer is showing.";
const PROJECTS = [
  { name: "HTCPCP: I'm a Teapot", slug: "rfc-2324-htcpcp", diagram: "Coffee Controls" },
  { name: "IP over Avian Carriers", slug: "rfc-1149-ipoac", diagram: "Carrier Choices and Cautions" },
  { name: "Archer Tour", slug: "archer-tour", diagram: "Where Archer Runs" },
];

/** The project's own overview: its name in the breadcrumb, a readable page, no unavailable-project refusal. */
async function onOverview(page: Page, project: (typeof PROJECTS)[number]) {
  await expect(page).toHaveURL(new RegExp(`route=%2Fprojects%2F${project.slug}%2F$`, "u"));
  await expect(page.getByText(UNKNOWN)).toHaveCount(0);
  await expect(page.locator("main").getByRole("button", { name: project.diagram, exact: true }).first()).toBeVisible();
}

async function drawn(page: Page, what: string) {
  await expect(page.getByText(UNKNOWN), what).toHaveCount(0);
  await expect(page.locator(".react-flow__node").first(), what).toBeVisible();
}

test("every example project opens from the Projects overview and the sidebar, with Back and Forward", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const problems = watch(page);
  await page.goto(origin + app);
  await drawn(page, "the first drawing");
  for (const project of PROJECTS) {
    // Through the breadcrumb's Projects overview.
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page).toHaveURL(/route=%2Fprojects%2F$/u);
    await page.locator("main").getByRole("link", { name: project.name, exact: true }).click();
    await onOverview(page, project);
    await page.locator("main").getByRole("button", { name: project.diagram, exact: true }).first().click();
    await drawn(page, `${project.name}: ${project.diagram}`);
    await page.goBack();
    await onOverview(page, project);
    await page.goBack();
    await expect(page).toHaveURL(/route=%2Fprojects%2F$/u);
    await page.goForward();
    await onOverview(page, project);
    await page.goForward();
    await drawn(page, `${project.name}: ${project.diagram} after Forward`);
  }
  // Through the sidebar's contents, from a deep link into another project.
  await page.goto(`${origin}${app}?route=${encodeURIComponent("/projects/rfc-1149-ipoac/")}`);
  await onOverview(page, PROJECTS[1]!);
  const sidebar = page.getByRole("navigation", { name: "Workspace" });
  const teapot = sidebar.getByRole("button", { name: PROJECTS[0]!.name, exact: true });
  // The collapsed rail opens its project list on hover, as a pointer reaching for it does.
  await page.mouse.move(700, 500);
  await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
  await teapot.click();
  await onOverview(page, PROJECTS[0]!);
  expect(problems).toEqual([]);
});

for (const failed of ["data", "chunk"] as const)
  test(`a failed ${failed} download says so and Retry recovers`, async ({ page }) => {
    const pattern = failed === "data" ? /\/playground\/app\/data\/[^/]+\.json$/u : /\/assets\/mount-shell-[^/]+\.js$/u;
    await page.route(pattern, (route) => route.abort("internetdisconnected"));
    await page.goto(origin + app);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("This example could not load.");
    await expect(alert).toContainText("Check your connection");
    await page.unroute(pattern);
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await drawn(page, "after Retry");
    await expect(page.getByRole("alert").filter({ hasText: "could not load" })).toHaveCount(0);
  });

test("the Playground's Play advances the step and its explanation, stops at the end and plays again", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = watch(page);
  await page.goto(origin + app);
  await drawn(page, "the first drawing");
  await page.getByRole("button", { name: /^A Diagram Reaches the Person/u }).click();
  const walk = page.getByRole("region", { name: "Walkthrough" });
  const step = walk.getByRole("slider", { name: "Step" });
  // The expanded step's "Does" line: what the step explains.
  const explanation = walk
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { expanded: true }) })
    .getByRole("definition")
    .first();
  await expect(step).toHaveValue("1");
  const first = await explanation.textContent();
  await walk.getByRole("button", { name: "Play", exact: true }).click();
  await expect(step).toHaveValue("2", { timeout: 10_000 });
  await expect(explanation).not.toHaveText(first ?? "");
  const last = await step.evaluate((input) => (input as HTMLInputElement).max);
  await expect(step).toHaveValue(last, { timeout: 30_000 });
  await expect(walk.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 5_000 });
  const ending = await explanation.textContent();
  await page.waitForTimeout(2_000); // longer than one Play interval: nothing advances past the end
  await expect(step).toHaveValue(last);
  await walk.getByRole("button", { name: "Play", exact: true }).click();
  await expect(step).toHaveValue(/^[12]$/u, { timeout: 5_000 });
  await expect(explanation).not.toHaveText(ending ?? "");
  await expect(step).toHaveValue("2", { timeout: 10_000 });
  await walk.getByRole("button", { name: "Pause", exact: true }).click();
  expect(problems).toEqual([]);
});

/** A page-provided WebMCP context, as a browser with agent tools offers it; the tools land on window.tools. */
async function offerAgentTools(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, { execute(input: object, options: { signal: AbortSignal }): Promise<unknown> }>();
    (window as unknown as { tools: typeof tools }).tools = tools;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: async (
          tool: { name: string; execute(input: object, options: { signal: AbortSignal }): Promise<unknown> },
          options: { signal: AbortSignal },
        ) => {
          tools.set(tool.name, tool);
          options.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
        },
      },
    });
  });
}
const listDiagrams = (page: Page) =>
  page.evaluate(async () => {
    const tools = (window as unknown as { tools: Map<string, { execute(i: object, o: object): Promise<unknown> }> })
      .tools;
    return JSON.stringify(await tools.get("list_diagrams")?.execute({}, { signal: new AbortController().signal }));
  });

test("slow project downloads: two navigations and Back while they load end on the last one, with its tools", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = watch(page);
  await offerAgentTools(page);
  const requested: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/playground\/app\/data\/rfc-[^/]+\.json$/u, async (route) => {
    requested.push(
      new URL(route.request().url()).pathname
        .split("/")
        .pop()!
        .replace(/-[0-9a-f]+\.json$/u, ""),
    );
    await gate;
    await route.continue();
  });
  await page.goto(origin + app);
  await drawn(page, "the Tour");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator("main").getByRole("link", { name: PROJECTS[0]!.name, exact: true }).click();
  await expect(page).toHaveURL(/rfc-2324-htcpcp/u);
  await page.goBack();
  await expect(page).toHaveURL(/route=%2Fprojects%2F$/u);
  await page.locator("main").getByRole("link", { name: PROJECTS[1]!.name, exact: true }).click();
  await expect(page).toHaveURL(/rfc-1149-ipoac/u);
  release();
  await onOverview(page, PROJECTS[1]!);
  await page.locator("main").getByRole("button", { name: PROJECTS[1]!.diagram, exact: true }).first().click();
  await drawn(page, "the last project's diagram");
  await expect(page.getByText("Agent tools available (WebMCP)")).toBeVisible();
  expect(await listDiagrams(page)).toContain("carrier-cautions");
  // Each project downloaded once, however often the page asked for it while it loaded.
  expect(requested.sort()).toEqual(["rfc-1149-ipoac", "rfc-2324-htcpcp"]);
  expect(problems).toEqual([]);
});

test("a project whose download fails in the page says so once, and Retry brings it and its tools", async ({ page }) => {
  test.setTimeout(90_000);
  await offerAgentTools(page);
  const data = /\/playground\/app\/data\/rfc-2324-htcpcp-[^/]+\.json$/u;
  let attempts = 0;
  await page.route(data, (route) => {
    attempts++;
    return route.fulfill({ status: 503, body: "" });
  });
  await page.goto(origin + app);
  await drawn(page, "the Tour");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator("main").getByRole("link", { name: PROJECTS[0]!.name, exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("This example could not load.");
  await expect(page.getByText(UNKNOWN)).toHaveCount(0);
  await page.waitForTimeout(1_000); // the page's reads go on; none downloads again
  expect(attempts).toBe(1);
  await page.unroute(data);
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  await onOverview(page, PROJECTS[0]!);
  await expect(page.getByText("Agent tools available (WebMCP)")).toBeVisible();
  expect(await listDiagrams(page)).toContain("coffee-controls");
});
