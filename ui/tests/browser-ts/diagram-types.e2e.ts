/**
 * The four diagram types beyond flowchart and sequence, in a real browser
 * against the TypeScript service: each golden source in `ts/test/fixtures`
 * presented as the agent presents it, drawn, selected and read back through
 * the service as the agent reads it, emphasised by the agent, commented on,
 * walked by keyboard, at phone width, and checked by axe in both designs and
 * both schemes.
 *
 * What jsdom cannot see is what is asserted here: where things are drawn
 * relative to each other, what a pointer press lands on, and where focus goes.
 */
import AxeBuilder from "@axe-core/playwright";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = testPage();
const FIXTURES = resolve(HERE, "../../../ts/test/fixtures");

/** A project with one view of `kind`, whose source is the golden fixture of `type`. */
function projectFiles(type: string, kind: string): Record<string, string> {
  return {
    "archer.toml": `version = 1\n\n[[views]]\nid = "drawing"\nkind = "${kind}"\ntitle = "The ${type} drawing"\nsource = ".archer/drawing.mmd"\n`,
    ".archer/drawing.mmd": readFileSync(resolve(FIXTURES, type, "widened.mmd"), "utf8"),
  };
}

let project: TsProject | undefined;
let problems: string[];

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  await page.close();
  await project?.stop();
  project = undefined;
  expect(problems, "the page logged errors or warnings").toEqual([]);
});

type Options = { scheme?: "light" | "dark"; design?: "current"; width?: number };

/** Starts the service on the fixture, has the agent present the view and opens the page. */
async function open(
  page: Page,
  type: string,
  kind: string,
  drawn: (page: Page) => Promise<void>,
  options: Options = {},
): Promise<TsProject> {
  project = await sharedTsProject({ files: projectFiles(type, kind) });
  await page.emulateMedia({ colorScheme: options.scheme ?? "light" });
  if (options.width !== undefined) await page.setViewportSize({ width: options.width, height: 800 });
  // Present before the page loads: present reloads the project, and on a loaded CI host that
  // reload (a cold compile) has held the service past the page's 10 s read deadline while the
  // page negotiated its event stream, which then logged a stream failure. The page still opens
  // on the presented view, as when the agent presents before the reader looks.
  await project.present("drawing");
  await page.goto(project.url);
  await drawn(page);
  return project;
}

const panel = (page: Page) => page.getByRole("region", { name: "Contextual discussion", exact: true });
const node = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
const selectMode = (page: Page) => page.getByRole("button", { name: "Select mode", exact: true }).click();

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(" ")}`));
}

/** The box of an element, which must be drawn. */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  expect(found, "the element is drawn").not.toBeNull();
  return found!;
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Selected node ids as the service holds them: what `get_selection` would tell the agent. */
async function selectedNodes(server: TsProject): Promise<string[]> {
  const selection = await server.selection();
  return (selection?.nodes ?? []).map((n) => n.id).sort();
}

/** Comment on an element through its context menu; returns once the thread is in the panel. */
async function commentOn(page: Page, element: Locator, words: string, anchor: RegExp): Promise<void> {
  await element.click({ button: "right" });
  // A graph box's menu (A9): Comment first.
  if (await element.evaluate((e) => e.matches(".react-flow__node"))) await chooseComment(page);
  const composer = panel(page).getByRole("textbox", { name: "Comment" });
  await expect(composer).toBeFocused();
  await composer.fill(words);
  await panel(page).getByRole("button", { name: "Add comment" }).click();
  await expect(panel(page).getByRole("article", { name: anchor })).toBeVisible();
  await expect(panel(page).getByText(words, { exact: true })).toBeVisible();
}

/** Clicks a point a third of the way along an edge's drawn route. */
async function clickEdge(page: Page, id: string, additive = false): Promise<void> {
  const point = await page
    .locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-interaction`)
    .evaluate((path) => {
      const route = path as SVGPathElement;
      const at = route.getPointAtLength(route.getTotalLength() / 3);
      const matrix = route.getScreenCTM()!;
      return { x: at.x * matrix.a + matrix.e, y: at.y * matrix.d + matrix.f };
    });
  if (additive) await page.keyboard.down("Shift");
  await page.mouse.click(point.x, point.y);
  if (additive) await page.keyboard.up("Shift");
}

