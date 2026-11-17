// Diagram modes (0.6.4, D1–D4; ADR 0034 §6–7 amendment): a walkthrough step is a pure function of the step,
// so Previous, a jump, a replay and a reopen draw the same picture; every way out (✕, Escape from anywhere,
// the mode switcher, a click off the path, the phone sheet's ✕, the agent presenting without one) puts the
// person's view back as it was before the walkthrough. Isolated projects; never the live service.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TsProject } from "../support/ts-service";
import { nestedWalkthroughFiles } from "../support/nested-walkthrough-project";
import { walkthroughFiles } from "../support/walkthrough-project";
import { chooseComment } from "./support/element-menu";
import { settled } from "./support/settled";
import { sharedTsProject } from "./support/shared-service";

const nested = (): Promise<TsProject> => sharedTsProject({ nestedView: true, files: nestedWalkthroughFiles() });

async function open(page: Page, server: TsProject, view = "shop"): Promise<void> {
  await server.present(view);
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // Off the sidebar's hover edge (archer-ui-verification, class 3).
  await page.mouse.move(700, 450);
}

const step = (page: Page) => page.getByRole("slider", { name: "Step" });
const panel = (page: Page) => page.getByRole("region", { name: "Walkthrough", exact: true });

async function start(page: Page, title: RegExp): Promise<void> {
  await page.locator(".archer-walk-open").click();
  await page.getByRole("group", { name: "Walkthroughs on this diagram" }).getByRole("button", { name: title }).click();
  await expect(step(page)).toHaveValue("1");
}

async function goTo(page: Page, n: number): Promise<void> {
  await step(page).fill(String(n));
  await expect(step(page)).toHaveValue(String(n));
}

type Camera = { x: number; y: number; zoom: number };
async function camera(page: Page): Promise<Camera> {
  return page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform);
    return { x: Math.round(m.e * 2) / 2, y: Math.round(m.f * 2) / 2, zoom: Math.round(m.a * 1000) / 1000 };
  });
}

/**
 * The containers drawn open: their frames. Not the "−" toggles, which the canvas hides at a zoom too
 * small to read (a phone's step framing, O29), so they read as "nothing open" there.
 */
async function openSet(page: Page): Promise<string[]> {
  return page
    .locator(".react-flow__node-archer-frame")
    .evaluateAll((all) => all.map((n) => n.getAttribute("data-id")!).sort());
}

type Picture = { open: string[]; camera: Camera };
/**
 * What is on screen once it stops moving: the open set and the camera, read with the page at rest (laid out,
 * framed, camera still, no frame opening: `settled`) and the same on three such reads running, so a glide that
 * had not yet begun at the first read is waited for too.
 */
async function picture(page: Page): Promise<Picture> {
  let last = "";
  let still = 0;
  await expect
    .poll(
      async () => {
        await settled(page);
        const now = JSON.stringify({ open: await openSet(page), camera: await camera(page) });
        still = now === last ? still + 1 : 0;
        last = now;
        return still;
      },
      { timeout: 8000, intervals: [50] },
    )
    .toBeGreaterThan(1);
  return JSON.parse(last) as Picture;
}

test.describe("a step is the same picture however it is reached (D2)", () => {
  test("stepping on to the last step and back to the first draws the first visit again; a jump matches too", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      await start(page, /Order a book/);
      const first: Picture[] = [await picture(page)];
      for (const n of [2, 3, 4]) {
        await goTo(page, n);
        first.push(await picture(page));
      }
      const previous = page.getByRole("button", { name: "Previous step" }).first();
      for (const n of [3, 2, 1]) {
        await previous.click();
        await expect(step(page)).toHaveValue(String(n));
        expect(await picture(page), `step ${n} reached by Previous`).toEqual(first[n - 1]);
      }
      await goTo(page, 4);
      await goTo(page, 2);
      expect(await picture(page), "step 2 reached by a jump").toEqual(first[1]);
    } finally {
      await server.stop();
    }
  });

  test("a replay from step 1 matches the first run, and the person's own +/− holds for that step only", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      await start(page, /Order a book/);
      const run = async (): Promise<Picture[]> => {
        const out: Picture[] = [await picture(page)];
        for (const n of [2, 3, 4]) {
          await goTo(page, n);
          out.push(await picture(page));
        }
        return out;
      };
      const first = await run();
      await page.getByRole("button", { name: "First step" }).first().click();
      await expect(step(page)).toHaveValue("1");
      expect(await run(), "the replay").toEqual(first);
      // The person opens API on step 1: it holds for the step, and the next visit to step 1 is the walkthrough's again.
      await goTo(page, 1);
      await page.getByRole("button", { name: "Open API", exact: true }).click();
      await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
      await page.waitForTimeout(400);
      await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
      await goTo(page, 2);
      await goTo(page, 1);
      expect(await picture(page)).toEqual(first[0]);
    } finally {
      await server.stop();
    }
  });
});

