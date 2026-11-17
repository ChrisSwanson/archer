/**
 * The canvas's own framings keep the drawing out from under the chrome floating over it (second rendered review,
 * 2026-11-13, D): the walkthrough camera already framed clear of the tool rail and the chat button
 * (`clearOfChrome`), but Fit view and `1` framed as if the chat button were not there, and a drawing that overflowed
 * only into the gutter at its reading size (the heartbeat at 1440x900) opened with its last node on the canvas's edge.
 */
import { expect, test, type Page } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { archerTourFiles } from "../support/archer-tour";
import { testPage } from "./support/page-path";
import { settled } from "./support/settled";

/** Six columns of nine boxes: a drawing about as wide as it is tall, so a fit fills the canvas to its corners. */
const GRID = [
  "flowchart TB",
  ...Array.from(
    { length: 54 },
    (_, i) => `  c${i % 6}r${Math.floor(i / 6)}[Column ${(i % 6) + 1} row ${Math.floor(i / 6) + 1}]`,
  ),
  ...Array.from({ length: 48 }, (_, i) => {
    const [from, to] = [`c${i % 6}r${Math.floor(i / 6)}`, `c${i % 6}r${Math.floor(i / 6) + 1}`];
    return `  ${from} ${from}_${to}@--> ${to}`;
  }),
].join("\n");

let server: TsProject;
test.beforeAll(async () => {
  const files = archerTourFiles();
  files["archer.toml"] += '\n[[views]]\nid = "grid"\nkind = "freeform"\ntitle = "Grid"\nsource = ".archer/grid.mmd"\n';
  files[".archer/grid.mmd"] = `${GRID}\n`;
  server = await startTsProject({ pagePath: testPage(), files });
});
test.afterAll(async () => {
  await server?.stop();
});

type Rect = { left: number; top: number; right: number; bottom: number };
const meets = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The canvas, the chrome floating over it and every node on it, as screen rectangles. */
async function seen(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return {
      canvas: rect(document.querySelector(".react-flow")!),
      chrome: [...document.querySelectorAll(".react-flow__controls, .archer-chat-fab")].map((el) => ({
        name: el.classList.contains("archer-chat-fab") ? "chat button" : "tool rail",
        ...rect(el),
      })),
      nodes: [...document.querySelectorAll(".react-flow__node")].map((el) => ({
        id: el.getAttribute("data-id") ?? "",
        ...rect(el),
      })),
    };
  });
}

async function open(page: Page, id: string): Promise<void> {
  // A file the service has only just found may still be compiling.
  await expect
    .poll(
      () =>
        server.present(id).then(
          () => true,
          (error: Error) => error.message,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Chat with the agent about/ })).toBeVisible();
  await settled(page);
}

function underChrome(view: Awaited<ReturnType<typeof seen>>): string[] {
  const clashes: string[] = [];
  for (const node of view.nodes)
    for (const piece of view.chrome) if (meets(node, piece)) clashes.push(`${node.id} under the ${piece.name}`);
  return clashes;
}

for (const [label, size, phone] of [
  ["1440x900", { width: 1440, height: 900 }, false],
  ["390x844", { width: 390, height: 844 }, true],
] as const) {
  test(`at ${label} Fit view draws nothing under the tool rail or the chat button`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: size,
      hasTouch: phone,
      isMobile: phone,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await open(page, "grid");
      await page.getByRole("button", { name: "Fit view" }).click();
      await settled(page);
      const view = await seen(page);
      expect(view.nodes.length).toBe(54);
      expect(underChrome(view)).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("at 1440x900 the heartbeat opens with a margin round it, not on the canvas's edge", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await open(page, "heartbeat");
    const view = await seen(page);
    expect(view.nodes.length).toBe(8);
    const tight = view.nodes
      .map((node) => ({
        id: node.id,
        air: Math.min(
          node.left - view.canvas.left,
          node.top - view.canvas.top,
          view.canvas.right - node.right,
          view.canvas.bottom - node.bottom,
        ),
      }))
      .filter((node) => node.air < 8);
    expect(tight).toEqual([]);
    expect(underChrome(view)).toEqual([]);
  } finally {
    await context.close();
  }
});
