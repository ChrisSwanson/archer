// Round 1 (UI/UX) fixes, pass 2, batch F5: the shell on a phone. Each test names its row in the
// round's second fixes list and the rubric criterion it answers (docs/quality/rubrics/ui-ux.md, v1).
// The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`, else ui/dist), on a touch
// phone at 320×640 and 390×844, in both themes.
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type Page,
  type BrowserContext,
  type BrowserContextOptions,
} from "@playwright/test";
import type { TsProject } from "../support/ts-service";
// @ts-expect-error the harness is plain JavaScript
import { censusPage } from "../../../tools/devkit/harness/targets.mjs";
import { sharedTsProject } from "./support/shared-service";

type Target = {
  readonly name: string;
  readonly path: string;
  readonly box: { w: number; h: number };
  readonly h44: boolean | null;
};
/** Coarse-pointer targets under 44×44 (G7 [H]) whose path matches. */
async function small(page: Page, pattern: RegExp): Promise<string[]> {
  const census = (await censusPage(page)) as { targets: Target[] };
  return census.targets
    .filter((t) => pattern.test(t.path) && t.h44 === false)
    .map((t) => `${t.name} ${t.box.w}×${t.box.h}`);
}

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus");

function corpus(name: string): Record<string, string> {
  const root = join(CORPUS, name);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}
const commit = async (root: string): Promise<void> => {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-c", "user.name=archer-test", "-c", "user.email=test@archer.invalid", "-c", "init.defaultBranch=main", ...args],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "corpus");
};

let project: TsProject | undefined;
// The contexts a test opens are closed with it: one left open keeps its page polling the stopped service for the
// rest of the worker, on the same browser as every later test (known failure O51).
const contexts: BrowserContext[] = [];
async function opened(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  contexts.push(context);
  return context;
}
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await project?.stop();
  project = undefined;
});

type Opened = { readonly page: Page; readonly at: (path: string) => string; readonly project: TsProject };
type Phone = { readonly width: number; readonly height: number; readonly theme: "light" | "dark" };
async function open(browser: Browser, phone: Phone, name = "pageturner"): Promise<Opened> {
  project = await sharedTsProject({ files: corpus(name), beforeAttach: commit });
  const context = await opened(browser, {
    viewport: { width: phone.width, height: phone.height },
    hasTouch: true,
    isMobile: true,
    colorScheme: phone.theme,
  });
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f5")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}`, project };
}
const PHONES: readonly Phone[] = [
  { width: 320, height: 640, theme: "light" },
  { width: 320, height: 640, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
];
const named = (phone: Phone): string => `${phone.width}×${phone.height} ${phone.theme}`;

/** In the page: the focused element, when what its centre (clipped to the window) meets is `cover` and not itself. */
function coveredStop(cover: string): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (active === null || active === document.body) return null;
  const box = active.getBoundingClientRect();
  const left = Math.max(box.left, 0),
    right = Math.min(box.right, innerWidth),
    top = Math.max(box.top, 0),
    bottom = Math.min(box.bottom, innerHeight);
  if (right <= left || bottom <= top) return null;
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  const covered =
    hit !== null && hit.closest(cover) !== null && active.closest(cover) === null && !active.contains(hit);
  return covered
    ? `${active.tagName}.${active.className} ${active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40)}`
    : null;
}

