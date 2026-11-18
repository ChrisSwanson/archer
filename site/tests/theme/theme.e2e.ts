import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// Run after docs:build, against the built site: the progressive-disclosure outline and the landing page.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
let server: StaticServer;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
});
test.afterAll(() => server.close());
const open = (page: Page, path = "") => page.goto(`${server.origin}${base}${path}`);

const toc = (page: Page) => page.locator("nav.ArcherToc");
const toggleFor = (page: Page, id: string) => toc(page).locator(`button[aria-controls="archer-toc-${id}"]`);
const linkTo = (page: Page, id: string) => toc(page).locator(`a[href="#${id}"]`);
async function scrollToHeading(page: Page, id: string) {
  await page.evaluate((target) => {
    const heading = document.getElementById(target)!;
    window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 70);
  }, id);
}

test.describe("outline", () => {
  test("the CLI reference outline follows the reader and is a keyboard disclosure", async ({ page }) => {
    await open(page, "generated/cli");
    // The CLI reference: h2 = command, h3 = subcommand. "emphasis" holds list, set and clear.
    const parent = "emphasis";
    const child = "emphasis-list";
    await test.step("the outline replaces VitePress's flat outline", async () => {
      await expect(toc(page)).toBeVisible();
      await expect(page.locator(".VPDocAsideOutline")).toBeHidden();
      await expect(toc(page).locator("[role=heading]")).toHaveText("On This Page");
    });
    await test.step("at the top nothing is active and sections are collapsed", async () => {
      await expect(toc(page).locator("[aria-current=location]")).toHaveCount(0);
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-expanded", "false");
      await expect(linkTo(page, child)).toBeHidden();
    });
    await test.step("scrolling into a section expands it and marks the reader's entry", async () => {
      await scrollToHeading(page, child);
      await expect(linkTo(page, child)).toHaveAttribute("aria-current", "location");
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-expanded", "true");
      await expect(linkTo(page, child)).toBeVisible();
    });
    await test.step("the next section collapses the previous one, and its links leave the tab order", async () => {
      await scrollToHeading(page, "walkthrough-show");
      await expect(linkTo(page, "walkthrough-show")).toHaveAttribute("aria-current", "location");
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-expanded", "false");
      await expect(linkTo(page, child)).toBeHidden();
      await expect.poll(() => page.locator(`#archer-toc-${parent}`).evaluate((el: HTMLElement) => el.inert)).toBe(true);
    });
    await test.step("clicking a collapsed section's link scrolls to it and expands it", async () => {
      await linkTo(page, parent).click();
      await expect
        .poll(() => page.evaluate((id) => Math.abs(document.getElementById(id)!.getBoundingClientRect().top), parent))
        .toBeLessThan(140);
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-expanded", "true");
      await expect(linkTo(page, parent)).toHaveAttribute("aria-current", "location");
      await expect(page).toHaveURL(new RegExp(`#${parent}$`));
    });
    await test.step("the toggle is a button: Enter collapses, Space expands, children become reachable", async () => {
      await toggleFor(page, parent).focus();
      await page.keyboard.press("Enter");
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Space");
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Tab");
      await expect(linkTo(page, child)).toBeFocused();
      await expect(toggleFor(page, parent)).toHaveAttribute("aria-label", /emphasis: 3 subsections/);
    });
    await test.step("toggling does not move the page", async () => {
      const before = await page.evaluate(() => window.scrollY);
      await toggleFor(page, parent).click();
      await toggleFor(page, parent).click();
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
    });
  });

  test("a Supported Mermaid family page drills into its h3s", async ({ page }) => {
    await open(page, "supported-mermaid/flowchart");
    await expect(toc(page)).toBeVisible();
    await scrollToHeading(page, "line-patterns-and-the-key");
    await expect(linkTo(page, "line-patterns-and-the-key")).toHaveAttribute("aria-current", "location");
    await expect(toggleFor(page, "edges")).toHaveAttribute("aria-expanded", "true");
  });

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("the disclosure does not animate", async ({ page }) => {
      await open(page, "generated/cli");
      const region = page.locator("#archer-toc-emphasis");
      await expect(region).toBeAttached();
      const duration = await region.evaluate((el) => getComputedStyle(el).transitionDuration);
      for (const value of duration.split(",")) expect(Number.parseFloat(value), duration).toBe(0);
    });
  });
});