/** No sideways scroll on the page itself. */
async function noPageScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

// ---------------------------------------------------------------- state

const STATES = 13; // leaf states; `Working` is a composite, drawn as a frame
const stateDrawn = async (page: Page): Promise<void> => {
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(STATES);
  await expect(page.locator(".react-flow__edge")).toHaveCount(15);
};

test.describe("state diagram", () => {
  test("draws states as UML does, and a note beside its state", async ({ page }) => {
    await open(page, "state", "state", stateDrawn);
    const start = await box(node(page, "root_start"));
    const idle = await box(node(page, "Idle"));
    // The pseudo-states are small marks, not boxes.
    expect(start.width).toBeLessThan(40);
    expect(Math.abs(start.width - start.height)).toBeLessThanOrEqual(1);
    const radius = await node(page, "root_start").evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(radius).toBe("50%");
    // A fork bar stands across a graph that flows to the right.
    const fork = await box(node(page, "Split"));
    expect(fork.height).toBeGreaterThan(fork.width * 4);
    // The note is to the right of its state, and on nothing else.
    const note = await box(node(page, "Idle").locator(".archer-state-note"));
    expect(note.x).toBeGreaterThanOrEqual(idle.x + idle.width);
    for (const id of [
      "Checking",
      "Route",
      "Split",
      "Merge",
      "Report",
      "Notify",
      "root_start",
      "root_end",
      "Fetch",
      "Run",
    ]) {
      expect(overlaps(note, await box(node(page, id))), `the note covers ${id}`).toBe(false);
    }
    // The composite frames its children.
    const working = await box(node(page, "Working"));
    const fetch = await box(node(page, "Fetch"));
    expect(fetch.x).toBeGreaterThan(working.x);
    expect(fetch.y + fetch.height).toBeLessThan(working.y + working.height);
  });

  test("selects a state and a composite, and the agent reads them back", async ({ page }) => {
    const server = await open(page, "state", "state", stateDrawn);
    await selectMode(page);
    await node(page, "Idle").click();
    await expect.poll(() => selectedNodes(server)).toEqual(["Idle"]);
    // The diagram opens at reading size with its right-hand part, the
    // composite among it, past the edge: the reader shows all of it first.
    await page.locator(".archer-offscreen-cue-action", { hasText: "Show all" }).click();
    await expect
      .poll(async () => {
        const frame = await box(node(page, "Working"));
        return frame.x + frame.width <= (page.viewportSize()?.width ?? 0);
      })
      .toBe(true);
    // The composite's own frame, away from its children.
    const working = await box(node(page, "Working"));
    await page.keyboard.down("Shift");
    await page.mouse.click(working.x + 6, working.y + working.height - 6);
    await page.keyboard.up("Shift");
    await expect.poll(() => selectedNodes(server)).toEqual(["Idle", "Working"]);
    const selection = await server.selection();
    expect(selection?.nodes).toContainEqual({ id: "Idle", label: "Waiting for work" });
  });

  test("walks the states by keyboard and selects with Enter", async ({ page }) => {
    const server = await open(page, "state", "state", stateDrawn);
    await node(page, "Idle").focus();
    await page.keyboard.press("ArrowRight");
    const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id ?? null);
    expect(focused).not.toBeNull();
    expect(focused).not.toBe("Idle");
    await page.keyboard.press("Enter");
    await expect.poll(() => selectedNodes(server)).toEqual([focused!]);
  });

  test("wears the agent's emphasis and the reader's comments", async ({ page }) => {
    const server = await open(page, "state", "state", stateDrawn);
    await server.setEmphasis("drawing", [
      {
        id: "loop",
        title: "The loop",
        groups: [{ id: "g", label: "g", style: "highlight", nodes: ["Working", "Idle"], edges: ["Idle--Checking"] }],
      },
    ]);
    await expect(node(page, "Working")).toHaveClass(/archer-emph/);
    await expect(node(page, "Idle")).toHaveClass(/archer-emph/);
    await commentOn(page, node(page, "Checking"), "Does it back off when the queue is empty?", /Node: Checking/);
    await expect(node(page, "Checking").locator(".archer-pin")).toBeVisible();
  });

  test("fits a phone-width window without a sideways scroll", async ({ page }) => {
    await open(page, "state", "state", stateDrawn, { width: 390 });
    await noPageScroll(page);
  });

  axeEveryLook("state", "state", stateDrawn, "Idle", "Working");
});

