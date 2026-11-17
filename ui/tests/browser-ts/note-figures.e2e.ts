/**
 * A note's mermaid fences drawn in place against the real service (slice B of
 * docs/proposals/notes-with-embedded-diagrams.md): a figure is drawn by the
 * export painter only once it is near the screen, a fence that does not
 * compile says so in words, the note says how fresh it is, a passage after a
 * figure is still commented on where it was, and nothing of it fails axe or
 * overflows a phone's width.
 */
import { files as projectPage } from "./support/primary-navigation";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const prose = Array.from(
  { length: 80 },
  (_, i) => `Paragraph ${i + 1} of the long explanation between the two diagrams.`,
).join("\n\n");
const NOTE = [
  "# Auth design",
  "",
  "## Login flow",
  "",
  "```mermaid",
  "flowchart LR",
  '  user["User"] e1@--> api["API"]',
  '  api e2@--> store[("Session store")]',
  "```",
  "",
  "The parser accepts tokens.",
  "",
  prose,
  "",
  "## Broken",
  "",
  "```mermaid",
  "flowchart LR",
  "  a[A] --> b[B]",
  "```",
  "",
].join("\n");

let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function open(page: Page) {
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

test("a note's diagrams are drawn in place as the reader scrolls, and say what they are", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const login = page.getByRole("figure", { name: "login-flow, Flowchart" });
  const broken = page.getByRole("figure", { name: "broken, Flowchart" });
  await expect(login.locator("svg.archer-note-figure-drawing [data-element-id]")).toHaveCount(5);
  await expect(login).toContainText("Not in Git");
  await expect(page.locator(".primary-note-meta")).toHaveText(/^Not in Git/);
  // The fence's code is not shown beside its drawing.
  await expect(page.getByText('user["User"] e1@--> api["API"]')).toBeHidden();

  // The second figure is screens away: it waits, then draws once scrolled near.
  await expect(broken).toHaveAttribute("data-state", "waiting");
  await broken.scrollIntoViewIfNeeded();
  await expect(broken).toContainText("Does not compile: 1 problem");
  await expect(broken.getByText("a[A] --> b[B]")).toBeVisible();

  // The drawing fits its plate, and the plate the reader's column.
  const reader = (await page.getByRole("article", { name: "Reading Auth design" }).boundingBox())!;
  const plate = (await login.boundingBox())!;
  expect(plate.width).toBeLessThanOrEqual(reader.width);
  const drawing = (await login.locator("svg.archer-note-figure-drawing").boundingBox())!;
  expect(drawing.width).toBeLessThanOrEqual(plate.width);

  // The hash and date are a focus away.
  const freshness = login.locator(".archer-freshness");
  await freshness.focus();
  await expect(freshness).toBeFocused();

  expect(
    (await new AxeBuilder({ page }).include(".primary-note-reader").analyze()).violations.map((v) => v.id),
  ).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await login.scrollIntoViewIfNeeded();
  const narrow = (await login.boundingBox())!;
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(390);
});

test("a passage after a figure is commented on where it is", async ({ page }) => {
  await open(page);
  await expect(
    page.getByRole("figure", { name: "login-flow, Flowchart" }).locator("svg.archer-note-figure-drawing"),
  ).toBeVisible();
  const body = page.getByRole("document", { name: "Note: Auth design" });
  const paragraph = body.getByText("The parser accepts tokens.");
  await paragraph.evaluate((element) => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "The parser".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await paragraph.dispatchEvent("pointerup");
  await page.getByRole("button", { name: "Comment on selection", exact: true }).click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Which parser?");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(body.locator("mark[data-thread-id]")).toHaveText("The parser");
  const saved = JSON.parse(readFileSync(join(server!.root, ".archer/notes/auth.comments.json"), "utf8")) as {
    threads: { anchor: unknown }[];
  };
  expect(saved.threads[0]?.anchor).toEqual({
    kind: "passage",
    quote: "The parser",
    prefix: "",
    suffix: " accepts tokens.",
  });
});

// O182: the reader scrolls inside its article, and a margin on the viewport stopped at the article's edge, so a
// figure a screen below the fold waited until it was in sight (and one passed in a quick scroll stayed undrawn).
test("a figure within a screen below the reader's fold is drawn before it is scrolled to", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const short = NOTE.replace(prose, prose.split("\n\n").slice(0, 16).join("\n\n"));
  server = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n a[Client] e1@--> b[API]\n",
      ".archer/notes/auth.md": short,
    },
  });
  await page.goto(server.url);
  await server.present("system");
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(2);
  await (await projectPage(page)).getByRole("button", { name: "Auth design", exact: true }).click();
  const reader = page.getByRole("article", { name: "Reading Auth design" });
  const broken = page.getByRole("figure", { name: "broken, Flowchart" });
  await expect(page.getByRole("figure", { name: "login-flow, Flowchart" })).toHaveAttribute("data-state", "drawn");
  // Out of sight, below the article's fold, but within a screen of it.
  const shown = (await reader.boundingBox())!;
  const below = (await broken.boundingBox())!;
  expect(below.y, "the figure is below the fold").toBeGreaterThan(shown.y + shown.height);
  expect(below.y, "the figure is within a screen of the fold").toBeLessThan(shown.y + 2 * shown.height);
  await expect(broken).toContainText("Does not compile: 1 problem");
  expect(await reader.evaluate((article) => article.scrollTop), "nothing scrolled the reader").toBe(0);
});