test.describe("every way out restores the view (D3)", () => {
  test("✕ puts back the person's open set and camera; reopening is the first run again", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      // The person's own view: Web shop opened by hand.
      await page.getByRole("button", { name: "Open Web shop" }).click();
      await expect(page.getByRole("button", { name: "Close Web shop" })).toBeVisible();
      const before = await picture(page);
      await start(page, /Order, nothing recorded/);
      const at1 = await picture(page);
      await goTo(page, 4);
      await picture(page);
      const close = panel(page).getByRole("button", { name: "Close walkthrough" });
      await expect(close).toHaveText("");
      expect(await close.locator("svg path").getAttribute("d"), "a ✕, not a chevron").toMatch(/^M6 6l12 12M18 6 6 18$/);
      await close.click();
      await expect(panel(page)).toHaveCount(0);
      expect(await picture(page), "the view before the walkthrough").toEqual(before);
      await start(page, /Order, nothing recorded/);
      expect(await picture(page), "reopened: the first run's step 1").toEqual(at1);
    } finally {
      await server.stop();
    }
  });

  test("Escape from the canvas leaves and restores; the mode switcher does too; Help says so", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      const before = await picture(page);
      await start(page, /Order a book/);
      await goTo(page, 3);
      await picture(page);
      // Focus outside the panel: on the page itself.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
      expect(await picture(page)).toEqual(before);

      // The switcher stays on screen while one is open, pressed; pressing it leaves.
      await start(page, /Order a book/);
      await goTo(page, 2);
      const switcher = page
        .getByRole("group", { name: "Show on the diagram" })
        .getByRole("button", { name: /Walkthroughs · 2/ });
      await expect(switcher).toHaveAttribute("aria-pressed", "true");
      await switcher.click();
      await expect(panel(page)).toHaveCount(0);
      expect(await picture(page)).toEqual(before);

      await start(page, /Order a book/);
      await page.keyboard.press("?");
      const help = page.getByRole("dialog");
      await expect(help.getByText("Leave the walkthrough; the view comes back as it was")).toBeVisible();
    } finally {
      await server.stop();
    }
  });

  test("on a phone, the sheet's ✕ leaves the walkthrough and restores the view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const server = await nested();
    try {
      await open(page, server);
      const before = await openSet(page);
      await page.locator(".archer-dock-chip--panel").click();
      await page
        .getByRole("group", { name: "Walkthroughs on this diagram" })
        .getByRole("button", { name: /Order a book/ })
        .click();
      await goTo(page, 2);
      expect((await picture(page)).open, "step 2 opens API").toEqual(["api", "shop"]);
      await page.locator(".archer-dock-sheet-close").click();
      await expect(page.getByRole("region", { name: "Walkthrough", exact: true })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Step controls" })).toHaveCount(0);
      await expect.poll(() => openSet(page)).toEqual(before);
    } finally {
      await server.stop();
    }
  });
});

