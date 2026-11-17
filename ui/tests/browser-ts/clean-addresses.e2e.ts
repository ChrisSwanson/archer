/**
 * Clean page addresses in a real browser against the real service (ADR 0017, amended
 * 2026-10-18): the agent's link carries the token once and lands clean; files open by path,
 * a note's diagram by #<name>; .archer wins a clash and -/repo/ reaches the shadowed document;
 * legacy links land on their canonical address; a missing file says it moved.
 */
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const NOTE =
  '# Auth design\n\n## Login flow\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  user["User"] e1@--> api["API"]\n```\n';
let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const path = (page: Page): string => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
};

async function start(): Promise<{ server: TsProject; name: string }> {
  server = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[discovery]\nroots = [".archer", "docs"]\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/diagrams/system.mmd"\n',
      ".archer/diagrams/system.mmd": "flowchart LR\n sys[System] e1@--> ext[Partner]\n",
      ".archer/notes/auth.md": NOTE,
      ".archer/docs/guide.md": "# Archer guide\n\nFrom the Archer folder.\n",
      "docs/guide.md": "# Repository guide\n\nFrom the repository.\n",
      "docs/only.md": "# Only outside\n\nOutside the Archer folder.\n",
    },
  });
  return { server, name: new URL(server.agentUrl).pathname.split("/")[2]! };
}

test("the agent's link carries the token once and lands on the clean follow address", async ({ page }) => {
  const { server, name } = await start();
  expect(server.agentUrl).toMatch(new RegExp(`/projects/${name}/\\?follow&token=[0-9a-f]{32}$`));
  await server.present("system");
  await page.goto(server.agentUrl);
  await expect(page.locator('.react-flow__node[data-id="sys"]')).toBeVisible();
  expect(path(page)).toBe(`/projects/${name}/?follow`);
  // The remembered cookie is HttpOnly: the page never sees the credential.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(page.url()).not.toContain("token");
});

test("files open by path, a note's diagram by its name, and each is a reloadable history entry", async ({ page }) => {
  const { server, name } = await start();
  await page.goto(server.agentUrl);
  await page.goto(new URL(`/projects/${name}/notes/auth.md`, page.url()).href);
  await expect(page.getByRole("article", { name: "Reading Auth design" })).toBeVisible();
  await page.getByRole("link", { name: "Open login, Flowchart" }).click();
  await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  await expect.poll(() => path(page)).toBe(`/projects/${name}/notes/auth.md#login`);
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("article", { name: "Reading Auth design" })).toBeVisible();
  expect(path(page)).toBe(`/projects/${name}/notes/auth.md`);
  await page.goto(new URL(`/projects/${name}/diagrams/system.mmd`, page.url()).href);
  await expect(page.locator('.react-flow__node[data-id="sys"]')).toBeVisible();
  await page.goto(new URL(`/projects/${name}/diagrams/`, page.url()).href);
  await expect(page.getByRole("region", { name: "diagrams", exact: true })).toBeVisible();
});

test(".archer wins a clash; -/repo/ reaches the shadowed document; an outside document opens read-only", async ({
  page,
}) => {
  const { server, name } = await start();
  await page.goto(server.agentUrl);
  await page.goto(new URL(`/projects/${name}/docs/guide.md`, page.url()).href);
  await expect(page.getByRole("article", { name: "Reading Archer guide" })).toContainText("From the Archer folder.");
  await page.goto(new URL(`/projects/${name}/-/repo/docs/guide.md`, page.url()).href);
  await expect(page.getByRole("article", { name: "Reading guide.md" })).toContainText("From the repository.");
  await page.goto(new URL(`/projects/${name}/docs/only.md`, page.url()).href);
  await expect(page.getByRole("article", { name: "Reading only.md" })).toContainText("Outside the Archer folder.");
  await page.goto(new URL(`/projects/${name}/notes/gone.md`, page.url()).href);
  await expect(page.getByRole("alert")).toContainText("moved or deleted");
});

test("query destinations on the follow page land on their canonical address", async ({ page }) => {
  const { server, name } = await start();
  await page.goto(server.address("view=system"));
  await expect(page.locator('.react-flow__node[data-id="sys"]')).toBeVisible();
  await expect.poll(() => path(page)).toBe(`/projects/${name}/diagrams/system.mmd`);
  await page.goto(server.address(`view=${encodeURIComponent("notes/auth.md#login")}`));
  await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  await expect.poll(() => path(page)).toBe(`/projects/${name}/notes/auth.md#login`);
  await page.goto(server.address(`note=notes%2Fauth.md`));
  await expect(page.getByRole("article", { name: "Reading Auth design" })).toBeVisible();
  await expect.poll(() => path(page)).toBe(`/projects/${name}/notes/auth.md`);
});
