import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { AddressInfo } from "node:net";

let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await server?.close();
});
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

test("authoring supports real node drag, connection handle drag and direct label editing without changing layout", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/browser-ts/fixtures/authoring-canvas.html`);
  const client = node(page, "a"),
    target = node(page, "b");
  const canvasBox = (await page.getByRole("application", { name: "Diagram canvas" }).boundingBox())!;
  expect((await page.getByTestId("events").boundingBox())!.y).toBeGreaterThanOrEqual(canvasBox.y + canvasBox.height);
  await expect(client).toHaveClass(/\bdraggable\b/);
  await expect(client.locator(".react-flow__handle.source")).toBeVisible();
  const before = (await client.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 110, before.y + before.height / 2 - 65, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId("events")).toContainText('"kind":"move","id":"a"');
  const moved = (await client.boundingBox())!;
  expect(moved.x).toBeGreaterThan(before.x + 50);
  const from = (await client.locator(".react-flow__handle.source").boundingBox())!,
    to = (await target.locator(".react-flow__handle.target").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId("events")).toContainText('"kind":"connect","source":"a","target":"b"');
  await client.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit label" })).toBeFocused();
  await expect(page.getByTestId("events")).toContainText('"kind":"node-label","id":"a"');
  await page.locator(".archer-edge-label").dblclick();
  await expect(page.getByRole("textbox", { name: "Edit label" })).toBeFocused();
  await expect(page.getByTestId("events")).toContainText('"kind":"edge-label","id":"e1"');
  await expect(page.getByTestId("layout-intact")).toHaveText("true");
});

test("placement uses flow coordinates and reader/disabled/grouped nodes remain fixed", async ({ page }) => {
  await page.goto(`${origin}/tests/browser-ts/fixtures/authoring-canvas.html`);
  await expect(node(page, "a")).toBeVisible();
  await page.getByRole("button", { name: "Place box" }).click();
  const expectedPosition = await page.locator(".react-flow").evaluate((element) => {
    const rect = element.getBoundingClientRect(),
      viewport = element.querySelector(".react-flow__viewport")!;
    const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
    return { x: (120 - matrix.e) / matrix.a, y: (500 - matrix.f) / matrix.d, left: rect.left, top: rect.top };
  });
  await page.locator(".react-flow__pane").click({ position: { x: 120, y: 500 } });
  await expect(page.getByTestId("events")).toContainText('"kind":"place"');
  const placed = JSON.parse((await page.getByTestId("events").textContent())!)[0];
  expect(placed.position.x).toBeCloseTo(expectedPosition.x, 1);
  expect(placed.position.y).toBeCloseTo(expectedPosition.y, 1);
  for (const mode of ["reader", "disabled", "grouped"]) {
    await page.goto(`${origin}/tests/browser-ts/fixtures/authoring-canvas.html?${mode}=1`);
    const client = node(page, "a");
    await expect(client).not.toHaveClass(/\bdraggable\b/);
    const before = (await client.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 100, before.y + before.height / 2 + 50, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("events")).toHaveText("[]");
    await expect(page.getByTestId("layout-intact")).toHaveText("true");
  }
});