test.describe("a click off the path leaves the walkthrough (D4)", () => {
  test("the element is selected at full strength, and a comment written next keeps where the person was", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await open(page, server, "containers");
      const before = await picture(page);
      await start(page, /Declined card/);
      await goTo(page, 3);
      const worker = page.locator(".react-flow__node[data-id='worker']");
      await expect.poll(() => worker.evaluate((n) => (n as HTMLElement).style.opacity)).toBe("0.25");
      // On the path: jumps, and stays.
      await page.locator(".react-flow__node[data-id='web']").click();
      await expect(step(page)).toHaveValue("1");
      await goTo(page, 3);
      // Off the path, with the pointer that selects (the hand selects nothing, and only steps): leaves.
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      const atStep = await picture(page);
      expect(atStep.camera, "the step framed itself (else the camera check below proves nothing)").not.toEqual(
        before.camera,
      );
      await expect(worker).toBeInViewport();
      await worker.click();
      await expect(panel(page)).toHaveCount(0);
      await expect(worker).toHaveClass(/selected/);
      await expect.poll(() => worker.evaluate((n) => (n as HTMLElement).style.opacity)).not.toBe("0.25");
      // D4b: the camera stays where the person was looking.
      expect((await picture(page)).camera, "the camera stays on a click-out").toEqual(atStep.camera);
      await page.keyboard.press("c");
      const discussion = page.getByRole("region", { name: "Contextual discussion" });
      await discussion.getByRole("textbox", { name: "Comment" }).fill("Why is the worker not in this?");
      await discussion.getByRole("button", { name: "Add comment" }).click();
      const threads = async (): Promise<{ anchor: Record<string, unknown> }[]> =>
        (
          (await (await server.fetch("api/comments?target=view:containers")).json()) as {
            threads: { anchor: Record<string, unknown> }[];
          }
        ).threads;
      await expect.poll(async () => (await threads()).length).toBe(1);
      expect((await threads())[0]!.anchor).toMatchObject({
        kind: "node",
        id: "worker",
        context: { walkthrough: "declined-card", step: "the-card-is-declined" },
      });
    } finally {
      await server.stop();
    }
  });
});

test.describe("a click off the path keeps the camera (D4b)", () => {
  test("nested: the dimming goes, the clicked element's containers stay open, the camera stays; ✕ still restores it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      const before = await picture(page);
      await start(page, /Order a book/);
      // Step 3 (Checkout → Orders) draws Catalog on screen, off the path; step 2 frames it below the canvas.
      await goTo(page, 3);
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      const atStep = await picture(page);
      expect(atStep.camera, "the step framed itself").not.toEqual(before.camera);
      const catalog = page.locator(".react-flow__node[data-id='catalog']");
      await expect.poll(() => catalog.evaluate((n) => (n as HTMLElement).style.opacity)).toBe("0.25");
      // On screen, as a person needs it: off it, Playwright scrolls the canvas to reach it (O29).
      await expect(catalog).toBeInViewport();
      await catalog.click();
      await expect(panel(page)).toHaveCount(0);
      await expect(catalog).toHaveClass(/selected/);
      await expect.poll(() => catalog.evaluate((n) => (n as HTMLElement).style.opacity)).not.toBe("0.25");
      const after = await picture(page);
      expect(after.camera, "the camera stays on a click-out").toEqual(atStep.camera);
      expect(after.open, "Catalog's containers stay open, so it stays drawn").toEqual(
        expect.arrayContaining(["api", "shop"]),
      );
      await expect(catalog).toHaveClass(/selected/);

      // ✕ (and Escape, the switcher: D3 above) still put the camera back.
      await start(page, /Order a book/);
      await goTo(page, 2);
      await picture(page);
      await panel(page).getByRole("button", { name: "Close walkthrough" }).click();
      await expect(panel(page)).toHaveCount(0);
      expect((await picture(page)).camera, "✕ restores the camera").toEqual(after.camera);
    } finally {
      await server.stop();
    }
  });
});

test.describe("the agent (D1 rules)", () => {
  test("a presentation with a walkthrough saves the person's view; a later one without restores it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      await page.getByRole("button", { name: "Open Web shop" }).click();
      await page.getByRole("button", { name: "Open API", exact: true }).click();
      await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close API", exact: true }).click();
      await expect(page.getByRole("button", { name: "Open API", exact: true })).toBeVisible();
      const before = await openSet(page);
      await server.present("shop", "Here is the order", { id: "order", step: 3 });
      await expect(panel(page)).toContainText("Presented by the agent");
      await expect(step(page)).toHaveValue("3");
      await expect(page.getByRole("button", { name: "Close API", exact: true })).toBeVisible();
      await server.present("shop", "Back to the shop");
      await expect(panel(page)).toHaveCount(0);
      await expect.poll(() => openSet(page)).toEqual(before);
    } finally {
      await server.stop();
    }
  });
});

// Review fixes (0.6.4 review, Claude and Codex): each of these failed before its fix.
const slugOf = (server: TsProject): string =>
  new URL(server.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const diagramUrl = (server: TsProject, file: string, query = ""): string =>
  `${new URL(server.url).origin}/projects/${slugOf(server)}/${file}${query}`;
async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.mouse.move(700, 450);
}
const threadsOf = async (server: TsProject, view: string): Promise<{ anchor: Record<string, unknown> }[]> =>
  (
    (await (await server.fetch(`api/comments?target=view:${view}`)).json()) as {
      threads: { anchor: Record<string, unknown> }[];
    }
  ).threads;
