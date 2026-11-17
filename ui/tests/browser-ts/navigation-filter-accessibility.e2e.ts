import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import type { TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { sharedTsProject } from "./support/shared-service";

const PAGE = testPage();
const FILES = {
  "archer.toml": `version = 1
name = "Accessibility fixture"
[[views]]
id = "checkout"
kind = "freeform"
title = "Checkout"
source = ".archer/checkout.mmd"
`,
  ".archer/checkout.mmd": "flowchart LR\n a[Reader] route@--> b[Checkout]\n",
  ".archer/notes/operations.md": "# Operations\n\nRun the service.\n",
};

let project: TsProject | undefined;

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
});

test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

test("the collapsed navigation scroll region is keyboard accessible", async ({ page }) => {
  project = await sharedTsProject({ files: FILES });
  await page.setViewportSize({ width: 1440, height: 320 });
  await page.goto(project.address(`q=`));

  const navigation = page.locator(".primary-sections");
  await expect(navigation).toBeVisible();
  expect(
    await navigation.evaluate((element) => element.scrollHeight > element.clientHeight),
    "the fixture exercises an active navigation scrollbar",
  ).toBe(true);
  const results = await new AxeBuilder({ page }).include(".primary-navigation").analyze();
  expect(
    results.violations.flatMap((violation) =>
      violation.nodes.map((node) => `${violation.id}: ${node.target.join(" ")}`),
    ),
  ).not.toContain("scrollable-region-focusable: .primary-sections");
});

test("phone filter choices expose 44px touch targets", async ({ page }) => {
  project = await sharedTsProject({ files: FILES });
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto(project.address(`q=`));

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const choices = page.getByRole("dialog", { name: "Project Filters" }).locator(".archer-search-choice:visible");
  expect(await choices.count()).toBeGreaterThan(0);
  for (const choice of await choices.all()) {
    const box = await choice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, "each visible filter choice has a 44px phone target").toBeGreaterThanOrEqual(44);
  }
});