// ------------------------------------------------------------------- ER

const erDrawn = async (page: Page): Promise<void> => {
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
};

test.describe("entity-relationship diagram", () => {
  test("draws entities as tables whose rows fit, and crow's feet at the wire ends", async ({ page }) => {
    await open(page, "er", "entity-relationship", erDrawn);
    const order = node(page, "ORDER");
    const table = await box(order);
    const rows = order.locator(".archer-er-row");
    await expect(rows).toHaveCount(4);
    // Every cell is inside its entity: the layout sized the box for the rows drawn.
    for (const cell of await order.locator(".archer-er-row > span").all()) {
      const drawn = await cell.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(drawn.scroll, "a cell's text is cut off").toBeLessThanOrEqual(drawn.client + 1);
    }
    const last = await box(rows.last());
    expect(last.y + last.height).toBeLessThanOrEqual(table.y + table.height);
    // Each end's mark sits where its wire meets its entity.
    const mark = await box(
      page.locator('.react-flow__edge[data-id="CUSTOMER--ORDER"] .archer-er-mark[data-end="target"]'),
    );
    const gap = Math.min(
      Math.abs(mark.x + mark.width - table.x),
      Math.abs(mark.x - (table.x + table.width)),
      Math.abs(mark.y + mark.height - table.y),
      Math.abs(mark.y - (table.y + table.height)),
    );
    expect(gap).toBeLessThan(4);
  });

  test("selects an entity and a relationship, and the agent reads them back", async ({ page }) => {
    const server = await open(page, "er", "entity-relationship", erDrawn);
    await selectMode(page);
    await node(page, "CUSTOMER").click();
    await expect.poll(() => selectedNodes(server)).toEqual(["CUSTOMER"]);
    await clickEdge(page, "CUSTOMER--ORDER", true);
    await expect.poll(async () => (await server.selection())?.edges.map((e) => e.id)).toEqual(["CUSTOMER--ORDER"]);
  });

  test("wears the agent's emphasis and the reader's comments", async ({ page }) => {
    const server = await open(page, "er", "entity-relationship", erDrawn);
    await server.setEmphasis("drawing", [
      { id: "e", groups: [{ id: "g", label: "g", style: "flow", nodes: ["ORDER"], edges: ["ORDER--LINE-ITEM"] }] },
    ]);
    await expect(node(page, "ORDER")).toHaveClass(/archer-emph/);
    await commentOn(page, node(page, "PRODUCT"), "Should products be versioned?", /Node: PRODUCT/);
    await expect(node(page, "PRODUCT").locator(".archer-pin")).toBeVisible();
  });

  test("fits a phone-width window without a sideways scroll", async ({ page }) => {
    await open(page, "er", "entity-relationship", erDrawn, { width: 390 });
    await noPageScroll(page);
  });

  axeEveryLook("er", "entity-relationship", erDrawn, "CUSTOMER", "ORDER");
});

// ------------------------------------------------------------------- C4

const c4Drawn = async (page: Page): Promise<void> => {
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(8);
  await expect(page.locator(".react-flow__edge")).toHaveCount(7);
};

