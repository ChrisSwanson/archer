import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml": "version = 1\n",
  ".archer/states.mmd":
    "stateDiagram-v2\n    state Idle\n    state Busy\n    [*] --> Idle\n    Idle --> Busy : start\n",
  ".archer/model.mmd": "erDiagram\n    CUSTOMER\n    ORDER\n    CUSTOMER ||--o{ ORDER : places\n",
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
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
};
/** What has keyboard focus: a canvas node's id, or the element's tag. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const node = active?.closest<HTMLElement>(".react-flow__node");
    return node && node === active ? `node:${node.dataset.id}` : (active?.tagName.toLowerCase() ?? "none");
  });
async function open(page: Page, file: string) {
  const access = await project.issueAuthoringAccess("rename focus");
  await page.goto(access.url);
  await page.goto(`${new URL(project.url).origin}/projects/${slug()}/${file}?edit`);
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  await settled(page);
}

for (const { family, file, parts, part, name, id } of [
  { family: "state", file: "states.mmd", parts: "State parts", part: "State", name: "Choice", id: "Choice" },
  {
    family: "ER",
    file: "model.mmd",
    parts: "Entity relationship parts",
    part: "Entity",
    name: "Order line",
    id: "OrderLine",
  },
]) {
  test(`naming a new ${family} element puts focus on the element its name re-identifies, not the page body (G14)`, async ({
    page,
  }) => {
    await open(page, file);
    await page.getByRole("toolbar", { name: parts }).getByRole("button", { name: part, exact: true }).click();
    const field = page.getByRole("textbox", { name: / (label|name)$/u });
    await expect(field).toBeFocused();
    await field.fill(name);
    await field.press("Enter");
    await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
    await settled(page);
    await expect.poll(() => focused(page)).toBe(`node:${id}`);
  });
}

test("adding a state Choice (no name to type) puts focus on the new choice, not the page body (G14)", async ({
  page,
}) => {
  await open(page, "states.mmd");
  await expect(page.locator('.react-flow__node[data-id="Busy"]')).toBeVisible();
  await page.getByRole("toolbar", { name: "State parts" }).getByRole("button", { name: "Choice", exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id^="choice"]')).toHaveCount(1);
  await settled(page);
  await expect.poll(() => focused(page)).toMatch(/^node:choice/u);
});
