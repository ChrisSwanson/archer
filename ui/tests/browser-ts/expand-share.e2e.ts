// An exploration shared with the agent (ADR 0036 §14, A8, A10, A11, O1, O10), on the real
// service: the agent presents an exploration and the page draws it, the person adds one and the agent reads it back;
// a source edited and a source removed under it; the exploration across a restart; a copied `?expand=` link that
// reopens the same picture; a present without `expand` unchanged; the stamp in the bootstrap; Edit draws the base.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const PAGE = testPage();
const MENU = /^Actions for /;

const CONTEXT = `C4Context
title Context
Person(user, "Shopper")
System(shop, "Shop")
System_Ext(pay, "Payments")
Rel(user, shop, "buys from")
Rel(shop, pay, "charges")
`;
const CONTAINERS = `C4Container
title Containers
Person(user, "Shopper")
System_Boundary(shop, "Shop") {
  Container(web, "Web", "React")
  Container(api, "API", "Node")
  ContainerDb(db, "Orders DB", "Postgres")
}
Rel(user, web, "uses")
Rel(web, api, "calls")
Rel(api, db, "reads")
`;
const BILLING = `C4Container
title Billing
System_Boundary(pay, "Payments") {
  Container(ledger, "Ledger", "Go")
  Container(cards, "Cards", "Go")
}
Rel(ledger, cards, "settles")
`;
// A star (codex-12-01): the hub draws a; star draws a→b and a→c, so b and c are each a neighbour not drawn here.
const HUB = "flowchart LR\n  a[Alpha]:::container\n";
const STAR =
  "flowchart LR\n  a[Alpha]:::container\n  b[Bravo]:::container\n  c[Charlie]:::container\n  a ab@--> b\n  a ac@--> c\n";
// A fan (codex-12-03): 25 neighbours with long ids, so 24 neighbour entries are more than one link holds.
const LEAVES = Array.from({ length: 25 }, (_, i) => `leaf_${String(i).padStart(2, "0")}_`.padEnd(110, "x"));
const FAN = "flowchart LR\n  root[Root]:::container\n";
const FANOUT = `flowchart LR\n  root[Root]:::container\n${LEAVES.map((id, i) => `  ${id}[Leaf ${i}]:::container\n`).join("")}${LEAVES.map((id, i) => `  root w${i}@--> ${id}\n`).join("")}`;
// A heavy source (codex-12-04): 40 boxes and 120 parallel wires, every label 500 characters: within the box, wire and
// label limits, but more than one 64 KiB answer carries.
const PLAIN = "flowchart LR\n  p0[Plain]:::container\n";
const HEAVY = `flowchart LR\n  p0[Plain]:::container\n${Array.from({ length: 40 }, (_, i) => `  h${i}["${"X".repeat(500)}"]:::container\n`).join("")}${Array.from({ length: 120 }, (_, i) => `  p0 e${i}@-->|"${"Y".repeat(500)}"| h${i % 40}\n`).join("")}`;
const FLOWCHARTS = new Set(["hub", "star", "fan", "fanout", "plain", "heavy"]);
const view = (id: string, title: string): string =>
  `[[views]]\nid = "${id}"\nkind = "${FLOWCHARTS.has(id) ? "flowchart" : "c4"}"\ntitle = "${title}"\nsource = ".archer/diagrams/${id}.mmd"\n`;
const TOML = (ids: readonly [string, string][]): string =>
  `version = 1\nname = "Shop"\n\n${ids.map(([id, title]) => view(id, title)).join("\n")}`;
const ALL: [string, string][] = [
  ["context", "Context"],
  ["containers", "Containers"],
  ["billing", "Billing"],
  ["hub", "Hub"],
  ["star", "Star"],
  ["fan", "Fan"],
  ["fanout", "Fanout"],
  ["plain", "Plain"],
  ["heavy", "Heavy"],
];
const files = (): Record<string, string> => ({
  "archer.toml": TOML(ALL),
  ".archer/diagrams/context.mmd": CONTEXT,
  ".archer/diagrams/containers.mmd": CONTAINERS,
  ".archer/diagrams/billing.mmd": BILLING,
  ".archer/diagrams/hub.mmd": HUB,
  ".archer/diagrams/star.mmd": STAR,
  ".archer/diagrams/fan.mmd": FAN,
  ".archer/diagrams/fanout.mmd": FANOUT,
  ".archer/diagrams/plain.mmd": PLAIN,
  ".archer/diagrams/heavy.mmd": HEAVY,
});