test.describe("C4 diagram", () => {
  test("draws elements whose lines fit, inside the boundaries they are written in", async ({ page }) => {
    await open(page, "c4", "c4", c4Drawn);
    for (const id of ["customer", "web", "orders", "events", "payments", "ledger", "crm", "courier"]) {
      const element = await box(node(page, id));
      for (const line of await node(page, id)
        .locator(".archer-c4-label, .archer-c4-type, .archer-c4-description .archer-node-label-row")
        .all()) {
        const drawn = await box(line);
        expect(drawn.x, `${id}: a line spills out on the left`).toBeGreaterThanOrEqual(element.x - 1);
        expect(drawn.x + drawn.width, `${id}: a line spills out on the right`).toBeLessThanOrEqual(
          element.x + element.width + 1,
        );
        expect(drawn.y + drawn.height, `${id}: a line spills out at the bottom`).toBeLessThanOrEqual(
          element.y + element.height + 1,
        );
      }
    }
    const shop = await box(node(page, "shop"));
    const company = await box(node(page, "company"));
    const web = await box(node(page, "web"));
    expect(web.x).toBeGreaterThan(shop.x);
    expect(shop.x).toBeGreaterThan(company.x);
    await expect(page.locator(".archer-canvas-heading")).toHaveText("Web shop containers · C4 container diagram");
  });

  test("selects an element and a boundary, and the agent reads them back", async ({ page }) => {
    const server = await open(page, "c4", "c4", c4Drawn);
    await selectMode(page);
    await node(page, "web").click();
    await expect.poll(() => selectedNodes(server)).toEqual(["web"]);
    // Under the presence line (phase 3) the canvas is a line shorter, and the
    // drawing opens at reading size with its foot past the bottom edge: the
    // reader shows all of it first, as for the state diagram.
    const cue = page.locator(".archer-offscreen-cue-action", { hasText: "Show all" });
    if (await cue.isVisible()) await cue.click();
    await expect
      .poll(async () => {
        const frame = await box(node(page, "ops"));
        return frame.y + frame.height <= (page.viewportSize()?.height ?? 0);
      })
      .toBe(true);
    const ops = await box(node(page, "ops"));
    await page.keyboard.down("Shift");
    await page.mouse.click(ops.x + 6, ops.y + ops.height - 6);
    await page.keyboard.up("Shift");
    await expect.poll(() => selectedNodes(server)).toEqual(["ops", "web"]);
  });

  test("walks to a boundary by keyboard and selects it", async ({ page }) => {
    const server = await open(page, "c4", "c4", c4Drawn);
    await node(page, "web").focus();
    let reached = false;
    for (let step = 0; step < 14 && !reached; step += 1) {
      await page.keyboard.press("ArrowUp");
      reached = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id === "shop");
    }
    expect(reached, "the boundary is reachable by arrow keys").toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => selectedNodes(server)).toEqual(["shop"]);
  });

  test("wears the agent's emphasis and the reader's comments", async ({ page }) => {
    const server = await open(page, "c4", "c4", c4Drawn);
    await server.setEmphasis("drawing", [
      { id: "e", groups: [{ id: "g", label: "g", style: "flow", nodes: ["shop"], edges: ["web--orders"] }] },
    ]);
    await expect(node(page, "shop")).toHaveClass(/archer-emph/);
    await commentOn(page, node(page, "payments"), "Which provider?", /Node: Payment provider/);
  });

  test("fits a phone-width window without a sideways scroll", async ({ page }) => {
    await open(page, "c4", "c4", c4Drawn, { width: 390 });
    await noPageScroll(page);
  });

  axeEveryLook("c4", "c4", c4Drawn, "web", "shop");
});

// --------------------------------------------------------- architecture

const architectureDrawn = async (page: Page): Promise<void> => {
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(6);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
};

