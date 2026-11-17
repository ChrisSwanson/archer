// The follow camera and the nested view's rules for walkthroughs (ADR 0034 §6, slice 5; the approved
// prototype's round 3 is the look): the camera glides to each step and stops following when the person
// moves the canvas; a step opens the containers it needs; a container the person closes stays closed
// for the step, with a note that opens it. An isolated project with the nested C4 fixture; never the
// live service.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startTsProject, type TsProject } from "../support/ts-service";
import { nestedWalkthroughFiles } from "../support/nested-walkthrough-project";
import { testPage } from "./support/page-path";

/** Screenshots for the hand-off, when asked for (`WALK_SHOTS=<dir>`). */
const SHOTS = process.env["WALK_SHOTS"];
const project = (): Promise<TsProject> =>
  startTsProject({ nestedView: true, pagePath: testPage(), files: nestedWalkthroughFiles() });

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("shop");
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

const step = (page: Page) => page.getByRole("slider", { name: "Step" });
const follow = (page: Page) => page.getByRole("button", { name: "Follow steps" });

async function start(page: Page, title: RegExp): Promise<void> {
  await page.locator(".archer-walk-open").click();
  await page.getByRole("group", { name: "Walkthroughs on this diagram" }).getByRole("button", { name: title }).click();
  await expect(step(page)).toHaveValue("1");
}

async function goTo(page: Page, n: number): Promise<void> {
  await step(page).fill(String(n));
  await expect(step(page)).toHaveValue(String(n));
}

/** The camera: translate and scale of the flow's viewport. */
async function camera(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform);
    return { x: m.e, y: m.f, zoom: m.a };
  });
}

/** The camera has stopped: the same for a few frames running. */
async function settledCamera(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  let last = JSON.stringify(await camera(page));
  let still = 0;
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await camera(page));
        still = now === last ? still + 1 : 0;
        last = now;
        return still;
      },
      { timeout: 5000, intervals: [80] },
    )
    .toBeGreaterThan(4);
  return JSON.parse(last) as { x: number; y: number; zoom: number };
}

/** A node is wholly inside the canvas. */
async function inView(page: Page, id: string): Promise<boolean> {
  return page.evaluate((nodeId) => {
    const node = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)?.getBoundingClientRect();
    const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
    return (
      node !== undefined &&
      pane !== undefined &&
      node.left >= pane.left &&
      node.right <= pane.right &&
      node.top >= pane.top &&
      node.bottom <= pane.bottom
    );
  }, id);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

test("following glides to each step and pauses when the person moves the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await start(page, /Order, nothing recorded/);
    await expect(follow(page)).toHaveAttribute("aria-pressed", "true");
    await goTo(page, 2);
    const at2 = await settledCamera(page);
    await goTo(page, 4);
    const at4 = await settledCamera(page);
    expect(at4, "the camera moved to the next step").not.toEqual(at2);
    expect(await inView(page, "checkout")).toBe(true);
    expect(await inView(page, "payments")).toBe(true);
    // The person scrolls the canvas: following pauses and the camera stays where they put it.
    const box = (await page.locator(".react-flow__pane").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
    await expect(follow(page)).toHaveAttribute("aria-pressed", "false");
    const moved = await settledCamera(page);
    await goTo(page, 3);
    await page.waitForTimeout(900);
    expect(await camera(page)).toEqual(moved);
    // Turning it back on goes to the step at once.
    await follow(page).click();
    await expect(follow(page)).toHaveAttribute("aria-pressed", "true");
    const back = await settledCamera(page);
    expect(back).not.toEqual(moved);
    expect(await inView(page, "orders")).toBe(true);
  } finally {
    await server.stop();
  }
});

