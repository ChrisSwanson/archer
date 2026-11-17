import { expect, test, type Locator, type Page } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";
async function camera(page: Page) {
  return page.evaluate(() => {
    const graph = document.querySelector<HTMLElement>(".react-flow__viewport");
    const text =
      graph?.style.transform ?? document.querySelector(".archer-seq-viewport")?.getAttribute("transform") ?? "";
    const values = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((v) => Number(v[0]));
    return { x: values[0]!, y: values[1]!, zoom: values[2]! };
  });
}
async function hitPoint(target: Locator) {
  return target.evaluate((element) => {
    if (element instanceof SVGPathElement) {
      const at = element.getPointAtLength(element.getTotalLength() / 2);
      const matrix = element.getScreenCTM();
      if (!matrix) throw new Error("no path matrix");
      return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
    }
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
}
async function drag(page: Page, target: Locator, button: "left" | "middle" = "left") {
  const point = await hitPoint(target);
  const before = await camera(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button });
  await page.mouse.move(point.x + 70, point.y + 40, { steps: 8 });
  await page.mouse.up({ button });
  await expect.poll(async () => Math.round((await camera(page)).x - before.x)).toBe(70);
  const after = await camera(page);
  expect(after.y - before.y).toBeCloseTo(40, 0);
  expect(after.zoom).toBe(before.zoom);
}
for (const family of ["graph", "sequence"] as const)
  test(`${family}: Hand pans semantic elements without changing service selection; Select restores clicks`, async ({
    page,
  }) => {
    const source =
      family === "graph"
        ? "flowchart LR\na[Client] e1@--> b[Server]\n"
        : "sequenceDiagram\nparticipant a as Client\nparticipant b as Server\na->>b: Request\n";
    const project = await sharedTsProject({
      files: {
        "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${family === "graph" ? "freeform" : "sequence"}"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n`,
        ".archer/drawing.mmd": source,
      },
    });
    try {
      await page.goto(project.url);
      await project.present("drawing");
      const client =
        family === "graph"
          ? page.locator('.react-flow__node[data-id="a"]')
          : page.locator('.archer-seq-participant[data-seq-id="a"] .archer-seq-participant-box');
      const server =
        family === "graph"
          ? page.locator('.react-flow__node[data-id="b"]')
          : page.locator('.archer-seq-participant[data-seq-id="b"] .archer-seq-participant-box');
      await expect(client).toBeVisible();
      await expect(page.getByRole("button", { name: "Hand mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await client.click();
      await expect.poll(() => project.selection()).toMatchObject({ nodes: [{ id: "a" }] });
      await expect(page.getByRole("button", { name: "Select mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByRole("button", { name: "Hand mode", exact: true }).click();
      await server.click();
      await expect.poll(() => project.selection()).toMatchObject({ nodes: [{ id: "a" }] });
      await drag(page, server);
      await expect.poll(() => project.selection()).toMatchObject({ nodes: [{ id: "a" }] });
      const edge =
        family === "graph"
          ? page.locator('.react-flow__edge[data-id="e1"] .react-flow__edge-interaction')
          : page.locator(".archer-seq-message .archer-seq-hit");
      await drag(page, edge);
      await expect.poll(() => project.selection()).toMatchObject({ nodes: [{ id: "a" }] });
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await server.click();
      await expect.poll(() => project.selection()).toMatchObject({ nodes: [{ id: "b" }] });
      {
        const point = await hitPoint(edge);
        await page.mouse.click(point.x, point.y);
      }
      await expect.poll(async () => (await project.selection())?.edges.length).toBe(1);
      const held = await project.selection();
      await page.getByRole("button", { name: "Hand mode", exact: true }).click();
      await client.click();
      {
        const point = await hitPoint(edge);
        await page.mouse.click(point.x, point.y);
      }
      await expect.poll(() => project.selection()).toEqual(held);
      // Measure and hit-test a free drag corridor; the diagram key occupies the bottom-right corner.
      const canvas = page.locator(family === "graph" ? ".react-flow__pane" : ".archer-seq-canvas");
      const blank = await canvas.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const emptyAt = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === element || (element.contains(hit) && hit.tagName.toLowerCase() === "svg"));
        };
        for (let y = box.y + 100; y < box.bottom - 90; y += 70) {
          for (let x = box.x + 100; x < box.right - 100; x += 90) {
            if (emptyAt(x, y) && emptyAt(x + 70, y + 40)) return { x, y };
          }
        }
        throw new Error("No unobstructed canvas drag corridor");
      });
      await page.mouse.move(blank.x, blank.y);
      const handBefore = await camera(page);
      await page.mouse.down();
      await page.mouse.move(blank.x + 70, blank.y + 40, { steps: 8 });
      await page.mouse.up();
      await expect.poll(async () => Math.round((await camera(page)).x - handBefore.x)).toBe(70);
      await expect.poll(() => project.selection()).toEqual(held);
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await page.mouse.move(blank.x, blank.y);
      await page.keyboard.down("Space");
      const before = await camera(page);
      await page.mouse.down();
      await page.mouse.move(blank.x + 70, blank.y + 40, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      await expect.poll(async () => Math.round((await camera(page)).x - before.x)).toBe(70);
      await expect(page.getByRole("button", { name: "Select mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const middleBefore = await camera(page);
      await page.mouse.move(blank.x, blank.y);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(blank.x + 70, blank.y + 40, { steps: 8 });
      await page.mouse.up({ button: "middle" });
      await expect.poll(async () => Math.round((await camera(page)).x - middleBefore.x)).toBe(70);
      await expect(page.getByRole("button", { name: "Select mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect.poll(() => project.selection()).toEqual(held);
      // A lost window focus cancels a held drag; returning the pointer cannot keep panning.
      await page.getByRole("button", { name: "Hand mode", exact: true }).click();
      await expect(page.getByRole("button", { name: "Hand mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const point = await hitPoint(client);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 35, point.y + 20, { steps: 4 });
      const cancelledCamera = await camera(page);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.move(point.x + 70, point.y + 40, { steps: 4 });
      await expect.poll(() => camera(page)).toEqual(cancelledCamera);
      await page.mouse.up();
      await expect(page.getByRole("button", { name: "Hand mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect.poll(() => project.selection()).toEqual(held);
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog").getByText(/In Hand mode, drag with the left button to pan/)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => project.selection()).toEqual(held);
    } finally {
      await project.stop();
    }
  });

test("graph: losing window focus cancels a held Hand drag", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": "flowchart LR\na[Client] e1@--> b[Server]\n",
    },
  });
  try {
    await page.goto(project.url);
    await project.present("drawing");
    const client = page.locator('.react-flow__node[data-id="a"]');
    await expect(client).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await client.click();
    await expect.poll(() => project.selection()).toMatchObject({ nodes: [{ id: "a" }] });
    const held = await project.selection();
    await page.getByRole("button", { name: "Hand mode", exact: true }).click();
    const point = await hitPoint(client),
      initial = await camera(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 35, point.y + 20, { steps: 4 });
    await expect.poll(async () => Math.round((await camera(page)).x - initial.x)).toBe(35);
    const cancelled = await camera(page);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.move(point.x + 70, point.y + 40, { steps: 4 });
    await expect.poll(() => camera(page)).toEqual(cancelled);
    await page.mouse.up();
    await expect.poll(() => project.selection()).toEqual(held);
    await expect(page.getByRole("button", { name: "Hand mode", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await project.stop();
  }
});
