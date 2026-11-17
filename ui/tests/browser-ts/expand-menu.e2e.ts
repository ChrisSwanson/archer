// Expand from the person's side (ADR 0036 §11–§13, A8–A13), on the real service:
// the Comment / Expand menu in every route of the App Shell route matrix at desktop and phone widths, its
// keys, the grow path's stability and fallbacks, a comment on a frame part reaching its source, and a
// service without the capability drawing the base view with the direct composer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { elementMenuFiles as files, extremeMenuProject } from "../support/element-menu-fixtures";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const PAGE = testPage();
const MENU = /^Actions for /;

const slugOf = (server: TsProject): string =>
  new URL(server.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const at = (server: TsProject, path: string): string =>
  `${new URL(server.url).origin}/projects/${slugOf(server)}/${path}`;
const box = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
const menu = (page: Page): Locator => page.getByRole("menu", { name: MENU });
const details = (page: Page): Locator => page.getByRole("region", { name: "Details and Additions", exact: true });
async function openDetails(page: Page): Promise<Locator> {
  await menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(details(page)).toBeVisible();
  return details(page);
}
async function addSource(page: Page, title: string): Promise<void> {
  await openDetails(page);
  await details(page)
    .getByRole("button", { name: `Add to view: ${title}`, exact: true })
    .click();
}

async function openDiagram(page: Page, server: TsProject, file = ".archer/diagrams/context.mmd"): Promise<void> {
  await page.goto(server.url);
  await page.goto(at(server, file));
  await expect(box(page, "shop")).toBeVisible();
}

/** Pairwise order of box centres on screen: what "relative order kept" compares (A12). */
async function centres(page: Page, ids: readonly string[]): Promise<Map<string, { x: number; y: number }>> {
  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const b = (await box(page, id).boundingBox())!;
    out.set(id, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }
  return out;
}
function orderChanges(a: Map<string, { x: number; y: number }>, b: Map<string, { x: number; y: number }>): number {
  const ids = [...a.keys()];
  let changes = 0;
  for (const p of ids)
    for (const q of ids) {
      if (p >= q) continue;
      const [ap, aq, bp, bq] = [a.get(p)!, a.get(q)!, b.get(p)!, b.get(q)!];
      if (Math.sign(Math.round(ap.x - aq.x)) !== Math.sign(Math.round(bp.x - bq.x)) && Math.abs(ap.x - aq.x) > 2)
        changes++;
      if (Math.sign(Math.round(ap.y - aq.y)) !== Math.sign(Math.round(bp.y - bq.y)) && Math.abs(ap.y - aq.y) > 2)
        changes++;
    }
  return changes;
}
async function overlaps(page: Page): Promise<number> {
  return page.locator(".react-flow__node:not(.archer-group)").evaluateAll((els) => {
    const rects = els.map((e) => e.getBoundingClientRect());
    let n = 0;
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!,
          b = rects[j]!;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++;
      }
    return n;
  });
}

let server: TsProject;
test.beforeAll(async () => {
  server = await startTsProject({ pagePath: PAGE, files: files() });
});
test.afterAll(async () => {
  await server?.stop();
});

for (const [scope, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`the route matrix, ${scope}`, () => {
    test.use({ viewport, ...(scope === "phone" ? { hasTouch: true } : {}) });

    test("the menu is on a diagram's boxes, and on no route without a diagram", async ({ page }) => {
      await page.goto(server.url);
      // Overview, project, folder, note and read-only source: no diagram drawn by the page, so no element menu.
      for (const path of [null, "", ".archer/diagrams/", ".archer/notes/deploy.md", "README.md"]) {
        await page.goto(path === null ? `${new URL(server.url).origin}/projects/` : at(server, path));
        await page.locator("main, body").first().waitFor();
        await page.waitForLoadState("networkidle");
        const target =
          path === ".archer/notes/deploy.md" ? page.locator(".react-flow__node").first() : page.locator("main").first();
        if (await target.count()) await target.click({ button: "right", force: true });
        await expect(menu(page), `no element menu at ${path ?? "the overview"}`).toHaveCount(0);
      }
      // The diagram: Comment first, then the diagram that opens Shop.
      await page.goto(at(server, ".archer/diagrams/context.mmd"));
      await expect(box(page, "shop")).toBeVisible();
      await box(page, "shop").click({ button: "right" });
      await expect(menu(page)).toBeVisible();
      const items = menu(page).getByRole("menuitem");
      await expect(items.first()).toHaveText("Comment");
      await expect(items.first()).toBeFocused();
      await expect(menu(page).getByRole("group", { name: "Open Diagram" })).toContainText("Containers");
      if (scope === "phone") await expect(page.locator(".archer-expand-menu")).toHaveAttribute("data-sheet", "true");
      await page.screenshot({ path: test.info().outputPath(`menu-${scope}.png`) });
    });

    test("a reader's link (clean cookie) gets Expand too", async ({ page }) => {
      const reader = await server.issueAccess(`expand reader ${scope}`);
      await page.goto(reader.url);
      await page.goto(at(server, ".archer/diagrams/context.mmd"));
      await expect(box(page, "shop")).toBeVisible();
      await box(page, "shop").click({ button: "right" });
      await expect(menu(page).getByRole("menuitem", { name: /^Containers/ })).toBeVisible();
    });
  });
}