async function addComment(page: Page, body: string): Promise<void> {
  const discussion = page.getByRole("region", { name: "Contextual discussion" });
  await discussion.getByRole("textbox", { name: "Comment" }).fill(body);
  await discussion.getByRole("button", { name: "Add comment" }).click();
}

test.describe("restoring the view, whatever happened during the walkthrough", () => {
  test("Edit mid-walkthrough: the edit address carries no walkthrough, and Cancel brings back the view from before", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await page.goto((await server.issueAuthoringAccess("modes edit")).url);
      await visit(page, diagramUrl(server, "shop.mmd"));
      // The person's own camera, not the opening fit (which a fresh mount would give back anyway).
      await page.getByRole("button", { name: "Zoom in" }).click();
      const before = await picture(page);
      await start(page, /Order a book/);
      await goTo(page, 3);
      expect((await picture(page)).camera).not.toEqual(before.camera);
      await page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
      const query = new URL(page.url()).searchParams;
      expect(
        [query.has("edit"), query.has("walkthrough"), query.has("step")],
        "edit, walkthrough, step in the edit address",
      ).toEqual([true, false, false]);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("region", { name: "Diagram Editor" })).toHaveCount(0);
      expect(await picture(page)).toEqual(before);
    } finally {
      await server.stop();
    }
  });

  test("switching to the whole diagram during a walkthrough: leaving puts the nested view, its open set and camera back", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      const nestedView = page.getByRole("button", { name: "Nested view" });
      await expect(nestedView).toHaveAttribute("aria-pressed", "true");
      const before = await picture(page);
      await start(page, /Order a book/);
      await goTo(page, 3);
      await picture(page);
      await nestedView.click();
      await expect(nestedView).toHaveAttribute("aria-pressed", "false");
      await picture(page);
      await panel(page).getByRole("button", { name: "Close walkthrough" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(nestedView).toHaveAttribute("aria-pressed", "true");
      expect(await picture(page)).toEqual(before);
    } finally {
      await server.stop();
    }
  });

  test("a live redraw during the walkthrough (the same presentation, recompiled) does not stop the camera coming back", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      // The page's own presentation (no agent's), so the recompile re-presents it under the same id, viewport kept.
      await page.goto(server.url);
      await visit(page, diagramUrl(server, "shop.mmd"));
      await page.getByRole("button", { name: "Zoom in" }).click();
      const before = await picture(page);
      await start(page, /Order a book/);
      await goTo(page, 3);
      await picture(page);
      const source = nestedWalkthroughFiles()[".archer/shop.mmd"]!;
      // The redraw: the same presentation, recompiled, drawn again (the viewport kept).
      await server.agentWrite(
        "shop",
        ".archer/shop.mmd",
        source.replace('"Lists products"', '"Lists every product"'),
        "Catalog's description",
      );
      await expect(page.locator(".react-flow__node[data-id='catalog']")).toContainText("Lists every product");
      await expect(step(page)).toHaveValue("3");
      await picture(page);
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
      expect(await picture(page)).toEqual(before);
    } finally {
      await server.stop();
    }
  });

  test("a walkthrough opened from a link: leaving fits the diagram as a plain visit opens it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await page.goto(server.url);
      await visit(page, diagramUrl(server, "shop.mmd"));
      const plain = await picture(page);
      await visit(page, diagramUrl(server, "shop.mmd", "?walkthrough=order&step=3"));
      await expect(step(page)).toHaveValue("3");
      expect((await picture(page)).camera).not.toEqual(plain.camera);
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
      expect(await picture(page)).toEqual(plain);
    } finally {
      await server.stop();
    }
  });
});