for (const phone of PHONES) {
  test(`a, b G1/G4: under the phone review sheet no covered region is a Tab stop or an axe scroll region, ${named(phone)}`, async ({
    browser,
  }) => {
    const { page, at } = await open(browser, phone);
    await page.goto(at(""));
    const bell = page.getByRole("button", { name: /^Notifications\b/ });
    await bell.click();
    const review = page.getByRole("region", { name: "Project Review" });
    await expect(review).toBeVisible();
    // The sheet has arrived (its slide-in ends) and the shell has marked what it covers.
    await expect(page.getByRole("button", { name: "Project settings", exact: true })).toHaveAttribute("inert", "");

    const axe = await new AxeBuilder({ page })
      .withRules(["scrollable-region-focusable", "empty-table-header"])
      .analyze();
    expect.soft(axe.violations.flatMap((rule) => rule.nodes.map((node) => node.target.join(" ")))).toEqual([]);

    const hidden: string[] = [];
    const reached = new Set<string>();
    for (let press = 0; press < 30; press++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(coveredStop, ".primary-review-inbox");
      if (stop !== null) hidden.push(stop);
      reached.add(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
    }
    expect.soft(hidden).toEqual([]);
    // The page beside the sheet is not a dialog's backdrop: its bar stays usable.
    expect([...reached]).toContain("Menu");
    // The bell's name carries its unread count ("Notifications, 1 unread agent answer") when the corpus has one.
    expect([...reached].some((label) => /^Notifications\b/.test(label))).toBe(true);

    // Closing gives everything back.
    await review.getByRole("button", { name: "Close project review" }).click();
    await expect(review).toBeHidden();
    await expect(page.locator("[inert]")).toHaveCount(0);
  });
}

type Rect = { left: number; top: number; right: number; bottom: number };
const meets = (a: Rect, b: Rect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const inside = (a: Rect, b: Rect): boolean =>
  a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

for (const phone of PHONES) {
  test(`c G4/G8: on a phone the way up and the note's commit time share the trail without overlapping, ${named(phone)}`, async ({
    browser,
  }) => {
    const { page, at } = await open(browser, phone, "awkward");
    await page.goto(at("notes/auth.md#broken"));
    const trail = page.locator(".primary-document-trail");
    const fresh = trail.locator(".archer-freshness");
    await expect(fresh).toBeVisible();
    const crumb = trail.locator(".primary-breadcrumb > button:not([data-far])");
    await expect(crumb).toHaveText("auth.md");
    const geometry = await trail.evaluate((el) => {
      const rect = (node: Element): Rect => {
        const b = node.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      };
      const button = el.querySelector(".primary-breadcrumb > button:not([data-far])")!;
      const nav = el.querySelector(".primary-breadcrumb")!;
      const fresh = el.querySelector(".archer-freshness > span:first-child")!;
      const b = button.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        trail: rect(el),
        nav: rect(nav),
        button: rect(button),
        fresh: rect(fresh),
        onTop: top !== null && button.contains(top),
        full: (button as HTMLElement).scrollWidth <= (button as HTMLElement).clientWidth,
      };
    });
    expect(geometry.onTop, "the way-up crumb is what its centre meets").toBe(true);
    expect(geometry.full, "the crumb's name is not cut").toBe(true);
    expect(inside(geometry.button, geometry.nav), "the crumb is not clipped by the trail").toBe(true);
    expect(inside(geometry.fresh, geometry.trail), "the commit time is not clipped").toBe(true);
    expect(meets(geometry.button, geometry.fresh), "the crumb and the commit time do not overlap").toBe(false);
  });
}

const FLOW_GROUPS = [
  {
    id: "path",
    title: "Happy path",
    groups: [
      {
        id: "paid",
        label: "paid",
        description: "Payment goes through.",
        style: "flow",
        nodes: ["order", "pay", "pick"],
        edges: ["placed", "accepted"],
      },
      { id: "out", label: "out", style: "highlight", nodes: ["pack", "ship"], edges: ["packed"] },
    ],
  },
];
for (const phone of PHONES) {
  test(`d, e G4/G1: an open dock sheet leaves the chips and the chat button uncovered, ${named(phone)}`, async ({
    browser,
  }) => {
    const { page, at, project } = await open(browser, phone);
    await page.goto(at("diagrams/fulfilment.mmd"));
    await expect(page.locator('.react-flow__node[data-id="pay"]')).toBeVisible();
    await project.setEmphasis("fulfilment", FLOW_GROUPS);
    const chip = page.locator(".archer-stage-dock > .archer-dock-chip").first();
    await expect(chip).toBeVisible();
    await chip.click();
    const sheet = page.locator(".archer-dock-sheet");
    await expect(sheet).toBeVisible();
    // The chat button waits above the sheet, beside the toolbar, rather than lie half under it.
    const fab = page.locator(".archer-chat-fab");
    await expect(fab).toBeVisible();
    // Measured where it comes to rest: it is lifted by the sheet's height once that is measured, and glides there.
    let was = "";
    await expect
      .poll(
        async () => {
          const now = JSON.stringify(await fab.boundingBox());
          const still = now === was;
          was = now;
          return still;
        },
        { intervals: [100] },
      )
      .toBe(true);
    // Each chip and the chat button: its centre and four points near its corners meet the control itself, not the sheet.
    const hidden = await page.evaluate(() => {
      const out: string[] = [];
      for (const control of document.querySelectorAll<HTMLElement>(
        ".archer-stage-dock > .archer-dock-chip, .archer-chat-fab",
      )) {
        const b = control.getBoundingClientRect();
        // Inside the rounded corners: a pill's and a disc's corners are not the control.
        const i = Math.min(b.width, b.height) * 0.3;
        const points = [
          [b.left + i, b.top + i],
          [b.right - i, b.top + i],
          [b.left + i, b.bottom - i],
          [b.right - i, b.bottom - i],
          [b.left + b.width / 2, b.top + b.height / 2],
        ];
        for (const [x, y] of points) {
          const hit = document.elementFromPoint(x!, y!);
          if (hit === null || !control.contains(hit))
            out.push(
              `${control.getAttribute("aria-label")} at ${Math.round(x!)},${Math.round(y!)}: ${hit?.className ?? "outside"}`,
            );
        }
      }
      return out;
    });
    expect.soft(hidden).toEqual([]);
    // The toolbar riding above the sheet stays below the drawing's header strip.
    const strip = await page.locator(".archer-diagram-strip").boundingBox();
    const tools = await page.locator(".react-flow__controls").boundingBox();
    if (strip !== null && tools !== null)
      expect
        .soft(tools.y, "the canvas toolbar is clear of the header strip")
        .toBeGreaterThanOrEqual(strip.y + strip.height);
    if (tools !== null) {
      const chat = (await fab.boundingBox())!;
      const apart =
        chat.x >= tools.x + tools.width ||
        chat.x + chat.width <= tools.x ||
        chat.y >= tools.y + tools.height ||
        chat.y + chat.height <= tools.y;
      expect.soft(apart, "the chat button is clear of the canvas toolbar").toBe(true);
    }
    const axe = await new AxeBuilder({ page }).withRules(["target-size"]).analyze();
    expect.soft(axe.violations.flatMap((rule) => rule.nodes.map((node) => node.target.join(" ")))).toEqual([]);

    // Extra rows 1-3 (G7 [H]): the toolbar above the sheet, the dataflow chip and the sheet's mode button keep 44×44.
    expect.soft(await small(page, /react-flow__controls|archer-dataflow-chip|archer-diagram-modes/)).toEqual([]);

    // Tab either way from inside the sheet never lands on something the sheet hides.
    const covered: string[] = [];
    for (const key of ["Tab", "Shift+Tab"]) {
      await sheet.getByRole("button", { name: /^Close/ }).focus();
      for (let press = 0; press < 25; press++) {
        await page.keyboard.press(key);
        // The drawing's own nodes and lines are the canvas's focus to manage (F6), not the shell's.
        const stop = await page
          .evaluate(
            (cover) => (document.activeElement?.closest(".react-flow__viewport") ? null : cover),
            ".archer-dock-sheet",
          )
          .then((cover) => (cover === null ? null : page.evaluate(coveredStop, cover)));
        if (stop !== null) covered.push(`${key}: ${stop}`);
      }
    }
    expect(covered).toEqual([]);

    // The chip folds its sheet, and the chat button comes back.
    await chip.click();
    await expect(sheet).toBeHidden();
    await expect(fab).toBeVisible();
  });
}

for (const width of [320, 390]) {
  test(`extra row 4 G7 [H]: the review's New comment is a 44 px target under touch, ${width}`, async ({ browser }) => {
    const { page, at } = await open(browser, { width, height: width === 320 ? 640 : 844, theme: "light" });
    await page.goto(at("diagrams/fulfilment.mmd"));
    await expect(page.locator('.react-flow__node[data-id="pay"]')).toBeVisible();
    await page.getByRole("button", { name: /^Notifications\b/ }).click();
    await expect(
      page.getByRole("region", { name: "Project Review" }).getByRole("button", { name: "New comment" }),
    ).toBeVisible();
    expect(await small(page, /primary-inbox-compose/)).toEqual([]);
  });
}

test("f G3/G4: a review opened while the page loads keeps its focus and its draft when it moves into the diagram panel", async ({
  browser,
}) => {
  const { page, at, project } = await open(browser, { width: 1500, height: 900, theme: "light" });
  await project.agentCreateComment("view:system-context", { kind: "view" }, "Which way do refunds go?");
  // The diagram is held back, so the diagram panel (the review's place on a diagram page) mounts only when released.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/diagrams\/system-context$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(at("diagrams/system-context.mmd"));
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  const review = page.getByRole("region", { name: "Project Review" });
  await expect(review).toBeVisible();
  await expect(review).not.toHaveAttribute("data-in-panel", "true");
  await review.getByText("Which way do refunds go?").first().click();
  const reply = review.getByRole("textbox").first();
  await reply.fill("Through the payment provider");
  await expect(reply).toBeFocused();
  await page.evaluate(() => {
    (document.getElementById("archer-review") as HTMLElement & { __before?: true }).__before = true;
  });

  release();
  await expect(review).toHaveAttribute("data-in-panel", "true");
  // The same review, moved, not a new one: what was typed is there and focus stayed in it.
  expect(
    await page.evaluate(
      () => (document.getElementById("archer-review") as HTMLElement & { __before?: true }).__before === true,
    ),
  ).toBe(true);
  await expect(reply).toHaveValue("Through the payment provider");
  await expect(reply).toBeFocused();
  await page.waitForTimeout(300);
  await expect(reply).toBeFocused();
});

// The other side of O174: the page opens a thread for a reply kept before it loaded, never for one written since.
test("f G3/G4: a reply kept before a reload opens its thread again, said as restored", async ({ browser }) => {
  const { page, at, project } = await open(browser, { width: 1500, height: 900, theme: "light" });
  await project.agentCreateComment("view:system-context", { kind: "view" }, "Which way do refunds go?");
  await page.goto(at("diagrams/system-context.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  const review = page.getByRole("region", { name: "Project Review" });
  await review.getByText("Which way do refunds go?").first().click();
  await review.getByRole("textbox").first().fill("Through the payment provider");
  await page.reload();
  await expect(page.getByText("Restored your unsent reply from earlier.")).toBeVisible();
  await expect(page.getByRole("textbox").filter({ hasText: "Through the payment provider" }).first()).toHaveValue(
    "Through the payment provider",
  );
});

// O179 (codex-1001): the project page unmounts and mounts again inside one document (Back past Projects, Forward
// again), so a reply kept on the earlier visit was saved after this document loaded. It still opens its thread.
test("f G3/G4: a reply kept before Back past Projects and Forward again in one document opens its thread again", async ({
  browser,
}) => {
  const { page, at, project } = await open(browser, { width: 1500, height: 900, theme: "light" });
  await project.agentCreateComment("view:checkout", { kind: "view" }, "Who holds the basket?");
  await page.goto(at("").replace(/\/projects\/[^/]+\/$/, "/projects/"));
  await page.evaluate(() => {
    (window as Window & { __sameDocument?: true }).__sameDocument = true;
  });
  await page
    .getByRole("link", { name: /Pageturner/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Checkout", exact: true }).first().click();
  await expect(page).toHaveURL(/checkout\.mmd$/);
  await expect(page.getByRole("group", { name: "Sequence diagram canvas" })).toBeVisible();
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  const review = page.getByRole("region", { name: "Project Review" });
  await review.getByText("Who holds the basket?").first().click();
  await review.getByRole("textbox").first().fill("The order service");
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/$/);
  // O192: the second Forward lands while the project page's inventory is still loading (here held, so it always
  // does; unheld it did about one run in 15). The page then could not name the diagram, gave up on it, and stayed on
  // the project home at the diagram's address.
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let asked!: () => void;
  const loading = new Promise<void>((done) => {
    asked = done;
  });
  await page.route(/\/api\/diagrams(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    asked();
    await gate;
    await route.continue();
  });
  await page.goForward();
  await loading;
  await page.goForward();
  await expect(page).toHaveURL(/checkout\.mmd$/);
  release();
  await expect(page.getByRole("group", { name: "Sequence diagram canvas" })).toBeVisible();
  // Every step stayed in this document: the reply was kept during it, after its timeOrigin.
  expect(await page.evaluate(() => (window as Window & { __sameDocument?: true }).__sameDocument === true)).toBe(true);
  await expect(page.getByText("Restored your unsent reply from earlier.")).toBeVisible();
  await expect(page.getByRole("textbox").filter({ hasText: "The order service" }).first()).toHaveValue(
    "The order service",
  );
});

// O179 (codex-1001): a reply kept before the clock went back reads as saved after this page loaded. It still opens.
test("f G3/G4: a reply kept with a savedAt later than the page's load (a clock set back) opens its thread again", async ({
  browser,
}) => {
  const { page, at, project } = await open(browser, { width: 1500, height: 900, theme: "light" });
  await project.agentCreateComment("view:system-context", { kind: "view" }, "Which way do refunds go?");
  await page.goto(at("diagrams/system-context.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  const review = page.getByRole("region", { name: "Project Review" });
  await review.getByText("Which way do refunds go?").first().click();
  await review.getByRole("textbox").first().fill("Through the payment provider");
  // The kept record's savedAt moved an hour on, as if it was kept before the clock was set back.
  const moved = await page.evaluate(() => {
    let count = 0;
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)!;
        if (!key.includes("reply:")) continue;
        const value = JSON.parse(store.getItem(key)!) as { savedAt?: number };
        if (typeof value.savedAt !== "number") continue;
        store.setItem(key, JSON.stringify({ ...value, savedAt: value.savedAt + 3_600_000 }));
        count += 1;
      }
    }
    return count;
  });
  expect(moved).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByText("Restored your unsent reply from earlier.")).toBeVisible();
  await expect(page.getByRole("textbox").filter({ hasText: "Through the payment provider" }).first()).toHaveValue(
    "Through the payment provider",
  );
});

for (const [width, height] of [
  [1000, 800],
  [1500, 900],
] as const) {
  test(`a G1: the review sidebar leaves no covered column header empty, ${width}×${height}`, async ({ browser }) => {
    project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
    const page = await (await opened(browser, { viewport: { width, height } })).newPage();
    await page.goto((await project.issueAccess("round1-f5")).url);
    const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
    await page.goto(`${new URL(project.url).origin}/projects/${slug}/`);
    await page.getByRole("button", { name: /^Notifications\b/ }).click();
    await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Project settings", exact: true })).toHaveAttribute("inert", "");
    const axe = await new AxeBuilder({ page })
      .withRules(["empty-table-header", "scrollable-region-focusable"])
      .analyze();
    expect(axe.violations.flatMap((rule) => rule.nodes.map((node) => `${rule.id} ${node.target.join(" ")}`))).toEqual(
      [],
    );
  });
}