test("the embedded MCP page carries no element menu", () => {
  // The MCP App (McpApp.tsx) draws the canvas without the page's Expand: the menu's code is not in it.
  const mcp = readFileSync(resolve(PAGE, "../mcp/index.html"), "utf8");
  expect(mcp.includes("Added to This View")).toBe(false);
  expect(mcp.includes("Looking for diagrams of")).toBe(false);
});

test("Shift+F10 and the context-menu key open the menu at the selected box; Esc closes it and focus returns", async ({
  page,
}) => {
  await openDiagram(page, server);
  await box(page, "shop").click();
  const canvas = page.locator(".react-flow").first();
  for (const key of ["Shift+F10", "ContextMenu"]) {
    await canvas.focus();
    const before = await page.evaluate(() => {
      const el = document.activeElement;
      el?.setAttribute("data-had-focus", "");
      return el?.className ?? "";
    });
    await page.keyboard.press(key);
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
    // While the entries load, Comment is the only item and Down stays on it (O253): wait for them.
    await expect(menu(page)).not.toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("ArrowDown");
    await expect(menu(page).getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(page.locator("[data-had-focus]"), `focus back on ${before}`).toBeFocused();
    await page.evaluate(() => document.querySelector("[data-had-focus]")?.removeAttribute("data-had-focus"));
    // Esc on the menu did not clear the selection under it.
    await expect(box(page, "shop")).toHaveClass(/selected/);
  }
});

for (const key of ["Tab", "Shift+Tab"]) {
  test(`${key} leaves the element menu without restoring its invoking canvas`, async ({ page }) => {
    await openDiagram(page, server);
    await box(page, "shop").click();
    const canvas = box(page, "shop");
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press(key);
    await expect(menu(page)).toHaveCount(0);
    await expect(canvas).not.toBeFocused();
  });
}

test("Open navigates to the full source once, focuses its heading, and Back restores the base", async ({ page }) => {
  await openDiagram(page, server);
  const before = page.url();
  await box(page, "shop").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Containers", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Containers", exact: true })).toBeFocused();
  await expect(page.locator(".archer-expand-added")).toHaveCount(0);
  for (const id of ["api", "web", "db", "mail"]) await expect(box(page, id)).toBeVisible();
  // A C4 boundary is an element: its node id is the model id (xflow-adapter frameIdOf), not group:<id>.
  await expect(page.getByRole("button", { name: "Shop, system boundary", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(before);
  await page.goBack();
  await expect(page).toHaveURL(before);
  await expect(box(page, "shop")).toBeVisible();
  await expect(page.locator(".archer-expand-added")).toHaveCount(0);
});

test("the grow path: explicit Preview previews, Add adds the piece beside the element, order kept, no overlap, no fallback; × removes it", async ({
  page,
}) => {
  await openDiagram(page, server);
  const base = ["user", "shop", "pay"];
  const before = await centres(page, base);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("api/expand-menu")) requests.push(r.url());
  });
  await box(page, "shop").click({ button: "right" });
  await openDetails(page);
  await expect(details(page)).toContainText("+3 boxes");
  await details(page).getByRole("button", { name: "Preview: Containers", exact: true }).click();
  // The preview: the frame drawn faint, nothing added yet.
  await expect(page.locator('.react-flow__node[data-id="group:xf~containers"]')).toHaveCSS("opacity", "0.35");
  await expect(page.locator(".archer-expand-added")).toHaveCount(0);
  const add = details(page).getByRole("button", { name: "Add to view: Containers", exact: true });
  await add.focus();
  await expect(box(page, "group:xf~containers")).toHaveCSS("opacity", "0.35");
  await add.click();
  await expect(details(page)).toHaveCount(0);
  await expect(box(page, "xf~containers~/api")).toBeVisible();
  await expect(box(page, "xf~containers~/web")).toBeVisible();
  await expect(box(page, "group:xf~containers")).toHaveCSS("opacity", "1");
  const added = page.locator(".archer-expand-added");
  await expect(added).toContainText("1 of 5 diagrams · 3 of 60 boxes");
  await expect(added).toHaveAttribute("data-fallbacks", "0");
  // Every placement is counted, the preview's too (the add reuses it): one step, a grow.
  await expect(added).toHaveAttribute("data-step-ms", /^grow:\d+$/);
  // One read for the menu, none for the preview or the add.
  expect(requests).toHaveLength(1);
  expect(orderChanges(before, await centres(page, base))).toBe(0);
  await expect.poll(() => overlaps(page)).toBe(0);
  // Beside the element: the frame does not contain Shop.
  const frame = (await box(page, "group:xf~containers").boundingBox())!;
  const shop = (await box(page, "shop").boundingBox())!;
  expect(
    shop.x >= frame.x &&
      shop.x + shop.width <= frame.x + frame.width &&
      shop.y >= frame.y &&
      shop.y + shop.height <= frame.y + frame.height,
  ).toBe(false);
  await page.screenshot({ path: test.info().outputPath("grown.png") });

  // A second source, from inside the first frame: the proposed Deploy, labelled so.
  await box(page, "xf~containers~/api").click({ button: "right" });
  const deploy = menu(page).getByRole("menuitem", { name: /^Deploy/ });
  await expect(deploy).toContainText("Proposed");
  const mid = await centres(page, [...base, "xf~containers~/api", "xf~containers~/web"]);
  await addSource(page, "Deploy");
  await expect(box(page, "group:xf~notes/deploy.md#deploy")).toBeVisible();
  await expect(box(page, "group:xf~notes/deploy.md#deploy").locator(".archer-source-frame-proposed")).toHaveText(
    "Proposed",
  );
  expect(orderChanges(mid, await centres(page, [...base, "xf~containers~/api", "xf~containers~/web"]))).toBe(0);
  await expect.poll(() => overlaps(page)).toBe(0);
  await expect(added).toHaveAttribute("data-fallbacks", "0");

  // × on the first frame takes the second with it (it was added from inside it); the base comes back as it was.
  await box(page, "group:xf~containers")
    .getByRole("button", { name: /Remove Containers/ })
    .click();
  await expect(box(page, "group:xf~containers")).toHaveCount(0);
  await expect(box(page, "group:xf~notes/deploy.md#deploy")).toHaveCount(0);
  await expect(added).toHaveCount(0);
  expect(orderChanges(before, await centres(page, base))).toBe(0);
});

