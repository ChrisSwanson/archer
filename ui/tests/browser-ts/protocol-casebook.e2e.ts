/** The shipped RFC casebooks, copied into a real temporary project: source-backed reading, named
 * figures opening into the canvas, and an actual reader comment that never enters the examples. */
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exampleFiles } from "../support/archer-tour";
import type { TsProject } from "../support/ts-service";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";

const ROOT = resolve(import.meta.dirname, "../../..");
const cases = [
  {
    project: "rfc-2324-htcpcp",
    title: "Protocol Casebook: Coffee",
    question: "What does this request name?",
    figure: "coffee-uri-slots",
    node: "coffee_pot",
    excerpt: 'coffee-url  =  coffee-scheme ":" [ "//" host ]',
    excerptElement: "pre",
    proseExcerpt: "headers sent in the request. In HTCPCP, this response code MAY be",
    column: "Slot",
    year: "1998",
  },
  {
    project: "rfc-1149-ipoac",
    title: "Protocol Casebook: Packets With Wings",
    question: "When can a carrier leave?",
    figure: "paper-datagram",
    node: "scroll",
    excerpt: "reader to scan each carrier as it enters the router and then enqueue",
    excerptElement: "blockquote",
    proseExcerpt: "The service level is indicated on a per-carrier basis by bar-code",
    column: "What the figure names",
    year: "1999",
  },
] as const;

let server: TsProject | undefined;
test.afterEach(async ({ page }) => {
  await page.close();
  await server?.stop();
  server = undefined;
});

test("phone casebook tables keep Scheme and Additions on one line and scroll within the note", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  server = await sharedTsProject({ files: exampleFiles("rfc-2324-htcpcp") });
  await page.goto(server.address("note=notes/reading-guide.md"));
  const reader = page.getByRole("article", { name: "Reading Protocol Casebook: Coffee" });
  await expect(reader).toBeVisible();
  for (const word of ["Scheme", "Additions"]) {
    const cell = reader.getByRole("cell", { name: word, exact: true });
    await expect(cell).toBeVisible();
    expect(
      await cell.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
      }),
    ).toBe(1);
    await expect(cell).toHaveCSS("overflow-wrap", "break-word");
  }
  for (const table of await reader.locator("table").all()) {
    await expect(table).toHaveCSS("overflow-x", "auto");
    expect(await table.evaluate((element) => element.clientWidth <= element.parentElement!.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("phone casebook table code keeps hyphenated grammar tokens together", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  server = await sharedTsProject({ files: exampleFiles("rfc-2324-htcpcp") });
  await page.goto(server.address("note=notes/reading-guide.md"));
  const reader = page.getByRole("article", { name: "Reading Protocol Casebook: Coffee" });
  await expect(reader).toBeVisible();
  const token = reader.locator("td code").filter({ hasText: /^coffee-scheme ":"$/ });
  await expect(token).toHaveCount(1);
  await token.scrollIntoViewIfNeeded();
  expect(
    await token.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
    }),
  ).toBe(1);
  await expect(token).toHaveCSS("white-space", "nowrap");
  const table = token.locator("xpath=ancestor::table");
  await expect(table).toHaveCSS("overflow-x", "auto");
  expect(await table.evaluate((element) => element.clientWidth <= element.parentElement!.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// The theme sets colours only; what is asserted here is layout and text. Each example is measured at each width in
// one theme, the two alternating so both examples, both widths and both themes are seen (and shot).
for (const [e, example] of cases.entries()) {
  for (const [w, width] of [1440, 390].entries()) {
    const theme = (["light", "dark"] as const)[(e + w) % 2]!;
    test(`${example.project}: ${width}px ${theme} renders evidence, a named figure and the full notice`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      server = await sharedTsProject({ files: exampleFiles(example.project) });
      await page.goto(server.address("note=notes/reading-guide.md"));
      const reader = page.getByRole("article", { name: `Reading ${example.title}` });
      await expect(reader).toBeVisible();
      await expect(reader.locator(example.excerptElement).filter({ hasText: example.excerpt })).toHaveCount(1);
      const proseExcerpt = reader.locator("blockquote").filter({ hasText: example.proseExcerpt });
      await expect(proseExcerpt).toHaveCount(1);
      expect(
        await proseExcerpt.evaluate((element) => ({
          whiteSpace: getComputedStyle(element.querySelector("p")!).whiteSpace,
          overflows: element.scrollWidth > element.clientWidth,
        })),
      ).toEqual({ whiteSpace: "normal", overflows: false });
      await expect(reader.getByRole("columnheader", { name: example.column, exact: true })).toHaveCount(1);
      await expect(reader).toContainText(`Copyright (C) The Internet Society (${example.year}).`);
      await expect(reader).toContainText("This document and the information contained herein is provided on an");
      await expect(reader).toContainText("AS IS");
      await expect(reader).toContainText("THE INTERNET ENGINEERING TASK FORCE DISCLAIMS ALL WARRANTIES");
      const figure = reader.getByRole("link", { name: `Open ${example.figure}, Flowchart`, exact: true });
      await figure.scrollIntoViewIfNeeded();
      await expect(figure.locator("svg.archer-note-figure-drawing")).toBeVisible();
      const plate = await figure.boundingBox();
      expect(plate).not.toBeNull();
      expect(plate!.x).toBeGreaterThanOrEqual(0);
      expect(plate!.x + plate!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await reader.getByRole("heading", { name: example.question, exact: true }).evaluate((element) => {
        element.scrollIntoView({ block: "start" });
      });
      mkdirSync(join(ROOT, ".shots"), { recursive: true });
      await page.screenshot({ path: join(ROOT, ".shots", `archer-${example.project}-${width}-${theme}.png`) });
    });
  }

  test(`${example.project}: a reader opens a casebook figure, selects, comments and returns`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    server = await sharedTsProject({ files: exampleFiles(example.project) });
    await page.goto(server.address("note=notes/reading-guide.md"));
    const reader = page.getByRole("article", { name: `Reading ${example.title}` });
    await expect(reader).toBeVisible();
    const figure = reader.getByRole("link", { name: `Open ${example.figure}, Flowchart`, exact: true });
    await figure.scrollIntoViewIfNeeded();
    await expect(figure.locator("svg.archer-note-figure-drawing")).toBeVisible();
    await figure.click();
    const node = page.locator(`.react-flow__node[data-id="${example.node}"]`);
    await expect(node).toBeVisible();
    // Reading canvases start in Hand mode: choose Select before pointing at a part.
    const select = page.getByRole("button", { name: "Select mode", exact: true });
    await select.click();
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await node.click();
    await expect
      .poll(() => server!.selection())
      .toMatchObject({
        viewId: `notes/reading-guide.md#${example.figure}`,
        nodes: [{ id: example.node }],
      });
    await node.click({ button: "right" });
    await chooseComment(page);
    const composer = page.getByRole("form", { name: "New comment" });
    await expect(composer).toBeVisible();
    await composer
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Which exact source supports this part?");
    await composer.getByRole("button", { name: "Add comment", exact: true }).click();
    const comments = join(server.root, `.archer/notes/reading-guide.${example.figure}.comments.json`);
    await expect
      .poll(() => JSON.parse(readFileSync(comments, "utf8")))
      .toMatchObject({
        target: `view:notes/reading-guide.md#${example.figure}`,
        threads: [{ anchor: { id: example.node } }],
      });
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "reading-guide.md", exact: true })
      .click();
    await expect(reader).toBeVisible();
    await expect(figure).toBeFocused();
  });
}