const slugOf = (server: TsProject): string =>
  new URL(server.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const at = (server: TsProject, path: string): string =>
  `${new URL(server.url).origin}/projects/${slugOf(server)}/${path}`;
const box = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
const menu = (page: Page): Locator => page.getByRole("menu", { name: MENU });
const added = (page: Page): Locator => page.locator(".archer-expand-added");

type Context = {
  exploration?: {
    origin: string;
    viewId: string;
    expand: { element: string; source: string }[];
    frames: { source: string }[];
    selection: { source: string; kind: string; id: string; label?: string }[];
  } | null;
};
const context = async (server: TsProject): Promise<Context> => (await server.call("getContext")) as Context;
const presentExpand = (
  server: TsProject,
  viewId: string,
  expand: { element: string; source: string }[],
  annotation?: string,
) => server.call("present", { viewId, expand, ...(annotation === undefined ? {} : { annotation }) });

async function openContext(page: Page, server: TsProject): Promise<void> {
  await page.goto(server.url);
  await page.goto(at(server, ".archer/diagrams/context.mmd"));
  await expect(box(page, "shop")).toBeVisible();
}

let server: TsProject;
test.beforeEach(async () => {
  server = await startTsProject({ pagePath: PAGE, files: files() });
});
test.afterEach(async () => {
  await server?.stop();
});

test("the agent presents an exploration and the page draws it; the person adds one and the agent reads it back", async ({
  page,
}) => {
  await openContext(page, server);
  const reads: string[] = [];
  page.on("request", (r) => {
    if (/api\/(exploration|reader-exploration)/.test(r.url()))
      reads.push(
        `${r.method()} ${new URL(r.url()).pathname.split("/api/")[1]}${new URL(r.url()).searchParams.has("presentationId") ? "?presentationId" : ""}`,
      );
  });
  await presentExpand(server, "context", [{ element: "shop", source: "containers" }]);
  await expect(box(page, "xf~containers~/api")).toBeVisible();
  await expect(added(page)).toHaveAttribute("data-origin", "presented");
  await expect(added(page)).toContainText("Added by the agent");
  // One read for every frame; adopting the agent's exploration reports nothing back.
  expect(reads).toEqual(["GET exploration?presentationId"]);
  expect((await context(server)).exploration?.origin).toBe("presentation");

  // The person adds Billing from Payments: the page reports it, and the agent reads both additions back.
  await box(page, "pay").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  await page.getByRole("button", { name: "Add to view: Billing", exact: true }).click();
  await expect(box(page, "xf~billing~/ledger")).toBeVisible();
  await expect.poll(async () => (await context(server)).exploration?.origin).toBe("reader");
  const read = (await context(server)).exploration!;
  expect(read.expand).toEqual([
    { element: "shop", source: "containers" },
    { element: "pay", source: "billing" },
  ]);
  expect(read.frames.map((f) => f.source)).toEqual(["containers", "billing"]);
  // A frame part selected reaches the agent as (source, id), named by its source's model (A10).
  // (The canvas pans by default; the menu selects what it was opened on, and Escape keeps that selection.)
  await box(page, "xf~billing~/ledger").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box(page, "xf~billing~/ledger")).toHaveClass(/selected/);
  await expect
    .poll(async () => (await context(server)).exploration?.selection)
    .toEqual([{ source: "billing", kind: "node", id: "ledger", label: "Ledger" }]);
  expect(reads.filter((r) => r.startsWith("POST")).length).toBeLessThanOrEqual(2);
  await page.screenshot({ path: test.info().outputPath("shared.png") });

  // The agent presents again without expand: the bare view takes the page (A11).
  await server.present("context");
  await expect(page.locator('[data-id^="group:xf~"]')).toHaveCount(0);
});

test("a source edited and a source removed under a presented exploration", async ({ page }) => {
  await openContext(page, server);
  await presentExpand(server, "context", [
    { element: "shop", source: "containers" },
    { element: "pay", source: "billing" },
  ]);
  await expect(box(page, "xf~containers~/db")).toBeVisible();
  await expect(box(page, "xf~billing~/cards")).toBeVisible();
  // Edited: the frame is refreshed from the new revision.
  await server.agentWrite(
    "containers",
    ".archer/diagrams/containers.mmd",
    CONTAINERS.replace(
      '  ContainerDb(db, "Orders DB", "Postgres")\n',
      '  ContainerDb(db, "Orders DB", "Postgres")\n  Container(cache, "Cache", "Redis")\n',
    ),
    "add a cache",
  );
  await expect(box(page, "xf~containers~/cache")).toBeVisible();
  // Removed: its frame is gone, with a line saying so; the other stays.
  // (A file in the Archer folder is a view even unlisted, so the source leaves when its file does.)
  const { rmSync, writeFileSync } = await import("node:fs");
  writeFileSync(`${server.root}/archer.toml`, TOML(ALL.filter(([id]) => id !== "containers")));
  rmSync(`${server.root}/.archer/diagrams/containers.mmd`);
  await expect(box(page, "group:xf~containers")).toHaveCount(0);
  await expect(box(page, "xf~billing~/cards")).toBeVisible();
  await expect(added(page)).toContainText("containers was removed, so its frame is gone");
});

