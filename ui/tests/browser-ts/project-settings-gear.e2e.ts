/**
 * The project page's gear opens Project settings over the real project-settings API: a saved
 * name reaches archer.toml and the title section, and Escape returns focus to the gear.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function projectPage(page: Page): Promise<void> {
  server = await sharedTsProject({
    files: {
      "archer.toml": '# The shop\nversion = 1\nname = "Shop"\ndescription = "An online shop."\n',
      ".archer/diagrams/context.mmd": "flowchart LR\n shop[Shop] e1@--> bank[Bank]\n",
      ".archer/notes/operations.md": "# Operations\n\nRunning the shop.\n",
    },
  });
  await page.goto(server.agentUrl);
  const name = new URL(server.agentUrl).pathname.split("/")[2]!;
  await page.goto(new URL(`/projects/${name}/`, server.agentUrl).href);
}

test("the gear opens Project settings; name and description are read-only and archer.toml is untouched", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await projectPage(page);
  const before = await readFile(join(server!.root, "archer.toml"), "utf8");
  const gear = page.getByRole("button", { name: "Project settings", exact: true });
  await gear.click();
  const dialog = page.getByRole("dialog", { name: /Project Settings/ });
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue("Shop");
  await expect(name).toHaveAttribute("readonly", "");
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.map((violation) => violation.id),
  ).toEqual([]);
  const refused = await page.evaluate(
    async () =>
      (
        await fetch(location.pathname.replace(/^\/projects\/([^/]+)\/.*$/u, "/p/$1/api/project-settings"), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: "x", changes: { name: "Corner shop" } }),
        })
      ).status,
  );
  expect(refused).toBe(403);
  expect(await readFile(join(server!.root, "archer.toml"), "utf8")).toBe(before);
});

test("Escape closes Project settings and returns focus to the gear", async ({ page }) => {
  await projectPage(page);
  const gear = page.getByRole("button", { name: "Project settings", exact: true });
  await gear.click();
  const dialog = page.getByRole("dialog", { name: /Project Settings/ });
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Shop");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(gear).toBeFocused();
});