const film = (page: Page) => page.locator(".film");
const progress = (page: Page) => page.locator(".film-progress > div").evaluate((bar: HTMLElement) => bar.style.width);
const NPX = "npx -y https://github.com/chrisswanson/archer/releases/latest/download/archer.tgz setup";
const CURL = "curl -fsSL https://chrisswanson.github.io/archer/install.sh | sh";

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  for (const scheme of ["light", "dark"] as const)
    test.describe(`landing ${width}px ${scheme}`, () => {
      test.use({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce" });
      test("leads with the film, fits the width, and downloads only its theme's pictures", async ({ page }) => {
        const pictures: string[] = [];
        page.on("request", (request) => {
          const found = /\/assets\/(walk|point|app)-(light|dark)\./u.exec(request.url());
          if (found) pictures.push(`${found[1]}-${found[2]}`);
        });
        await page.addInitScript((value) => localStorage.setItem("vitepress-theme-appearance", value), scheme);
        await open(page);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          "Give your design conversation a shared picture.",
        );
        await expect(film(page)).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        // Every picture below, scrolled to: each loads, in this theme only.
        for (const shot of await page.locator(".landing-shot img:visible").all()) {
          await shot.scrollIntoViewIfNeeded();
          await expect
            .poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
            .toBe(true);
        }
        await expect(page.locator(".landing-shot img:visible")).toHaveCount(3);
        expect([...new Set(pictures)].sort()).toEqual([`app-${scheme}`, `point-${scheme}`, `walk-${scheme}`]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      });
    });

test.describe("the film", () => {
  test("the terminal's answer is text in the page, and the film says it is scripted", async ({ page }) => {
    await open(page);
    const log = page.getByRole("log", { name: "A long text answer from the coding agent" });
    await expect(log).toContainText("Proposal: move card capture behind a job queue.");
    await expect(log).toContainText(
      "Open in Archer: http://127.0.0.1:4317/projects/shop/notes/proposals/payment-worker.md#flow",
    );
    await expect(log).toHaveAttribute("tabindex", "0");
    await expect(film(page).getByText("Scripted example", { exact: true })).toBeVisible();
    await expect(film(page).getByRole("img", { name: /^Archer in the browser, scripted:/u })).toBeVisible();
    // The opening drawing is in the served page, before any script.
    const html = await (await page.request.get(`${server.origin}${base}`)).text();
    expect(html).toContain('data-element-id="charge"');
  });

  test("it plays on its own, and a reader's Pause holds it until they Play", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    const first = await progress(page);
    await page.clock.runFor(2500);
    await expect.poll(() => progress(page)).not.toBe(first);
    await page.getByRole("button", { name: "Pause" }).click();
    const held = await progress(page);
    await page.clock.runFor(10_000);
    expect(await progress(page)).toBe(held);
    await page.getByRole("button", { name: "Play" }).click();
    await page.clock.runFor(4000);
    await expect.poll(() => progress(page)).not.toBe(held);
  });

  test("off screen it holds its frame, and plays again when it comes back", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await page.locator("#install").scrollIntoViewIfNeeded();
    await expect.poll(() => film(page).evaluate((el) => el.getBoundingClientRect().bottom < 0)).toBe(true);
    await expect(film(page)).toHaveAttribute("data-film-running", "false");
    const held = await progress(page);
    await page.clock.runFor(10_000);
    expect(await progress(page)).toBe(held);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(film(page)).toHaveAttribute("data-film-running", "true");
    await page.clock.runFor(4000);
    await expect.poll(() => progress(page)).not.toBe(held);
  });

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("it starts paused on its first frame and plays only when asked", async ({ page }) => {
      await page.clock.install();
      await open(page);
      const play = page.getByRole("button", { name: "Play" });
      await expect(play).toBeVisible();
      await expect(page.locator(".film-caption:not(.film-caption--ghost)")).toContainText("The same answer, drawn.");
      const first = await progress(page);
      await page.clock.runFor(10_000);
      expect(await progress(page)).toBe(first);
      await play.click();
      await page.clock.runFor(4000);
      await expect.poll(() => progress(page)).not.toBe(first);
    });
  });

  test("the walkthrough's camera keeps each step's parts in the canvas", async ({ page }) => {
    await page.clock.install();
    await open(page);
    // Frames 3 to 5 walk the proposal: its steps' parts, by id, stay inside the canvas once the camera settles.
    const parts = [
      ["api", "db", "save"],
      ["api", "queue", "worker", "enqueue", "take"],
      ["worker", "provider", "charge"],
    ];
    for (const [index, ids] of parts.entries()) {
      await expect
        .poll(() => page.locator(".film-drawing.is-shown").getAttribute("data-film-state"), { timeout: 20_000 })
        .toBe(`proposal-${index + 1}`);
      await page.clock.runFor(1000);
      const outside = await page.evaluate((wanted) => {
        const canvas = document.querySelector(".film-canvas")!.getBoundingClientRect();
        const svg = document.querySelector(".film-drawing.is-shown")!;
        return wanted.filter((id) => {
          const box = svg.querySelector(`[data-element-id="${id}"]`)!.getBoundingClientRect();
          return (
            box.top < canvas.top - 1 ||
            box.bottom > canvas.bottom + 1 ||
            box.left < canvas.left - 1 ||
            box.right > canvas.right + 1
          );
        });
      }, ids);
      expect(outside, `step ${index + 1}`).toEqual([]);
      await page.clock.runFor(1000);
    }
  });

  for (const width of [1440, 390])
    test(`${width}px: the film shifts no layout as it plays (CLS 0)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.install();
      await open(page);
      await page.evaluate(() => {
        (window as unknown as { shifts: unknown[] }).shifts = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
            if (!entry.hadRecentInput) (window as unknown as { shifts: number[] }).shifts.push(entry.value);
        }).observe({ type: "layout-shift" });
      });
      const heights = new Set<number>();
      for (let step = 0; step < 34; step += 1) {
        await page.clock.runFor(1000);
        heights.add(await page.evaluate(() => document.documentElement.scrollHeight));
      }
      expect(await page.evaluate(() => (window as unknown as { shifts: unknown[] }).shifts)).toEqual([]);
      expect(heights.size, "the page holds its height through every frame").toBe(1);
    });
});

/** Runs the film's clock until the shown drawing is in `state` (its highlight), then lets the camera settle. */
async function untilState(page: Page, state: string) {
  for (let waited = 0; waited < 40_000; waited += 250) {
    if ((await page.locator(".film-drawing.is-shown").getAttribute("data-film-state")) === state) break;
    await page.clock.runFor(250);
  }
  await expect(page.locator(".film-drawing.is-shown")).toHaveAttribute("data-film-state", state);
  await page.clock.runFor(1000);
  // The fades are CSS transitions, on the page's own time.
  await page.waitForTimeout(600);
}

/** Runs the film's clock until the caption's lead and words match. */
async function untilCaption(page: Page, words: RegExp) {
  const caption = page.locator(".film-caption:not(.film-caption--ghost)");
  for (let waited = 0; waited < 40_000; waited += 250) {
    if (words.test((await caption.textContent()) ?? "")) break;
    await page.clock.runFor(250);
  }
  await expect(caption).toHaveText(words);
}

test.describe("the film shows what Archer does", () => {
  test("each step and each of the agent's highlights lights its own parts and fades the rest", async ({ page }) => {
    await page.clock.install();
    await open(page);
    // A member carries the highlight; a line outside it is faded, as the painter fades it.
    const lit: [string, string[], string][] = [
      ["proposal-1", ["api", "db", "save"], "take"],
      ["proposal-2", ["queue", "worker", "enqueue", "take"], "charge"],
      ["proposal-3", ["worker", "provider", "charge"], "place"],
      ["revised-agent", ["dlq", "charge", "park"], "save"],
      ["sequence-agent", ["msg-0", "msg-4", "msg-5"], "msg-7"],
    ];
    for (const [state, members, outside] of lit) {
      await untilState(page, state);
      const shown = page.locator(".film-drawing.is-shown");
      for (const id of members)
        await expect(shown.locator(`[data-element-id="${id}"]`).first(), `${state}: ${id}`).toHaveAttribute(
          "data-emphasis",
          state,
        );
      const faded = await shown
        .locator(`[data-element-id="${outside}"][data-element-channel="edge"] > .export-edge-line`)
        .evaluate((line) => Number(getComputedStyle(line).strokeOpacity));
      expect(faded, `${state}: ${outside} is faded`).toBeLessThan(1);
    }
  });

  test("the sequence diagram offers the agent's highlights, never a walkthrough", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await untilCaption(page, /^Another view\./u);
    const panel = page.locator(".film-panel");
    // With no walkthrough open, the app shows the agent's highlights at once, legend and all.
    await expect(panel.locator(".film-highlights")).toBeVisible();
    await expect(panel.locator(".film-play-walk")).toBeHidden();
    await expect(panel.locator(".film-steps")).toBeHidden();
    await untilState(page, "sequence-agent");
    await expect(panel.locator(".film-highlights")).toBeVisible();
    await expect(panel.locator(".film-highlights li")).toHaveCount(2);
    await expect(panel.locator(".film-steps")).toBeHidden();
    await expect(page.locator(".film-caption:not(.film-caption--ghost)")).not.toContainText(/walkthrough/iu);
  });
});

test.describe("the film's motion", () => {
  const log = (page: Page) => page.getByRole("log", { name: "A long text answer from the coding agent" });
  const top = (page: Page) => log(page).evaluate((el) => el.scrollTop);

  test("Pause stops the terminal mid-scroll and stills the carets", async ({ page }) => {
    await page.clock.install();
    await open(page);
    // The second frame scrolls the long answer down over a few seconds.
    await page.clock.runFor(2300 + 600);
    await page.locator(".film").getByRole("button", { name: "Pause" }).click();
    const held = await top(page);
    expect(held, "it had started to scroll").toBeGreaterThan(0);
    await page.clock.runFor(4000);
    expect(await top(page), "the terminal holds still after Pause").toBe(held);
    const caret = await page
      .locator(".film-ask .film-caret")
      .evaluate(
        (el) => getComputedStyle(el).animationName === "none" || getComputedStyle(el).animationPlayState === "paused",
      );
    expect(caret, "the caret stops blinking").toBe(true);
  });

  test("a reader in the terminal keeps it where they put it", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await log(page).focus();
    await log(page).evaluate((el) => {
      el.scrollTop = 40;
    });
    await page.clock.runFor(8000);
    expect(await top(page)).toBe(40);
  });

  test("on a phone it plays only while the browser window is in view, not the terminal above it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    await open(page);
    // The terminal fills the view; the window with Archer in it is below.
    await page.evaluate(() => {
      const term = document.querySelector(".film-term")!.getBoundingClientRect();
      window.scrollBy(0, term.bottom - window.innerHeight);
    });
    await expect
      .poll(() => page.locator(".film-browser").evaluate((el) => el.getBoundingClientRect().top > window.innerHeight))
      .toBe(true);
    await expect(film(page)).toHaveAttribute("data-film-running", "false");
    await page.locator(".film-browser").scrollIntoViewIfNeeded();
    await expect(film(page)).toHaveAttribute("data-film-running", "true");
  });

  for (const width of [390, 320])
    test(`${width}px: every frame's panel fits its sheet: the walkthrough, the Key, the comments and the highlights`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.clock.install();
      await open(page);
      await page.locator(".film-browser").scrollIntoViewIfNeeded();
      const progress = () => page.locator(".film-progress > div").evaluate((bar: HTMLElement) => bar.style.width);
      const seen = new Set<string>();
      for (let guard = 0; guard < 400 && seen.size < 13; guard += 1) {
        const at = await progress();
        if (!seen.has(at)) {
          seen.add(at);
          await page.waitForTimeout(400);
          const clipped = await page.evaluate(() => {
            const panel = document.querySelector(".film-panel")!.getBoundingClientRect();
            const parts = [
              ...document.querySelectorAll(
                ".film-panel > .film-panel-label, .film-panel > .film-panel-title, .film-play-walk, .film-steps li, .film-key, .film-highlights li, .film-comments.is-open > *",
              ),
            ];
            return parts
              .map((part) => ({ part, box: part.getBoundingClientRect() }))
              .filter(({ box }) => box.height > 0 && (box.bottom > panel.bottom + 0.5 || box.top < panel.top - 0.5))
              .map(({ part }) => part.className || part.textContent?.trim().slice(0, 30));
          });
          expect(clipped, `frame at ${at}`).toEqual([]);
          // Nothing runs past the sheet, its own padding included.
          const overflow = await page
            .locator(".film-panel")
            .evaluate((panel) => panel.scrollHeight - panel.clientHeight);
          expect(overflow, `frame at ${at}: the sheet holds its content`).toBeLessThanOrEqual(0);
        }
        await page.clock.runFor(250);
      }
      expect(seen.size).toBe(13);
    });

  test("off screen the terminal stops scrolling too, not only the frames", async ({ page }) => {
    await page.clock.install();
    await open(page);
    const log = page.getByRole("log", { name: "A long text answer from the coding agent" });
    // The second frame scrolls the long answer down over a few seconds.
    await page.clock.runFor(2300 + 600);
    await page.locator("#install").scrollIntoViewIfNeeded();
    await expect(film(page)).toHaveAttribute("data-film-running", "false");
    const held = await log.evaluate((el) => el.scrollTop);
    expect(held, "it had started to scroll").toBeGreaterThan(0);
    await page.clock.runFor(4000);
    expect(await log.evaluate((el) => el.scrollTop)).toBe(held);
  });

  test("on a phone the comment, the wait and the agent's reply are all shown, and the cursor points at what it uses", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    await open(page);
    await page.locator(".film-browser").scrollIntoViewIfNeeded();
    const comments = page.locator(".film-comments");
    await untilCaption(page, /^Point at it\. Comment right on it\./u);
    await expect(
      comments.getByText("If the worker crashes after the charge, is the card charged twice?"),
    ).toBeVisible();
    await page.clock.runFor(600);
    // The cursor glides there on the page's own time.
    await page.waitForTimeout(1200);
    const near = await page.evaluate(() => {
      const target = document.querySelector('[data-film-target="comment"]')!.getBoundingClientRect();
      const cursor = document.querySelector(".film-cursor svg")!.getBoundingClientRect();
      return (
        target.width > 0 &&
        cursor.left >= target.left - 8 &&
        cursor.left <= target.right + 8 &&
        cursor.top >= target.top - 8 &&
        cursor.top <= target.bottom + 8
      );
    });
    expect(near, "the cursor is on the Comment button").toBe(true);
    await untilCaption(page, /^It waits\./u);
    await expect(comments.getByText("Waiting for the agent's next turn")).toBeVisible();
    await untilCaption(page, /^Revised\./u);
    await expect(comments.getByText(/Not with an idempotency key/u)).toBeVisible();
  });
});