test.describe("architecture diagram", () => {
  test("draws each edge from and to the declared sides, and services with their icons", async ({ page }) => {
    await open(page, "architecture", "architecture", architectureDrawn);
    await expect(node(page, "gateway").locator(".archer-arch-icon-internet")).toBeVisible();
    // `client:R --> L:gateway`: the wire leaves the client's right side and enters the gateway's left.
    const client = await box(node(page, "client"));
    const gateway = await box(node(page, "gateway"));
    const ends = await page
      .locator('.react-flow__edge[data-id="client--gateway"] .react-flow__edge-path')
      .evaluate((path) => {
        const route = path as SVGPathElement;
        const matrix = route.getScreenCTM()!;
        const at = (length: number) => {
          const p = route.getPointAtLength(length);
          return { x: p.x * matrix.a + matrix.e, y: p.y * matrix.d + matrix.f };
        };
        return { start: at(0), end: at(route.getTotalLength()) };
      });
    expect(Math.abs(ends.start.x - (client.x + client.width))).toBeLessThan(3);
    expect(Math.abs(ends.end.x - gateway.x)).toBeLessThan(3);
  });

  test("selects a service, a junction and a group, and the agent reads them back", async ({ page }) => {
    const server = await open(page, "architecture", "architecture", architectureDrawn);
    await selectMode(page);
    await node(page, "app").click();
    await node(page, "hub").click({ modifiers: ["Shift"] });
    const data = await box(node(page, "data"));
    await page.keyboard.down("Shift");
    await page.mouse.click(data.x + 6, data.y + data.height - 6);
    await page.keyboard.up("Shift");
    await expect.poll(() => selectedNodes(server)).toEqual(["app", "data", "hub"]);
  });

  test("wears the agent's emphasis and the reader's comments", async ({ page }) => {
    const server = await open(page, "architecture", "architecture", architectureDrawn);
    await server.setEmphasis("drawing", [
      { id: "e", groups: [{ id: "g", label: "g", style: "flow", nodes: ["hub"], edges: ["hub--files"] }] },
    ]);
    await expect(node(page, "hub")).toHaveClass(/archer-emph/);
    await commentOn(page, node(page, "db"), "Is this replicated?", /Node: Orders DB/);
  });

  test("fits a phone-width window without a sideways scroll", async ({ page }) => {
    await open(page, "architecture", "architecture", architectureDrawn, { width: 390 });
    await noPageScroll(page);
  });

  axeEveryLook("architecture", "architecture", architectureDrawn, "app", "cloud");
});

// -------------------------------------------------------------- journey

const journeyDrawn = async (page: Page): Promise<void> => {
  await expect(page.locator("[data-journey-id]")).toHaveCount(10);
};
const journeyEl = (page: Page, id: string): Locator => page.locator(`[data-journey-id="${id}"]`);