test.describe("Escape, layered", () => {
  test("the first Escape leaves the walkthrough and keeps the selection; the second clears it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await open(page, server, "containers");
      await start(page, /Declined card/);
      await goTo(page, 3);
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      const web = page.locator(".react-flow__node[data-id='web']");
      await web.click();
      await expect(step(page)).toHaveValue("1");
      await expect(web).toHaveClass(/selected/);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
      await expect(web).toHaveClass(/selected/);
      await page.keyboard.press("Escape");
      await expect(web).not.toHaveClass(/selected/);
    } finally {
      await server.stop();
    }
  });

  test("on a phone, Escape on the Step slider under the drawing leaves the walkthrough", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const server = await nested();
    try {
      await open(page, server);
      await page.locator(".archer-dock-chip--panel").click();
      await page
        .getByRole("group", { name: "Walkthroughs on this diagram" })
        .getByRole("button", { name: /Order a book/ })
        .click();
      await goTo(page, 2);
      // Fold the sheet: a press outside it.
      await page.mouse.click(195, 300);
      await expect(page.getByRole("region", { name: "Walkthrough", exact: true })).toHaveCount(0);
      const below = page.getByRole("group", { name: "Step controls" }).getByRole("slider", { name: "Step" });
      await expect(below).toBeVisible();
      await below.focus();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("group", { name: "Step controls" })).toHaveCount(0);
    } finally {
      await server.stop();
    }
  });
});

test.describe("a comment after a click-out keeps where the person was (ADR 0034 §9)", () => {
  async function clickOut(page: Page, server: TsProject): Promise<void> {
    await open(page, server, "containers");
    await start(page, /Declined card/);
    await goTo(page, 3);
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await page.locator(".react-flow__node[data-id='worker']").click();
    await expect(panel(page)).toHaveCount(0);
  }

  test("Project review → New comment on the clicked element carries the context", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await clickOut(page, server);
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await page
        .getByRole("region", { name: "Project Review", exact: true })
        .getByRole("button", { name: "New comment" })
        .click();
      await addComment(page, "From the review panel");
      await expect.poll(async () => (await threadsOf(server, "containers")).length).toBe(1);
      expect((await threadsOf(server, "containers"))[0]!.anchor).toMatchObject({
        kind: "node",
        id: "worker",
        context: { walkthrough: "declined-card", step: "the-card-is-declined" },
      });
    } finally {
      await server.stop();
    }
  });

  test("a Shift-click off the path after an on-path select: the comment on both carries the context", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await open(page, server, "containers");
      await start(page, /Declined card/);
      await goTo(page, 3);
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await page.locator(".react-flow__node[data-id='web']").click();
      await expect(step(page)).toHaveValue("1");
      await page.locator(".react-flow__node[data-id='worker']").click({ modifiers: ["Shift"] });
      await expect(panel(page)).toHaveCount(0);
      await expect(page.locator(".react-flow__node[data-id='web']")).toHaveClass(/selected/);
      await page.keyboard.press("c");
      await addComment(page, "Both of these");
      await expect.poll(async () => (await threadsOf(server, "containers")).length).toBe(1);
      expect((await threadsOf(server, "containers"))[0]!.anchor).toMatchObject({
        kind: "selection",
        context: { walkthrough: "declined-card", step: "amira-checks-out" },
      });
    } finally {
      await server.stop();
    }
  });

  test("right-clicking another element after a click-out: that comment has no context", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await clickOut(page, server);
      // An element in sight, as a person would right-click it, and in none of the walkthrough's steps. (Email lies
      // below this framing: a right-click on it landed only while Playwright's scroll of the canvas' clipped wrapper
      // outlasted React Flow's reset of that scroll, which load reverses, O52.)
      await page.locator(".react-flow__node[data-id='staff']").click({ button: "right" });
      await chooseComment(page);
      await addComment(page, "About staff, from Explore");
      await expect.poll(async () => (await threadsOf(server, "containers")).length).toBe(1);
      const anchor = (await threadsOf(server, "containers"))[0]!.anchor;
      expect(anchor).toMatchObject({ kind: "node", id: "staff" });
      expect(anchor.context).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test("the agent inserting a step after the click-out: the context still names the step the person was on", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await clickOut(page, server);
      const sidecar = JSON.parse(readFileSync(join(server.root, ".archer/containers.walkthroughs.json"), "utf8")) as {
        walkthroughs: { id: string; steps: { id: string; title: string }[] }[];
      };
      const declined = sidecar.walkthroughs.find((w) => w.id === "declined-card")!;
      declined.steps.unshift({ ...declined.steps[0]!, id: "a-new-first-step", title: "A new first step" });
      writeFileSync(join(server.root, ".archer/containers.walkthroughs.json"), JSON.stringify(sidecar));
      await expect(
        page
          .getByRole("group", { name: "Walkthroughs on this diagram" })
          .getByRole("button", { name: /Declined card/ }),
      ).toContainText("6 steps");
      await expect(page.locator(".react-flow__node[data-id='worker']")).toHaveClass(/selected/);
      await page.keyboard.press("c");
      await addComment(page, "Still about step 3 as it was");
      await expect.poll(async () => (await threadsOf(server, "containers")).length).toBe(1);
      expect((await threadsOf(server, "containers"))[0]!.anchor).toMatchObject({
        kind: "node",
        id: "worker",
        context: { walkthrough: "declined-card", step: "the-card-is-declined" },
      });
    } finally {
      await server.stop();
    }
  });
});

