import { expect, test } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml":
    'version = 1\n\n[[views]]\nid = "checkout"\nkind = "freeform"\ntitle = "Checkout"\nsource = ".archer/checkout.mmd"\n',
  ".archer/checkout.mmd": "flowchart LR\n  a[Cart]\n  b[Payment]\n  a pays@--> b\n",
  ".archer/notes/payment.md":
    "---\ntitle: Payment page\nviews: [checkout]\n---\n\n# Payment page\n\nWe use a hosted payment page.\n",
};
let project: TsProject;
test.beforeEach(async () => {
  project = await sharedTsProject({ files });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await project.stop();
});

test("a note route with a presented view reads nothing for that view", async ({ page }) => {
  await project.present("checkout");
  const access = await project.issueAccess("note route reads");
  await page.goto(access.url);
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/api/")) asked.push(decodeURIComponent(url.pathname + url.search));
  });
  await page.goto(`${new URL(project.url).origin}/projects/${slug}/notes/payment.md`);
  await expect(page.getByRole("heading", { name: "Payment page", level: 1 })).toBeVisible();
  // The page settles: the reads the note itself needs are in.
  await page.waitForTimeout(1_500);
  const forView = asked.filter((url) => /checkout/.test(url) && !url.includes("/api/thumbnails/"));
  expect(forView, asked.join("\n")).toEqual([]);
});