test.describe("accessibility", () => {
  for (const [width, scheme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
  ] as const)
    test(`${width}px ${scheme}: the landing has no axe violations`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.addInitScript((value) => localStorage.setItem("vitepress-theme-appearance", value), scheme);
      await open(page);
      await expect(film(page)).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
});

test.describe("leaving and coming back", () => {
  test("a copy still under way when the landing unmounts leaves no timer behind", async ({ page }) => {
    // Count the copy status's 2.4 s timers, and hold the clipboard write until the landing has gone.
    await page.addInitScript(() => {
      const w = window as unknown as { statusTimers: number; release?: () => void };
      w.statusTimers = 0;
      const set = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
        if (delay === 2400) w.statusTimers += 1;
        return set(handler, delay, ...rest);
      }) as typeof window.setTimeout;
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => new Promise<void>((done) => (w.release = done)) },
      });
    });
    await open(page);
    await page.locator("#install-panel").click();
    await page.locator(".VPNavBar").getByRole("link", { name: "Docs" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}install$`, "u"));
    // The landing, and its install block, have unmounted.
    await expect(page.locator(".install")).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { release: () => void }).release());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as { statusTimers: number }).statusTimers)).toBe(0);
  });

  test("the install block leaves no window listener behind when the landing unmounts", async ({ page }) => {
    await open(page);
    const session = await page.context().newCDPSession(page);
    const listeners = async () => {
      const { result } = await session.send("Runtime.evaluate", { expression: "window" });
      const { listeners } = await session.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
      return listeners.filter((entry) => entry.type === "archer-install-method").length;
    };
    expect(await listeners()).toBe(1);
    for (let round = 0; round < 3; round += 1) {
      await page.locator(".VPNavBar").getByRole("link", { name: "Docs" }).click();
      await expect(page).toHaveURL(new RegExp(`${base}install$`, "u"));
      await page.goBack();
      await expect(film(page)).toBeVisible();
    }
    expect(await listeners()).toBe(1);
  });
});

test.describe("install", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  test("arrow keys switch npx/curl, Copy copies the full command though the page draws it short", async ({ page }) => {
    await open(page);
    const code = page.locator("#install-panel code");
    await expect(code).toHaveText(NPX);
    await expect(page.locator(".install-note:not(.install-note--ghost)")).toContainText(
      "The copy button copies the full command.",
    );
    const below = () =>
      page.locator(".landing-check").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const before = await below();
    await page.locator("#install-tab-npx").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#install-tab-curl")).toBeFocused();
    await expect(page.locator("#install-tab-curl")).toHaveAttribute("aria-selected", "true");
    await expect(code).toHaveText(CURL);
    expect(await below(), "the longer note moves nothing").toBe(before);
    await page.getByRole("button", { name: "Copy the curl command" }).click();
    await expect(page.locator(".install-status")).toHaveText("Command copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CURL);
  });

  test("the page offers the install once, and Install in the nav goes to it", async ({ page }) => {
    await open(page);
    await expect(page.locator(".install")).toHaveCount(1);
    await expect(page.getByRole("tablist", { name: "Install with" })).toHaveCount(1);
    await page.locator(".VPNavBar").getByRole("link", { name: "Install" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}#install$`, "u"));
    await expect(page.locator("#install-panel")).toBeInViewport();
  });

  test("the script can be read first, at its published address", async ({ page }) => {
    await open(page);
    const read = page.locator(".landing-check").getByRole("link", { name: "install.sh" });
    await expect(read).toHaveAttribute("href", `${base}install.sh`);
    expect((await page.request.get(`${server.origin}${base}install.sh`)).status()).toBe(200);
    await expect(page.locator(".landing-check").getByRole("link", { name: "install guide" })).toHaveAttribute(
      "href",
      `${base}install`,
    );
  });

  test("the terminal is dark in both themes, at readable contrast", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("vitepress-theme-appearance", "light"));
    await open(page);
    const toggle = page.locator(".VPNavBarAppearance .VPSwitchAppearance");
    const colours = () =>
      page.evaluate(() => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = (value: string) => {
          const [r, g, b] = rgb(value).map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const block = document.querySelector(".install")!;
        const under = (element: Element) => {
          for (let at: Element | null = element; at; at = at.parentElement) {
            const fill = getComputedStyle(at).backgroundColor;
            if (!/rgba\(.*,\s*0\)$/u.test(fill) && fill !== "transparent") return lum(fill);
          }
          return lum(getComputedStyle(document.body).backgroundColor);
        };
        const texts = [
          ".install-command code",
          ".install-prompt",
          ".install-tab[aria-selected=true]",
          ".install-tab[aria-selected=false]",
          ".install-copy",
          ".install-title",
        ];
        return {
          dark: document.documentElement.classList.contains("dark"),
          surface: lum(getComputedStyle(block.querySelector(".install-panel")!).backgroundColor),
          contrast: Object.fromEntries(
            texts
              .filter((selector) => block.querySelector(selector))
              .map((selector) => {
                const element = block.querySelector(selector)!;
                return [selector, contrast(under(element), lum(getComputedStyle(element).color))];
              }),
          ),
        };
      });
    const check = async (dark: boolean) => {
      await expect.poll(async () => (await colours()).dark).toBe(dark);
      const now = await colours();
      expect(now.surface, "the terminal's body is dark").toBeLessThan(0.05);
      for (const [selector, ratio] of Object.entries(now.contrast))
        expect(ratio, `${dark ? "dark" : "light"}: ${selector}`).toBeGreaterThanOrEqual(4.5);
    };
    await check(false);
    await toggle.click();
    await check(true);
  });
});