test.describe("one side panel at a time", () => {
  test("Project review takes the panel's place, its list hidden beneath; the agent presenting a walkthrough closes Project review", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await nested();
    try {
      await open(page, server);
      const review = page.getByRole("region", { name: "Project Review", exact: true });
      const list = page.getByRole("group", { name: "Walkthroughs on this diagram" });
      await expect(list).toBeVisible();
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await expect(review).toBeVisible();
      // The review takes the diagram panel's cell in place of its content (review-host.ts): the list fades
      // out beneath it and cannot be chosen while it is open. (This test once chose from that list, which held only in
      // the 180 ms fade, O53.) Closing the review gives the list back, and choosing from it opens the walkthrough.
      await expect(list).toBeHidden();
      await review.getByRole("button", { name: "Close project review" }).click();
      await list.getByRole("button", { name: /Order a book/ }).click();
      await expect(panel(page)).toBeVisible();
      await expect(review).toHaveCount(0);
      await panel(page).getByRole("button", { name: "Close walkthrough" }).click();
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await expect(review).toBeVisible();
      await server.present("shop", "Here is the order", { id: "order", step: 2 });
      await expect(panel(page)).toBeVisible();
      await expect(review).toHaveCount(0);
    } finally {
      await server.stop();
    }
  });
});

test.describe("the agent's highlights under a walkthrough", () => {
  test("replaced under the same id while a walkthrough is open: offered", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    const highlights = (nodes: string[]) => [
      {
        id: "focus",
        title: "Checkout path",
        groups: [{ id: "a", style: "highlight", label: "Shop API", description: "Takes the order.", nodes }],
      },
    ];
    try {
      await open(page, server, "containers");
      await server.setEmphasis("containers", highlights(["api"]));
      await page
        .getByRole("group", { name: "Show on the diagram" })
        .getByRole("button", { name: /Walkthroughs/ })
        .click();
      await page
        .getByRole("group", { name: "Walkthroughs on this diagram" })
        .getByRole("button", { name: /Declined card/ })
        .click();
      await expect(step(page)).toHaveValue("1");
      const offer = page.getByRole("button", { name: "Show highlights", exact: true });
      await expect(offer).toHaveCount(0);
      // The same snapshot heard again offering nothing is pinned in diagram-mode.test.tsx.
      await server.setEmphasis("containers", highlights(["api", "db"]));
      await expect(offer).toBeVisible();
    } finally {
      await server.stop();
    }
  });
});

test.describe("leaving puts back the off-screen cue with the camera (J4-F1)", () => {
  test('the opening framing\'s "N more … Show all" is there again after ✕, the camera back where it was', async ({
    page,
  }) => {
    // Narrow enough that the opening framing leaves part of the drawing off screen.
    await page.setViewportSize({ width: 1100, height: 640 });
    const server = await sharedTsProject({ files: walkthroughFiles() });
    try {
      await open(page, server, "containers");
      const cue = page.getByRole("button", { name: /more (to the right|to the left|above|below).*\. Show all$/ });
      await expect(
        cue,
        "the opening framing leaves part of the drawing off screen (else this proves nothing)",
      ).toBeVisible();
      const said = await cue.getAttribute("aria-label");
      const before = await picture(page);
      await start(page, /Checkout and payment/);
      await goTo(page, 3);
      await picture(page);
      await panel(page).getByRole("button", { name: "Close walkthrough" }).click();
      await expect(panel(page)).toHaveCount(0);
      expect((await picture(page)).camera, "the camera is back").toEqual(before.camera);
      await expect(cue).toBeVisible();
      await expect(cue).toHaveAttribute("aria-label", said!);
    } finally {
      await server.stop();
    }
  });
});