test("a frame part commented on reaches its source's model (A10)", async ({ page }) => {
  await openDiagram(page, server);
  await box(page, "shop").click({ button: "right" });
  await addSource(page, "Containers");
  await expect(box(page, "xf~containers~/db")).toBeVisible();
  await box(page, "xf~containers~/db").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Comment", exact: true }).click();
  const form = page.getByRole("form", { name: "New comment" });
  await form.getByRole("textbox", { name: "Comment", exact: true }).fill("Is the orders DB replicated?");
  await form.getByRole("button", { name: "Add comment", exact: true }).click();
  const threads = async (view: string) =>
    (
      (await (await server.fetch(`api/comments?target=view:${view}`)).json()) as {
        threads: { anchor: { kind: string; id?: string } }[];
      }
    ).threads;
  await expect
    .poll(async () => (await threads("containers")).map((t) => t.anchor))
    .toContainEqual(expect.objectContaining({ kind: "node", id: "db" }));
  expect((await threads("context")).some((t) => t.anchor.id === "db")).toBe(false);
  // C on the frame part the menu left selected does the same: the composer is about the source's element.
  await page.getByRole("button", { name: "Close discussion" }).click();
  await expect(form).toHaveCount(0);
  await expect(box(page, "xf~containers~/db")).toHaveClass(/selected/);
  await page.keyboard.press("c");
  await expect(form).toBeVisible();
  await expect(page.locator(".primary-floating-context")).toHaveText("Node: Orders DB");
  await page.screenshot({ path: test.info().outputPath("frame-comment.png") });
});