test("reduced motion jumps instead of gliding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await start(page, /Order, nothing recorded/);
    await goTo(page, 2);
    await settledCamera(page);
    await page.evaluate(() => {
      (window as unknown as { frames: string[] }).frames = [];
    });
    await goTo(page, 4);
    // Sampled on the frames after the step changed: a glide would show intermediate cameras.
    const seen = await page.evaluate(
      () =>
        new Promise<string[]>((done) => {
          const out: string[] = [];
          let n = 0;
          const tick = (): void => {
            out.push(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform);
            if (++n < 24) requestAnimationFrame(tick);
            else done(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(new Set(seen.slice(4)).size, "no intermediate cameras").toBe(1);
  } finally {
    await server.stop();
  }
});

test("a step opens the containers it needs, from the recorded start; the person's close stays for the step", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await expect(page.getByRole("button", { name: "Open Web shop" })).toBeVisible();
    await start(page, /Order a book/);
    // The recorded open set: Web shop open, API closed.
    await expect(page.getByRole("button", { name: "Close Web shop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open API", exact: true })).toBeVisible();
    await shot(page, "s5-step1");
    // Step 2 is inside API: it opens, then the camera follows.
    await goTo(page, 2);
    await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
    await expect(page.locator(".react-flow__node[data-id='checkout']")).toBeVisible();
    await settledCamera(page);
    expect(await inView(page, "checkout")).toBe(true);
    expect(await inView(page, "web")).toBe(true);
    await shot(page, "s5-nested-opened");
    // The person closes API: the step is drawn on the closed box, with a note; nothing reopens.
    await page.getByRole("button", { name: "Close API", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open API", exact: true })).toBeVisible();
    const note = page.getByRole("button", { name: "Open API to see the detail" });
    await expect(note).toBeVisible();
    await expect(page.locator(".archer-emph").filter({ hasText: "API" }).first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByRole("button", { name: "Open API", exact: true })).toBeVisible();
    await shot(page, "s5-closed-note");
    // The note opens it.
    await note.click();
    await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
    await expect(note).toHaveCount(0);
    // Closed again, then the next step reopens it (following is on).
    await page.getByRole("button", { name: "Close API", exact: true }).click();
    await expect(note).toBeVisible();
    await goTo(page, 3);
    await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
    await expect(note).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("with following off nothing opens by itself, and the note offers it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await start(page, /Order a book/);
    await follow(page).click();
    await expect(follow(page)).toHaveAttribute("aria-pressed", "false");
    await goTo(page, 2);
    await page.waitForTimeout(700);
    await expect(page.getByRole("button", { name: "Open API", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open API to see the detail" })).toBeVisible();
    // Turning following on opens what the step needs.
    await follow(page).click();
    await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("the full view has nothing to open: the camera still follows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await page.getByRole("button", { name: "Nested view" }).click();
    await expect(page.getByRole("button", { name: "Close API", exact: true })).toHaveCount(0);
    await start(page, /Order, nothing recorded/);
    await goTo(page, 2);
    await settledCamera(page);
    expect(await inView(page, "checkout")).toBe(true);
  } finally {
    await server.stop();
  }
});

// Smoothness (`WALK_FRAMES=1`): rAF frame times over three step changes, with the camera following and
// with following off (the cost of the step's redraw alone). Prints; asserts only that frames kept coming.
test("frame times across three step changes", async ({ page }) => {
  test.skip(process.env["WALK_FRAMES"] === undefined, "measurement only: WALK_FRAMES=1");
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await start(page, /Order, nothing recorded/);
    const run = async (label: string): Promise<void> => {
      await goTo(page, 1);
      await settledCamera(page);
      await page.evaluate(() => {
        const w = window as unknown as { times: number[]; running: boolean };
        w.times = [];
        w.running = true;
        let last = performance.now();
        const tick = (now: number): void => {
          w.times.push(now - last);
          last = now;
          if (w.running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      for (const n of [2, 3, 4]) {
        await goTo(page, n);
        await page.waitForTimeout(900);
      }
      const times = await page.evaluate(() => {
        const w = window as unknown as { times: number[]; running: boolean };
        w.running = false;
        return w.times.slice(1);
      });
      const sorted = [...times].sort((a, b) => a - b);
      console.log(
        `${label}: frames ${times.length}, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1)} ms, worst ${sorted.at(-1)!.toFixed(1)} ms`,
      );
      console.log(
        `${label}: slow frames ${times
          .map((t, i) => (t > 40 ? `#${i}:${t.toFixed(0)}` : ""))
          .filter(Boolean)
          .join(" ")}`,
      );
      expect(times.length).toBeGreaterThan(60);
    };
    await follow(page).click(); // off: the step's redraw alone
    await run("follow off");
    await follow(page).click(); // on
    await run("follow on ");
  } finally {
    await server.stop();
  }
});

// The hand-off screenshots (`WALK_SHOTS=<dir>`): desktop and phone, light and dark: a step followed at
// zoom, a nested step opened for it, and the closed-container note.
for (const [device, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 400, height: 860 }],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshots: ${device} ${scheme}`, async ({ browser }) => {
      test.skip(SHOTS === undefined, "hand-off screenshots: WALK_SHOTS=<dir>");
      const context = await browser.newContext({
        viewport: size,
        colorScheme: scheme,
        reducedMotion: "reduce",
        ...(device === "phone" ? { hasTouch: true, isMobile: true } : {}),
      });
      const page = await context.newPage();
      const server = await project();
      try {
        await open(page, server);
        await page.locator(".archer-walk-open").click();
        await page
          .getByRole("group", { name: "Walkthroughs on this diagram" })
          .getByRole("button", { name: /Order a book/ })
          .click();
        // The sheet covers the graph on a phone: closed for the pictures, the bar under the graph steps.
        // Folded to its chip by a tap outside (the sheet's ✕ would leave the walkthrough, D3).
        if (device === "phone") await page.locator(".react-flow__pane").tap({ position: { x: 8, y: 8 } });
        const next = page.getByRole("button", { name: "Next step" }).first();
        const to = async (n: number): Promise<void> => {
          while (Number(await step(page).inputValue()) < n) {
            await next.click();
            await page.waitForTimeout(120);
          }
          await settledCamera(page);
        };
        const look = async (name: string): Promise<void> => {
          await page.waitForTimeout(250);
          await shot(page, `s5-${device}-${scheme}-${name}`);
        };
        await to(1);
        await look("1-followed");
        await to(2);
        await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
        await look("2-opened");
        await page.getByRole("button", { name: "Close API", exact: true }).click();
        await expect(page.getByRole("button", { name: "Open API to see the detail" })).toBeVisible();
        await look("3-closed-note");
      } finally {
        await server.stop();
        await context.close();
      }
    });
  }
}