test("the exploration across a service restart", async ({ page }) => {
  await presentExpand(server, "context", [{ element: "shop", source: "containers" }]);
  await server.restart();
  await page.goto(server.url);
  await expect(box(page, "xf~containers~/api")).toBeVisible();
  await expect(added(page)).toHaveAttribute("data-origin", "presented");
});

test("a copied link reopens the same picture; a reload drops the page's own additions", async ({
  page,
  context: browser,
}) => {
  await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
  await openContext(page, server);
  await box(page, "shop").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  await page.getByRole("button", { name: "Add to view: Containers", exact: true }).click();
  // The next right-click waits for this add to be drawn: aimed at the old layout, it landed on the Containers frame
  // the add grew under the pointer, and no menu opened (O264).
  await expect(box(page, "xf~containers~/api")).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await box(page, "pay").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  await page.getByRole("button", { name: "Add to view: Billing", exact: true }).click();
  await expect(box(page, "xf~billing~/ledger")).toBeVisible();
  const url = page.url();
  await added(page).getByRole("button", { name: "Copy link" }).click();
  await expect(added(page)).toContainText("Copied");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).searchParams.get("expand")).toMatch(/^[A-Za-z0-9_-]+$/);
  // The graph never writes the address.
  expect(page.url()).toBe(url);
  // A reload keeps nothing of the page's own (O10).
  await page.reload();
  await expect(box(page, "shop")).toBeVisible();
  await expect(page.locator('[data-id^="group:xf~"]')).toHaveCount(0);
  // The link opens the same frames.
  const other = await browser.newPage();
  await other.goto(link);
  await expect(box(other, "xf~containers~/api")).toBeVisible();
  await expect(box(other, "xf~billing~/ledger")).toBeVisible();
  await expect(other.locator(".archer-expand-added")).toHaveAttribute("data-origin", "link");
  expect(new URL(other.url()).searchParams.get("expand")).toBe(new URL(link).searchParams.get("expand"));
});

// codex-12-01 (O254): the link and the agent's report carry the one neighbour each click added, not the whole source.
test("two neighbours added one at a time: the agent and a copied link see exactly what the person added", async ({
  page,
  context: browser,
}) => {
  await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
  await page.goto(server.url);
  await page.goto(at(server, ".archer/diagrams/hub.mmd"));
  await expect(box(page, "a")).toBeVisible();
  const neighbour = (id: "b" | "c"): Locator =>
    page.getByRole("button", { name: `Add to view: ${id === "b" ? "Bravo" : "Charlie"} · star`, exact: true });
  const copy = async (): Promise<string> => {
    await added(page).getByRole("button", { name: "Copy link" }).click();
    await expect(added(page)).toContainText("Copied");
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const opened = async (link: string): Promise<Page> => {
    const other = await browser.newPage();
    await other.goto(link);
    await expect(box(other, "xf~star~/b")).toBeVisible();
    return other;
  };

  await box(page, "a").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  await neighbour("b").click();
  await expect(box(page, "xf~star~/b")).toBeVisible();
  await expect(box(page, "xf~star~/c")).toHaveCount(0);
  await expect
    .poll(async () => (await context(server)).exploration?.expand)
    .toEqual([{ element: "a", source: "star", neighbour: "b" }]);
  const one = await opened(await copy());
  await expect(box(one, "xf~star~/c")).toHaveCount(0);
  await one.close();

  // The second neighbour is still offered, and adds only itself.
  await box(page, "a").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  await neighbour("c").click();
  await expect(box(page, "xf~star~/c")).toBeVisible();
  await expect
    .poll(async () => (await context(server)).exploration?.expand)
    .toEqual([
      { element: "a", source: "star", neighbour: "b" },
      { element: "a", source: "star", neighbour: "c" },
    ]);
  const both = await opened(await copy());
  await expect(box(both, "xf~star~/c")).toBeVisible();
  await expect(both.locator(".archer-expand-added")).toHaveAttribute("data-origin", "link");
});

// codex-12-03 (O255): an agent's exploration past what one link holds is drawn, but never copied as a link the reader refuses.
test("an exploration more than a link holds: drawn; Copy link copies the view alone and says so; nothing more is offered", async ({
  page,
  context: browser,
}) => {
  await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
  await page.goto(server.url);
  await page.goto(at(server, ".archer/diagrams/fan.mmd"));
  await expect(box(page, "root")).toBeVisible();
  const reads: string[] = [];
  page.on("response", (r) => {
    if (/api\/expand-menu/.test(r.url())) reads.push(String(r.status()));
  });
  await presentExpand(
    server,
    "fan",
    LEAVES.slice(0, 24).map((id) => ({ element: "root", source: "fanout", neighbour: id })),
  );
  await expect(box(page, `xf~fanout~/${LEAVES[23]}`)).toBeVisible();
  await added(page).getByRole("button", { name: "Copy link" }).click();
  await expect(added(page)).toContainText("Copied a link to this view without its additions");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).searchParams.has("expand")).toBe(false);
  await box(page, "root").click({ button: "right" });
  await expect(menu(page)).toContainText("Nothing more can be added here");
  await expect(menu(page).locator('[data-entry^="n"]')).toHaveCount(0);
  expect(reads).toEqual([]);
});