test.describe("user journey", () => {
  test("draws sections as columns side by side, tasks in order down each", async ({ page }) => {
    await open(page, "journey", "journey", journeyDrawn);
    const first = await box(journeyEl(page, "section-go-to-work"));
    const second = await box(journeyEl(page, "section-lunch-at-the-caf-ue9"));
    expect(second.x).toBeGreaterThan(first.x + first.width);
    const tea = await box(journeyEl(page, "make-tea"));
    const upstairs = await box(journeyEl(page, "go-upstairs"));
    expect(upstairs.y).toBeGreaterThan(tea.y + tea.height - 1);
    await expect(journeyEl(page, "do-work").locator(".archer-journey-score-text")).toHaveText("1/5");
    await expect(page.locator(".archer-journey-title")).toHaveText("A working day");
  });

  test("selects a task and a section, and the agent reads them back", async ({ page }) => {
    const server = await open(page, "journey", "journey", journeyDrawn);
    await journeyEl(page, "do-work").click();
    await expect.poll(() => selectedNodes(server)).toEqual(["do-work"]);
    await journeyEl(page, "section-go-home").click({ modifiers: ["Shift"] });
    await expect.poll(() => selectedNodes(server)).toEqual(["do-work", "section-go-home"]);
    expect((await server.selection())?.nodes).toContainEqual({ id: "section-go-home", label: "Go home" });
  });

  // E11: when the host's network changes (a container starting adds an interface), Chromium fails every
  // request in flight, loopback included (net::ERR_NETWORK_CHANGED). A read dropped so is asked again.
  test("asks again for the notes when the browser drops the read, and logs nothing", async ({ page }) => {
    let asked = 0;
    await page.route(/\/api\/notes\?viewId=/, (route) =>
      ++asked === 1 ? route.abort("internetdisconnected") : route.continue(),
    );
    const answered = page.waitForResponse((response) => /\/api\/notes\?viewId=/.test(response.url()) && response.ok());
    await open(page, "journey", "journey", journeyDrawn);
    await answered;
    expect(asked).toBeGreaterThanOrEqual(2);
    // Chromium's own line for the request this test dropped is the browser's, not the page's.
    problems = problems.filter((line) => line !== "error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED");
  });

  test("is one tab stop, walked with the arrows, selected with Enter", async ({ page }) => {
    const server = await open(page, "journey", "journey", journeyDrawn);
    await journeyEl(page, "section-go-to-work").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await expect(journeyEl(page, "caf-ue9-visit")).toBeFocused();
    await expect(journeyEl(page, "caf-ue9-visit")).toHaveClass(/archer-kbd-focus/);
    await page.keyboard.press("Enter");
    await expect.poll(() => selectedNodes(server)).toEqual(["caf-ue9-visit"]);
    // Leaving and coming back by Tab returns to the same task.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(journeyEl(page, "caf-ue9-visit")).toBeFocused();
  });

  test("wears the agent's emphasis and the reader's comments", async ({ page }) => {
    const server = await open(page, "journey", "journey", journeyDrawn);
    await server.setEmphasis("drawing", [
      { id: "low", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["do-work"], edges: [] }] },
    ]);
    await expect(journeyEl(page, "do-work")).toHaveClass(/archer-emph/);
    // No counts in the legend (ADR 0030): the row names the group.
    await expect(page.locator(".archer-emph-legend").getByRole("button", { name: "g", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await commentOn(page, journeyEl(page, "do-work"), "Why is this the low point?", /Node: Do work/);
    await expect(journeyEl(page, "do-work").locator(".archer-pin")).toBeVisible();
  });

  test("stacks its sections at phone width, without a sideways scroll", async ({ page }) => {
    await open(page, "journey", "journey", journeyDrawn, { width: 390 });
    await noPageScroll(page);
    const first = await box(journeyEl(page, "section-go-to-work"));
    const second = await box(journeyEl(page, "section-lunch-at-the-caf-ue9"));
    expect(second.y).toBeGreaterThan(first.y + first.height);
    expect(first.x + first.width).toBeLessThanOrEqual(390);
  });

  // One design since phase 3b; the row keeps its name.
  for (const design of ["current"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      test(`axe finds nothing, with a selection and an emphasis · ${design} ${scheme}`, async ({ page }) => {
        const server = await open(page, "journey", "journey", journeyDrawn, { design, scheme });
        await journeyEl(page, "make-tea").click();
        await server.setEmphasis("drawing", [
          { id: "e", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["section-go-home"], edges: [] }] },
        ]);
        await expect(journeyEl(page, "section-go-home")).toHaveClass(/archer-emph/);
        expect(await violations(page)).toEqual([]);
      });
    }
  }
});

/** axe in both schemes, with a selection and an emphasis on screen. */
function axeEveryLook(
  type: string,
  kind: string,
  drawn: (page: Page) => Promise<void>,
  selectId: string,
  emphasiseId: string,
): void {
  // One design since phase 3b; the row keeps its name.
  for (const design of ["current"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      test(`axe finds nothing, with a selection and an emphasis · ${design} ${scheme}`, async ({ page }) => {
        const server = await open(page, type, kind, drawn, { design, scheme });
        await selectMode(page);
        await node(page, selectId).click();
        await server.setEmphasis("drawing", [
          { id: "e", groups: [{ id: "g", label: "g", style: "highlight", nodes: [emphasiseId], edges: [] }] },
        ]);
        await expect(node(page, emphasiseId)).toHaveClass(/archer-emph/);
        expect(await violations(page)).toEqual([]);
      });
    }
  }
}
