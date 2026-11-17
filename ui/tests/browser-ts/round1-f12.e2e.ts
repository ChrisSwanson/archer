import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml": "version = 1\n",
  ".archer/flow.mmd": "flowchart LR\n  a[Alpha]\n  b[Beta]\n  c[Gamma]\n  a e1@--> b\n",
};
let project: TsProject;
test.describe.configure({ timeout: 60_000 });
test.beforeEach(async () => {
  project = await sharedTsProject({ files });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await project.stop();
});

const slug = () => new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const settled = async (page: Page) => {
  await expect(page.getByText("Checking preview…")).toHaveCount(0);
  await expect(page.locator('.authoring-workspace [aria-busy="true"]')).toHaveCount(0);
};
const node = (page: Page, id: string) => page.locator(`.authoring-workspace .react-flow__node[data-id="${id}"]`);
/** What has keyboard focus: a canvas node's id, a named element's role and name, or the tag. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return "body";
    const n = active.closest<HTMLElement>(".react-flow__node");
    if (n && n === active) return `node:${n.dataset.id}`;
    const role = active.getAttribute("role") ?? active.tagName.toLowerCase(),
      name = active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "";
    return `${role}:${name}`;
  });
async function openEditor(page: Page) {
  const access = await project.issueAuthoringAccess("round1-f12");
  await page.goto(access.url);
  await page.goto(`${new URL(project.url).origin}/projects/${slug()}/flow.mmd?edit`);
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  await expect(node(page, "a")).toBeVisible();
  await settled(page);
}
const boxOf = async (page: Page, id: string) => (await node(page, id).boundingBox())!;

test("row 1 (F31): Edit on the reading page puts focus on the editor's named drawing", async ({ page }) => {
  const access = await project.issueAuthoringAccess("round1-f12");
  await page.goto(access.url);
  await page.goto(`${new URL(project.url).origin}/projects/${slug()}/flow.mmd`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  await expect.poll(() => focused(page)).toBe("group:Drawing");
});

test("row 2 (F33): choosing in Connect to… draws the connection and leaves focus on Connect to…", async ({ page }) => {
  await openEditor(page);
  await node(page, "a").click();
  const connectTo = page.getByRole("button", { name: "Connect to…" });
  await expect(connectTo).toBeEnabled();
  await connectTo.click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Gamma" }).click();
  await expect(page.locator(".authoring-workspace .react-flow__edge")).toHaveCount(2);
  await settled(page);
  await expect.poll(() => focused(page)).toBe("button:Connect to…");
  await expect(connectTo).toBeEnabled();
});

test("row 3 (F35): Delete on an unconnected shape moves focus to the nearest remaining shape", async ({ page }) => {
  await openEditor(page);
  await node(page, "c").click();
  await node(page, "c").focus();
  await page.keyboard.press("Delete");
  await expect(node(page, "c")).toHaveCount(0);
  await settled(page);
  await expect.poll(() => focused(page)).toMatch(/^node:[ab]$/u);
});

test("row 4 (D10, D16): Escape during a node drag puts the shape back and ends the drag; nothing is moved", async ({
  page,
}) => {
  await openEditor(page);
  const start = await boxOf(page, "a"),
    x = start.x + start.width / 2,
    y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 90, { steps: 10 });
  expect((await boxOf(page, "a")).x).toBeGreaterThan(start.x + 60);
  await page.keyboard.press("Escape");
  // Back at once, while the button is still held, and the pointer no longer carries it.
  await expect.poll(async () => Math.round((await boxOf(page, "a")).x)).toBe(Math.round(start.x));
  await page.mouse.move(x + 200, y + 150, { steps: 5 });
  expect(Math.round((await boxOf(page, "a")).x)).toBe(Math.round(start.x));
  await page.mouse.up();
  await settled(page);
  const end = await boxOf(page, "a");
  expect(Math.round(end.x)).toBe(Math.round(start.x));
  expect(Math.round(end.y)).toBe(Math.round(start.y));
  await expect(page.getByRole("button", { name: "Reset layout" })).toBeDisabled();
  await expect(page.locator(".authoring-statusline")).not.toContainText("Moved");
});

test("row 4 (D10, 2.5.2): releasing a dragged shape outside the drawing leaves it where it was", async ({ page }) => {
  await openEditor(page);
  // Measured against another shape: the drag pans the view as it nears the edge, so screen places shift.
  const offset = async () => {
    const [b, a] = [await boxOf(page, "b"), await boxOf(page, "a")];
    return { x: Math.round(b.x - a.x), y: Math.round(b.y - a.y) };
  };
  const before = await offset();
  const start = await boxOf(page, "b"),
    x = start.x + start.width / 2,
    y = start.y + start.height / 2;
  const drawing = (await page.getByRole("group", { name: "Drawing" }).boundingBox())!;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Up past the drawing's top edge, over the page header (the review's release at y −424).
  await page.mouse.move(x, y - 40, { steps: 4 });
  await page.mouse.move(x, Math.max(2, drawing.y - 40), { steps: 10 });
  await page.mouse.up();
  await settled(page);
  expect(await offset()).toEqual(before);
  await expect(page.getByRole("button", { name: "Reset layout" })).toBeDisabled();
  await expect(page.locator(".authoring-statusline")).not.toContainText("Moved");
  await expect(page.getByText("Let go outside the drawing: “Beta” stays where it was.")).toBeVisible();
});

test("row 4 control: an ordinary drag inside the drawing still moves the shape", async ({ page }) => {
  await openEditor(page);
  const start = await boxOf(page, "a"),
    x = start.x + start.width / 2,
    y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 80, { steps: 10 });
  await page.mouse.up();
  await settled(page);
  expect((await boxOf(page, "a")).x).toBeGreaterThan(start.x + 50);
  await expect(page.locator(".authoring-statusline")).toContainText("Moved “Alpha”");
});