test.describe("a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("releasing a long press does not choose the sheet entry that opened under the finger", async ({ page }) => {
    await openDiagram(page, server);
    const before = page.url();
    const cdp = await page.context().newCDPSession(page);
    // Pan Shop low on the screen, so the sheet rises over it and the finger lifts on one of its rows.
    const start = (await box(page, "shop").boundingBox())!;
    const lift = { x: Math.round(start.x + start.width / 2), y: Math.round(start.y + start.height + 20) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [lift] });
    for (let dy = 30; dy <= 345; dy += 15)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: lift.x, y: lift.y + dy }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(menu(page)).toHaveCount(0);
    const b = (await box(page, "shop").boundingBox())!;
    const point = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await expect(menu(page)).toBeVisible({ timeout: 3000 });
    const under = await page.evaluate(({ x, y }) => {
      // Watch the lift land: what follows the touch end (a click, if any) is handled before the next frames.
      window.addEventListener("touchend", () => Object.assign(window, { lifted: true }), { capture: true, once: true });
      return Boolean(document.elementFromPoint(x, y)?.closest('[role="menuitem"]'));
    }, point);
    expect(under, "the sheet must cover the press point for this case to mean anything").toBe(true);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => "lifted" in window)).toBe(true);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect(menu(page)).toHaveCount(1);
    expect(page.url()).toBe(before);
    await expect(details(page)).toHaveCount(0);
  });
  test("a long press opens the menu; explicit Preview and Add are separate touch targets", async ({ page }) => {
    await openDiagram(page, server);
    const b = (await box(page, "shop").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const point = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await expect(menu(page)).toBeVisible({ timeout: 3000 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(menu(page)).toHaveCount(1);
    await menu(page).getByRole("menuitem", { name: "Details and additions…" }).tap();
    const preview = details(page).getByRole("button", { name: "Preview: Containers", exact: true });
    const add = details(page).getByRole("button", { name: "Add to view: Containers", exact: true });
    for (const control of [preview, add]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await preview.tap();
    await expect(page.locator(".archer-expand-choice[data-previewing]")).toHaveCount(1);
    await expect(page.locator(".archer-expand-added")).toHaveCount(0);
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await add.tap();
    await expect(box(page, "group:xf~containers")).toBeAttached();
    await page.screenshot({ path: test.info().outputPath("grown-phone.png") });
  });
});

test.describe("at the limit", () => {
  let big: TsProject;
  test.beforeAll(async () => {
    big = await startTsProject({ pagePath: PAGE, files: files(6) });
  });
  test.afterAll(async () => {
    await big?.stop();
  });

  test("five sources fill the canvas; a sixth is offered but refused, with why (A13)", async ({ page }) => {
    // The lab at the limit: each add's time from the press to its frame on screen, the worker's own time, the
    // main thread's long tasks while adding, and what each menu read carried.
    await page.addInitScript(() => {
      (window as unknown as { __long: number[] }).__long = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          (window as unknown as { __long: number[] }).__long.push(Math.round(e.duration));
      }).observe({ type: "longtask", buffered: true });
    });
    const reads: { bytes: number; transfer: number }[] = [];
    page.on("requestfinished", async (r) => {
      if (!r.url().includes("api/expand-menu")) return;
      const response = await r.response();
      reads.push({ bytes: (await response?.body())?.length ?? 0, transfer: (await r.sizes()).responseBodySize });
    });
    await openDiagram(page, big);
    await page.evaluate(() => {
      (window as unknown as { __long: number[] }).__long.length = 0;
    });
    const adds: number[] = [];
    for (let i = 1; i <= 5; i++) {
      await box(page, "shop").click({ button: "right" });
      await openDetails(page);
      const entry = details(page).getByRole("button", { name: `Add to view: Part ${i}`, exact: true });
      await expect(entry).toBeEnabled();
      const t0 = await page.evaluate(() => performance.now());
      await entry.click();
      await expect(box(page, `group:xf~part${i}`)).toBeAttached();
      adds.push(Math.round((await page.evaluate(() => performance.now())) - t0));
    }
    const added = page.locator(".archer-expand-added");
    await expect(added).toContainText("5 of 5 diagrams · 55 of 60 boxes");
    await box(page, "shop").click({ button: "right" });
    await expect(menu(page).getByRole("menuitem", { name: "Part 6", exact: true })).toBeEnabled();
    await openDetails(page);
    const sixth = details(page).getByRole("button", { name: "Add to view: Part 6", exact: true });
    await expect(sixth).toBeDisabled();
    await expect(sixth.locator("../..")).toContainText("5 diagrams added already");
    await expect(details(page).getByRole("button", { name: "Open full diagram: Part 6", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect.poll(() => overlaps(page)).toBe(0);
    const lab = {
      addsMs: adds,
      workerSteps: await added.getAttribute("data-step-ms"),
      fallbacks: Number(await added.getAttribute("data-fallbacks")),
      longTasksMs: await page.evaluate(() => (window as unknown as { __long: number[] }).__long),
      menuReads: reads,
      boxesOnCanvas: await page.locator(".react-flow__node:not(.archer-group)").count(),
    };
    test.info().annotations.push({ type: "lab", description: JSON.stringify(lab) });
    await test
      .info()
      .attach("expand-limit-lab.json", { body: JSON.stringify(lab, null, 1), contentType: "application/json" });
    expect(lab.fallbacks).toBe(0);
    expect(lab.workerSteps?.split(" ")).toHaveLength(5);
    // One read per menu opened: five adds and the refused sixth.
    expect(reads).toHaveLength(6);
    for (const r of reads) expect(r.bytes).toBeLessThanOrEqual(65536);
    await page.screenshot({ path: test.info().outputPath("at-limit.png") });
  });
});

test.describe("the modes (O8)", () => {
  let shown: TsProject;
  test.beforeAll(async () => {
    shown = await startTsProject({ pagePath: PAGE, files: files() });
  });
  test.afterAll(async () => {
    await shown?.stop();
  });

  test("Expand in Highlights; choosing it moves to Explore", async ({ page }) => {
    await shown.setEmphasis("context", [
      { id: "money", groups: [{ id: "g", label: "Money", style: "highlight", nodes: ["shop", "pay"], edges: [] }] },
    ]);
    await openDiagram(page, shown);
    const panel = page.locator(".archer-diagram-panel").first();
    await expect(panel).toHaveAttribute("data-mode", "highlights");
    await box(page, "shop").click({ button: "right" });
    await addSource(page, "Containers");
    await expect(box(page, "group:xf~containers")).toBeAttached();
    await expect(panel).toHaveAttribute("data-mode", "explore");
  });
});

test.describe("one-action navigation and details dismissal", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("one tap on a title opens its full source and Back returns; touch cancel adds nothing", async ({ page }) => {
    await openDiagram(page, server);
    const before = page.url();
    await box(page, "shop").click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "Containers", exact: true }).tap();
    await expect(page.getByRole("heading", { level: 1, name: "Containers", exact: true })).toBeFocused();
    await expect(page.locator(".archer-expand-added")).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(before);
    const bounds = (await box(page, "shop").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(menu(page)).toHaveCount(0);
    await expect(page.locator(".archer-expand-added")).toHaveCount(0);
  });
  test("folding the details sheet clears its explicit preview and restores mode content", async ({ page }) => {
    await openDiagram(page, server);
    await box(page, "shop").click({ button: "right" });
    await openDetails(page);
    const key = page.getByRole("region", { name: "Diagram Key", exact: true });
    await expect(key).toBeVisible();
    await details(page).getByRole("button", { name: "Preview: Containers", exact: true }).tap();
    await expect(box(page, "group:xf~containers")).toBeAttached();
    await page.getByRole("button", { name: "Details and Additions", exact: true }).tap();
    await expect(details(page)).toHaveCount(0);
    await expect(box(page, "group:xf~containers")).toHaveCount(0);
    await expect(page.locator(".archer-expand-added")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Diagram Key", exact: true })).toBeVisible();
  });
});

test.describe("long, duplicate and Unicode destinations", () => {
  let extreme: TsProject;
  const { files: extremeFiles, longTitle } = extremeMenuProject();
  test.beforeAll(async () => {
    extreme = await startTsProject({ pagePath: PAGE, files: extremeFiles });
  });
  test.afterAll(async () => {
    await extreme?.stop();
  });
  for (const width of [320, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`${width}px, ${theme}, 200% text: wrapped navigation, scroll focus, descriptions without hover and axe`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await openDiagram(page, extreme);
        await page.evaluate((chosen) => {
          localStorage.setItem("archer.theme", chosen);
          document.documentElement.setAttribute("data-theme", chosen);
          document.documentElement.style.fontSize = "200%";
          const spacing = document.createElement("style");
          spacing.textContent = "* { line-height: 1.5 !important; word-spacing: .16em !important; }";
          document.head.append(spacing);
        }, theme);
        await box(page, "shop").click({ button: "right" });
        const destinations = menu(page).getByRole("group", { name: "Open Diagram" }).getByRole("menuitem");
        await expect(destinations).toHaveCount(12);
        await expect(menu(page).getByText(/more not listed/)).toBeVisible();
        const long = menu(page).getByRole("menuitem", { name: longTitle, exact: true });
        await expect(long).toContainText("Distinct Ending");
        await expect(long).toHaveAttribute("aria-describedby", /source/);
        await expect(long).toContainText("A detailed description of the order processing source.");
        await expect(menu(page).getByRole("menuitem", { name: "Shared Title", exact: true })).toHaveCount(2);
        // The cue is the inventory's canonical path, which (like the breadcrumb) is relative to .archer/.
        for (const cue of ["diagrams/part2.mmd", "diagrams/part3.mmd"])
          await expect(menu(page).getByText(cue, { exact: true })).toBeVisible();
        await page.keyboard.press("End");
        const action = menu(page).getByRole("menuitem", { name: "Details and additions…", exact: true });
        await expect(action).toBeFocused();
        const actionBox = (await action.boundingBox())!;
        const menuBox = (await page.locator(".archer-expand-menu").boundingBox())!;
        expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height + 1);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const { default: AxeBuilder } = await import("@axe-core/playwright");
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await action.click();
        await expect(details(page)).toContainText("More about its runtime.");
        await expect(details(page)).toBeVisible();
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`details-${width}-${theme}.png`) });
        await details(page)
          .getByRole("button", { name: /^Open full diagram: Neighbour / })
          .first()
          .click();
        await expect(page.getByRole("heading", { level: 1, name: "Neighbours", exact: true })).toBeFocused();
        await expect(page.locator(".archer-expand-added")).toHaveCount(0);
      });
    }
});