// codex-12-04 (O256): what one 64 KiB answer cannot carry is refused alike by the menu, a present and a link.
test("a source larger than one answer carries: offered but refused with why; a present refuses it; a link drops it", async ({
  page,
}) => {
  await page.goto(server.url);
  await page.goto(at(server, ".archer/diagrams/plain.mmd"));
  await expect(box(page, "p0")).toBeVisible();
  const sizes: number[] = [];
  page.on("response", async (r) => {
    if (/api\/(expand-menu|exploration)/.test(r.url())) sizes.push((await r.body()).length);
  });
  await box(page, "p0").click({ button: "right" });
  // The service titles these flowchart sources by id (the page heading reads "plain"), as the case did before.
  await expect(menu(page).getByRole("menuitem", { name: "heavy", exact: true })).toBeEnabled();
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  const heavy = page.getByRole("button", { name: "Add to view: heavy", exact: true });
  await expect(heavy).toBeDisabled();
  await expect(heavy.locator("../..")).toContainText("too much to draw in one view");
  const open = page.getByRole("button", { name: "Open full diagram: heavy", exact: true });
  await expect(open).toBeEnabled();
  // The refused Add looks refused: not the enabled action's ink or fill, and pointing at it changes nothing.
  const look = (button: Locator) =>
    button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, border: s.borderTopColor, cursor: s.cursor };
    });
  const enabled = await look(open);
  const refused = await look(heavy);
  expect(refused.color).not.toBe(enabled.color);
  expect(refused.background).not.toBe(enabled.background);
  expect(refused.cursor).toBe("default");
  await heavy.hover({ force: true });
  expect(await look(heavy)).toEqual(refused);
  await page.keyboard.press("Escape");
  await expect(presentExpand(server, "plain", [{ element: "p0", source: "heavy" }])).rejects.toMatchObject({
    error: { code: "invalid_expand" },
  });
  // The page's own context, signed in: the link's read as the browser makes it.
  const link = await page.request.get(
    server.api(
      `api/exploration?viewId=plain&expand=${Buffer.from(JSON.stringify([["p0", "heavy"]])).toString("base64url")}`,
    ),
  );
  const body = await link.body();
  expect(body.length).toBeLessThanOrEqual(65536);
  expect(
    (JSON.parse(body.toString()) as { expansions: { items: { status: string; reason?: string }[] } }).expansions.items,
  ).toEqual([expect.objectContaining({ status: "dropped", reason: "limit_passed" })]);
  for (const size of sizes) expect(size).toBeLessThanOrEqual(65536);
});

test("present without expand is unchanged; with expand the bootstrap carries the stamp and the caption as written", async ({
  page,
}) => {
  await server.present("context", "The shop");
  const bootstrap = () =>
    page.request
      .get(server.api("api/bootstrap"))
      .then((r) => r.json() as Promise<{ presentation: { annotation?: string; exploration?: unknown } }>);
  await page.goto(server.url);
  const bare = await bootstrap();
  expect(bare.presentation.annotation).toBe("The shop");
  expect("exploration" in bare.presentation).toBe(false);
  await expect(page.locator(".archer-expand-added")).toHaveCount(0);

  await presentExpand(server, "context", [{ element: "shop", source: "containers" }], "The shop");
  const expanded = await bootstrap();
  expect(expanded.presentation.annotation).toBe("The shop");
  expect(expanded.presentation.exploration).toEqual({ generation: expect.any(Number), sources: 1, parts: 3 });
});

test("Edit draws the base view, and Explore draws the frames again", async ({ page }) => {
  await page.goto((await server.issueAuthoringAccess("share edit")).url);
  await page.goto(at(server, ".archer/diagrams/context.mmd"));
  await expect(box(page, "shop")).toBeVisible();
  await presentExpand(server, "context", [{ element: "shop", source: "containers" }]);
  await expect(box(page, "xf~containers~/api")).toBeVisible();
  await page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id^="xf~"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toHaveCount(0);
  await expect(box(page, "xf~containers~/api")).toBeVisible();
});