const AGENTS = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  // Playwright guesses Windows client hints for a ChromeOS agent; a phone is the other frame-less case.
  neutral:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
} as const;

test.describe("install terminal", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  /** The frame's box and the parts that must not move when the frame changes from the neutral one. */
  const frame = (page: Page) =>
    page.evaluate(() => {
      const block = document.querySelector(".install")!;
      const box = (selector: string) => block.querySelector(selector)!.getBoundingClientRect().height;
      return {
        os: block.getAttribute("data-os"),
        frame: block.getBoundingClientRect().height,
        bar: box(".install-bar"),
        below:
          document.querySelector(".landing-check")!.getBoundingClientRect().top - block.getBoundingClientRect().top,
      };
    });

  for (const [os, agent] of Object.entries(AGENTS))
    test(`a ${os} reader gets the ${os} frame, at the neutral frame's height`, async ({ browser }) => {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ userAgent: agent, viewport: { width, height: 900 } });
        const page = await context.newPage();
        await open(page);
        await expect.poll(async () => (await frame(page)).os).toBe(os);
        const after = await frame(page);
        // The same box as served (the neutral frame, before any script): swapping it in moves nothing.
        const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
        const served = await plain.newPage();
        await open(served);
        const before = await frame(served);
        expect(before.os, "served without script: the neutral frame").toBe("neutral");
        expect({ ...after, os: "" }, `${width}px`).toEqual({ ...before, os: "" });
        if (os === "mac") await expect(page.locator(".install-lights")).toBeVisible();
        if (os === "windows") {
          await expect(page.locator(".install-tab[aria-selected=true]")).toContainText("Ubuntu (WSL)");
          const note = page.locator(".install-note:not(.install-note--ghost)");
          await expect(note).toContainText("Archer runs in WSL on Windows");
          await expect(note.getByRole("link")).toHaveAttribute("href", `${base}install#windows-wsl`);
        } else
          await expect(page.locator(".install-note:not(.install-note--ghost)")).toContainText(
            "The copy button copies the full command.",
          );
        // Tab names stay the method, whatever the frame wears.
        await expect(page.getByRole("tab", { name: "npx", exact: true })).toBeAttached();
        await context.close();
        await plain.close();
      }
    });

  test("a click anywhere in the terminal copies the full command, and says so", async ({ page }) => {
    await open(page);
    await page.locator("#install-panel").click({ position: { x: 8, y: 8 } });
    await expect(page.locator(".install-status")).toHaveText("Command copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(NPX);
    // The explicit button is still there for the keyboard and screen readers.
    await expect(page.getByRole("button", { name: "Copy the npx command" })).toBeVisible();
    await expect(page.locator(".install-status")).toHaveAttribute("role", "status");
  });

  test("a failed copy is announced and offers the way round", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) } });
    });
    await page.locator("#install-panel").click();
    await expect(page.locator(".install-status")).toHaveText("Copy failed: select the command and copy it");
    await expect(page.locator(".install-status")).toBeVisible();
  });
});

test.describe("How it works", () => {
  test("four steps follow the film, and the repeat is said once", async ({ page }) => {
    await open(page);
    const section = page.getByRole("region", { name: "How it works" });
    await expect(section.locator("ol > li")).toHaveCount(4);
    await expect(section).toContainText("into your repo's .archer/ folder");
    await expect(section).toContainText("Steps 3 and 4 repeat until the picture says what you both mean.");
    const order = await page.evaluate(() =>
      Boolean(
        document.querySelector(".film")!.compareDocumentPosition(document.querySelector("#landing-how-title")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    );
    expect(order, "the steps follow the film").toBe(true);
  });
});