test("narrow desktop details retain the Key, expose their buttons, and exclude covered chrome from Tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openDiagram(page, server);
  const canvas = box(page, "shop");
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await box(page, "shop").click({ button: "right" });
  await openDetails(page);
  const panel = page.locator(".archer-diagram-panel[data-overlay]");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("region", { name: "Diagram Key" })).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Add to view: Containers", exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      panel.evaluate((surface) => {
        const cover = surface.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>("button, select, [tabindex='0']")].filter((control) => {
          if (surface.contains(control) || control.closest(".react-flow__renderer")) return false;
          const r = control.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.x + r.width / 2 > cover.left &&
            r.x + r.width / 2 < cover.right &&
            r.y + r.height / 2 > cover.top &&
            r.y + r.height / 2 < cover.bottom &&
            !control.closest("[inert]")
          );
        }).length;
      }),
    )
    .toBe(0);
  await details(page).getByRole("button", { name: "Close Details and Additions", exact: true }).click();
  await expect(details(page)).toHaveCount(0);
  await expect(canvas).toBeFocused();
});

test("Project Review yields the diagram panel to Details, and opening Review clears an explicit preview", async ({
  page,
}) => {
  await openDiagram(page, server);
  const notifications = page.getByRole("button", { name: /^Notifications/ });
  await notifications.click();
  await expect(page.getByRole("region", { name: "Project Review", exact: true })).toBeVisible();
  await box(page, "shop").click({ button: "right" });
  await openDetails(page);
  await expect(page.getByRole("region", { name: "Project Review", exact: true })).toBeHidden();
  await details(page).getByRole("button", { name: "Preview: Containers", exact: true }).click();
  await expect(box(page, "group:xf~containers")).toBeAttached();
  await notifications.click();
  await expect(page.getByRole("region", { name: "Project Review", exact: true })).toBeVisible();
  await expect(details(page)).toHaveCount(0);
  await expect(box(page, "group:xf~containers")).toHaveCount(0);
});
