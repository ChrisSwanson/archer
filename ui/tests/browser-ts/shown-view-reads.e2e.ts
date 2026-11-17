import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml":
    'version = 1\n\n[[views]]\nid = "checkout"\nkind = "freeform"\ntitle = "Checkout"\nsource = ".archer/diagrams/checkout.mmd"\n\n' +
    '[[views]]\nid = "orders"\nkind = "freeform"\ntitle = "Orders"\nsource = ".archer/diagrams/orders.mmd"\n',
  ".archer/diagrams/checkout.mmd": "flowchart LR\n  a[Cart]\n  b[Payment]\n  a pays@--> b\n",
  ".archer/diagrams/orders.mmd": "flowchart LR\n  o[Order]\n  s[Shipped]\n  o ships@--> s\n",
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

/** Per-view reads (emphasis, threads, notes, walkthroughs, presentation) that name `viewId`, as the page asked them. */
function readsFor(page: Page, viewId: string): string[] {
  const asked: string[] = [];
  const names = new RegExp(`(/api/emphasis/${viewId}\\b|[?&](target=view:|viewId=)${viewId}\\b)`);
  page.on("request", (request) => {
    const url = new URL(request.url());
    const read = decodeURIComponent(url.pathname + url.search);
    if (url.pathname.includes("/api/") && request.method() === "GET" && names.test(read)) asked.push(read);
  });
  return asked;
}

async function signIn(page: Page): Promise<{ origin: string; slug: string }> {
  const access = await project.issueAccess("shown view reads");
  await page.goto(access.url);
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { origin: new URL(project.url).origin, slug };
}

/** The route is up and the page has settled: what it reads on its own is in. */
async function settled(page: Page, shown: () => Promise<void>): Promise<void> {
  await shown();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_000);
}

const surfaces: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly shown: (page: Page) => Promise<void>;
}> = [
  {
    name: "project folders",
    path: "",
    shown: (page) => expect(page.getByRole("region", { name: "Project documents" })).toBeVisible(),
  },
  {
    name: "project diagrams",
    path: "?tab=diagrams",
    shown: (page) => expect(page.getByRole("button", { name: "Orders" }).first()).toBeVisible(),
  },
  {
    name: "project notes",
    path: "?tab=notes",
    shown: (page) => expect(page.getByRole("button", { name: "Payment page" }).first()).toBeVisible(),
  },
  {
    name: "another diagram",
    path: "diagrams/orders.mmd",
    shown: (page) => expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible(),
  },
  {
    name: "another diagram's folder path",
    path: ".archer/diagrams/orders.mmd",
    shown: (page) => expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible(),
  },
  {
    name: "another diagram's editor",
    path: "diagrams/orders.mmd?edit",
    shown: (page) => expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible(),
  },
  {
    name: "the new draft",
    path: "-/edit/",
    shown: (page) => expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible(),
  },
];

for (const surface of surfaces) {
  test(`${surface.name}: nothing is read for the view the agent presents`, async ({ page }) => {
    await project.present("checkout");
    const { origin, slug } = await signIn(page);
    const asked = readsFor(page, "checkout");
    await page.goto(`${origin}/projects/${slug}/${surface.path}`);
    await settled(page, () => surface.shown(page));
    expect(asked).toEqual([]);
  });
}

test("the new draft reads nothing for the diagram whose editor was open before", async ({ page }) => {
  const { origin, slug } = await signIn(page);
  await page.goto(`${origin}/projects/${slug}/diagrams/orders.mmd?edit`);
  await settled(page, () => expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible());
  const asked = readsFor(page, "orders");
  await page.goto(`${origin}/projects/${slug}/-/edit/`);
  await settled(page, () => expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible());
  expect(asked).toEqual([]);
});
