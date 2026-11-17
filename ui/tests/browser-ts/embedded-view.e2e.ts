/**
 * Slice C against the real service (ADR 0012): a diagram drawn in a note
 * opens in the canvas at its address; it is commented on there, which pins
 * its name into the note; the breadcrumb's note segment goes back to the note
 * where the reader was, with the figure focused; and an agent's write to the
 * block reaches the open canvas live.
 */
import { files as projectPage } from "./support/primary-navigation";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TsProject } from "../support/ts-service";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";

const ADDRESS = "notes/auth.md#login-flow";
const prose = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} before the diagram.`).join("\n\n");
const NOTE = `# Auth design\n\n${prose}\n\n## Login flow\n\n\`\`\`mermaid\nflowchart LR\n  user["User"] e1@--> api["API"]\n\`\`\`\n\nAfter the diagram.\n`;

let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function openNote(page: Page): Promise<void> {
  server = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n a[Client] e1@--> b[API]\n",
      ".archer/notes/auth.md": NOTE,
    },
  });
  await page.goto(server.url);
  await server.present("system");
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(2);
  await (await projectPage(page)).getByRole("button", { name: "Auth design", exact: true }).click();
  await expect(page.getByRole("article", { name: "Reading Auth design" })).toBeVisible();
}

const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });

test("a diagram in a note opens at its address, is commented on, and goes back to the note where the reader was", async ({
  page,
}) => {
  await openNote(page);
  const link = page.getByRole("link", { name: "Open login-flow, Flowchart" });
  await link.scrollIntoViewIfNeeded();
  await expect(link.locator("svg.archer-note-figure-drawing")).toBeVisible();
  const reader = page.getByRole("article", { name: "Reading Auth design" });
  const scrolled = await reader.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(100);

  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  await expect(crumbs(page).getByRole("button")).toHaveText(["Projects", /./, "notes", "auth.md"]);
  await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText("login-flow");
  await expect(page.locator(".primary-document-trail")).toContainText("Not in Git");
  expect(
    (await new AxeBuilder({ page }).include(".primary-document-bar").analyze()).violations.map((v) => v.id),
  ).toEqual([]);

  // A comment on a node of it, through the page; the first one pins its name.
  const node = page.locator('.react-flow__node[data-id="user"]');
  await node.click({ button: "right" });
  await chooseComment(page);
  const composer = page.getByRole("form", { name: "New comment" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment", exact: true }).fill("Who signs in here?");
  await composer.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect
    .poll(() => readFileSync(join(server!.root, ".archer/notes/auth.md"), "utf8"))
    .toContain("```mermaid\n%% archer-id: login-flow\nflowchart LR");
  const saved = JSON.parse(readFileSync(join(server!.root, ".archer/notes/auth.login-flow.comments.json"), "utf8")) as {
    target: string;
    threads: { anchor: { id: string } }[];
  };
  expect(saved.target).toBe(`view:${ADDRESS}`);
  expect(saved.threads[0]?.anchor.id).toBe("user");
  // Pinning did not move the drawing: the reader's view is still up.
  await expect(node).toBeVisible();

  await crumbs(page).getByRole("button", { name: "auth.md", exact: true }).click();
  await expect(reader).toBeVisible();
  await expect(page.getByRole("link", { name: "Open login-flow, Flowchart" })).toBeFocused();
  expect(Math.abs((await reader.evaluate((el) => el.scrollTop)) - scrolled)).toBeLessThanOrEqual(2);
});

test("a pointer activation survives the figure drawing replacing its pressed child", async ({ page }, testInfo) => {
  let releaseResponse = (): void => {};
  const responseRelease = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let reportResponse = (): void => {};
  const responseReady = new Promise<void>((resolve) => {
    reportResponse = resolve;
  });
  const pattern = "**/api/notes/diagram?*";
  // Only the figure's read is held. Opening the diagram makes the header read the same address for its
  // freshness; held too, it was still in this handler when the test ended, and its fulfil failed.
  let held = false;
  await page.route(pattern, async (route) => {
    expect(route.request().method()).toBe("GET");
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    reportResponse();
    await responseRelease;
    await route.fulfill({ response });
  });
  let pointerDown = false;
  try {
    await openNote(page);
    const link = page.getByRole("link", { name: "Open login-flow, Flowchart" });
    await link.scrollIntoViewIfNeeded();
    const placeholder = link.locator("p.archer-note-figure-wait");
    await expect(placeholder).toHaveText("Drawing…");
    await responseReady;
    const beforeBox = await placeholder.boundingBox();
    if (beforeBox === null) throw new Error("drawing placeholder has no browser box");
    const point = { x: beforeBox.x + beforeBox.width / 2, y: beforeBox.y + beforeBox.height / 2 };
    const beforeTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, point);

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    pointerDown = true;
    releaseResponse();
    await expect(link.locator("svg.archer-note-figure-drawing")).toBeVisible();
    const afterBox = await link.boundingBox();
    const afterTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, point);
    const evidence = testInfo.outputPath("figure-pointer-replacement.json");
    writeFileSync(evidence, JSON.stringify({ beforeBox, afterBox, point, beforeTarget, afterTarget }));
    await testInfo.attach("figure-pointer-replacement.json", {
      path: evidence,
      contentType: "application/json",
    });
    expect({ beforeTarget, afterTarget }).toEqual({ beforeTarget: "A", afterTarget: "A" });
    await page.mouse.up();
    pointerDown = false;

    await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  } finally {
    releaseResponse();
    if (pointerDown) await page.mouse.up();
    await page.unroute(pattern);
  }
});

test("an agent's write to the block reaches the open diagram live, and its removal says so", async ({ page }) => {
  await openNote(page);
  await page.getByRole("link", { name: "Open login-flow, Flowchart" }).click();
  await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  await server!.agentWrite(
    ADDRESS,
    ".archer/notes/auth.md",
    NOTE.replace('user["User"] e1@--> api["API"]', 'user["User"] e1@--> api["API"]\n  api e2@--> db[("DB")]'),
    "added the database",
  );
  await expect(page.locator('.react-flow__node[data-id="db"]')).toBeVisible();
  await server!.agentWrite(ADDRESS, ".archer/notes/auth.md", NOTE.replace(/```mermaid[\s\S]*?```\n/, ""));
  await expect(page.getByText("This diagram is no longer in its note.")).toBeVisible();
  await expect(crumbs(page).getByRole("button", { name: "auth.md", exact: true })).toBeVisible();
});
