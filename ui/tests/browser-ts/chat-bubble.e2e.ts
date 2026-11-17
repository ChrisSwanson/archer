// The chat bubble in a real browser (ADR 0034 §10): drag anywhere and stay put, clamp on resize,
// the chat following a drag live, sending (the thread is submitted), the agent's reply and the
// dot, the sidebar beside the walkthrough panel, keyboard use, the phone sheet, reduced motion,
// axe. An isolated project with the walkthrough fixture; never the live service.
import { commentOperation } from "../support/comment-operations";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { agentsOf } from "../support/listener-agent";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env["CHAT_SHOTS"];
// Queued comments: a draft elsewhere must stay a draft while the chat sends only its own thread.
const project = (): Promise<TsProject> => sharedTsProject({ files: walkthroughFiles(), commentSubmission: "queued" });

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await page.mouse.move(700, 450);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
}
const fab = (page: Page) => page.getByRole("button", { name: /^Chat with the agent about/ });
const chat = (page: Page) => page.getByRole("dialog", { name: /Chat with the agent/ });
const box = async (loc: ReturnType<Page["locator"]>) => (await loc.boundingBox())!;
const message = (page: Page) => page.getByRole("textbox", { name: "Message to the agent" });
/** The bubble's one status slot (D7): what happened to the last message, announced, never focused. */
const status = (page: Page) => chat(page).getByRole("status").and(page.getByTestId("chat-status"));
/** 0.7.0 (ADR 0035 §8): the service has listeners, so with no agent session the line says nobody listens, and what to do. */
const NOBODY =
  /^No agent is listening in this checkout\s*Start an agent session in this project; it gets this message first\.$/;
/** A claimed listener between waits: one line. */
const NEXT_TURN = "Waiting for the agent's next turn";
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `s10-${name}.png`) });
}
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  release = true,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  if (release) await page.mouse.up();
}
/** The chat grows out of its bubble for about 200 ms; measure it once it has: shown, with none of its animations running. */
const settled = async (page: Page): Promise<void> => {
  await expect(page.locator(".archer-chat")).toBeVisible();
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          !(
            a.effect instanceof KeyframeEffect &&
            (a.effect.target as HTMLElement | null)?.classList.contains("archer-chat")
          ),
      ),
  );
};
const centre = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

test("it starts at the bottom right of the drawing, clear of the key and the panels", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    const b = await box(fab(page));
    const stage = await box(page.locator(".archer-diagram-content"));
    expect(b.x + b.width).toBeLessThanOrEqual(stage.x + stage.width);
    expect(b.y + b.height).toBeLessThanOrEqual(stage.y + stage.height);
    expect(b.x).toBeGreaterThan(stage.x + stage.width / 2);
    const key = await box(page.locator(".archer-diagram-key"));
    const overlaps =
      b.x < key.x + key.width && b.x + b.width > key.x && b.y < key.y + key.height && b.y + b.height > key.y;
    expect(overlaps).toBe(false);
    await shot(page, "desktop-bubble");
  } finally {
    await server.stop();
  }
});

test("a drop stays exactly where it is put, survives a reload, and a resize keeps it on screen", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    const start = centre(await box(fab(page)));
    await drag(page, start, { x: 480, y: 330 });
    const dropped = centre(await box(fab(page)));
    expect(Math.abs(dropped.x - 480)).toBeLessThanOrEqual(3);
    expect(Math.abs(dropped.y - 330)).toBeLessThanOrEqual(3);
    await expect(chat(page)).toHaveCount(0); // a drag is not a click
    expect(await page.evaluate(() => localStorage.getItem("archer.chat.position"))).not.toBeNull();
    await page.reload();
    await expect(fab(page)).toBeVisible();
    const after = centre(await box(fab(page)));
    expect(Math.abs(after.x - dropped.x)).toBeLessThanOrEqual(3);
    // Past every edge: held fully inside.
    await drag(page, after, { x: 1439, y: 899 });
    const corner = await box(fab(page));
    expect(corner.x + corner.width).toBeLessThanOrEqual(1440);
    expect(corner.y + corner.height).toBeLessThanOrEqual(900);
    await page.setViewportSize({ width: 700, height: 500 });
    await expect
      .poll(async () => {
        const b = await box(fab(page));
        return b.x + b.width <= 700 && b.y + b.height <= 500 && b.x >= 0 && b.y >= 0;
      })
      .toBe(true);
  } finally {
    await server.stop();
  }
});

test("the arrow keys move it, Shift moves it further, Home and the right-click menu return it", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    const home = await box(fab(page));
    await fab(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => Math.round(home.x - (await box(fab(page))).x)).toBe(10);
    await page.keyboard.press("Shift+ArrowUp");
    await expect.poll(async () => Math.round(home.y - (await box(fab(page))).y)).toBe(50);
    await page.keyboard.press("Home");
    await expect.poll(async () => Math.round((await box(fab(page))).x - home.x)).toBe(0);
    await page.keyboard.press("ArrowLeft");
    await fab(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Move to corner/ }).click();
    await expect.poll(async () => Math.round((await box(fab(page))).x - home.x)).toBe(0);
  } finally {
    await server.stop();
  }
});

test("the keyboard alone opens it, sends, moves it and closes it", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await fab(page).focus();
    await page.keyboard.press("Enter");
    await expect(chat(page)).toBeVisible();
    await expect(message(page)).toBeFocused();
    await page.keyboard.type("Is the queue SQS?");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Or Redis?");
    await page.keyboard.press("Enter");
    await expect(status(page)).toHaveText(NOBODY);
    await expect(message(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(chat(page)).toHaveCount(0);
    await expect(fab(page)).toBeFocused();
    // `C` with nothing selected opens it again.
    await page.locator("body").click({ position: { x: 5, y: 450 } });
    await page.keyboard.press("c");
    await expect(chat(page)).toBeVisible();
    await expect(message(page)).toBeFocused();
  } finally {
    await server.stop();
  }
});

test("sending submits that one thread; the agent's reply arrives live and lights the dot when closed", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await fab(page).click();
    // A draft elsewhere stays a draft.
    const origin = new URL(server.url).origin;
    const elsewhere = await server.fetch("api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(
        commentOperation.create({
          target: "view:containers",
          anchor: { kind: "node", id: "api", label: "API" },
          body: "not for the agent yet",
        }),
      ),
    });
    expect(elsewhere.ok).toBe(true);
    await message(page).fill("The queue is SQS, right?");
    await message(page).press("Enter");
    // D7: saved, and waiting for the agent to check (pull delivery); nothing claims delivery or a reply.
    await expect(status(page)).toHaveText(NOBODY);
    await expect(chat(page)).not.toContainText(/\bSent\b|Delivered|Replying/);
    await expect(message(page)).toBeFocused();
    await shot(page, "desktop-chat-saved");
    const inbox = (await server.agentInbox()) as { id: string; revision: number; comments: { body: string }[] }[];
    expect(inbox.map((t) => t.comments[0]?.body)).toEqual(["The queue is SQS, right?"]);
    await expect(status(page)).toHaveText("Read by the agent");
    await page.keyboard.press("Escape");
    await expect(chat(page)).toHaveCount(0);
    await server.agentReply(inbox[0]!.id, "It is SQS; I will fix the diagram.", inbox[0]!.revision);
    await expect(page.getByTestId("chat-unread-dot")).toBeVisible();
    await expect(fab(page)).toHaveAccessibleName(/1 new reply/);
    await shot(page, "desktop-bubble-dot");
    await fab(page).click();
    await expect(page.getByRole("log")).toContainText("It is SQS; I will fix the diagram.");
    await expect(page.getByTestId("chat-unread-dot")).toHaveCount(0);
    await shot(page, "desktop-chat-reply");
  } finally {
    await server.stop();
  }
});

test("the chat follows the bubble live while it is dragged, and is committed on the drop", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await fab(page).click();
    await settled(page);
    const before = await box(chat(page));
    const at = centre(await box(fab(page)));
    await drag(page, at, { x: at.x - 420, y: at.y - 240 }, false);
    const mid = await box(chat(page));
    expect(Math.abs(before.x - mid.x) + Math.abs(before.y - mid.y)).toBeGreaterThan(200);
    const fabMid = await box(fab(page));
    expect(
      mid.x < fabMid.x + fabMid.width &&
        mid.x + mid.width > fabMid.x &&
        mid.y < fabMid.y + fabMid.height &&
        mid.y + mid.height > fabMid.y,
    ).toBe(false);
    expect(await chat(page).evaluate((el) => (el as HTMLElement).style.transform)).toContain("translate");
    await shot(page, "desktop-drag-midframe");
    await page.mouse.up();
    await expect.poll(() => chat(page).evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
    const done = await box(chat(page));
    expect(Math.abs(done.x - mid.x)).toBeLessThanOrEqual(2);
  } finally {
    await server.stop();
  }
});

test("the composer grows upward, with its bottom edge fixed, then scrolls", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await fab(page).click();
    await settled(page);
    const c0 = await box(chat(page));
    const t0 = await box(message(page));
    await message(page).fill(Array.from({ length: 4 }, (_, i) => `line ${i + 1}`).join("\n"));
    const t1 = await box(message(page));
    expect(t1.height).toBeGreaterThan(t0.height);
    expect(Math.abs(t1.y + t1.height - (t0.y + t0.height))).toBeLessThanOrEqual(1);
    await message(page).fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    const t2 = await box(message(page));
    const c2 = await box(chat(page));
    expect(t2.height).toBeLessThanOrEqual(c2.height * 0.41);
    expect(c2.height).toBe(c0.height);
    expect(await message(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect((await box(page.getByRole("log"))).height).toBeGreaterThanOrEqual(70);
    await shot(page, "desktop-long-draft");
  } finally {
    await server.stop();
  }
});

test("expand docks a sidebar beside the diagram panel, resizable and remembered; collapse returns to the bubble", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await page
      .getByRole("group", { name: "Walkthroughs on this diagram" })
      .getByRole("button", { name: /Checkout and payment/ })
      .click();
    await fab(page).click();
    // The chat can talk about the walkthrough or its diagram.
    await expect(
      page.getByRole("group", { name: "Talk about" }).getByRole("button", { name: "Walkthrough" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Expand into a sidebar" }).click();
    const side = page.getByRole("complementary", { name: /Chat with the agent/ });
    await expect(side).toBeVisible();
    await settled(page);
    await expect(fab(page)).toHaveCount(0);
    const walk = await box(page.getByRole("complementary", { name: "Diagram panel" }));
    const sb = await box(side);
    expect(sb.x).toBeGreaterThanOrEqual(walk.x + walk.width - 1); // beside it, never over it
    expect(sb.x + sb.width).toBeLessThanOrEqual(1441);
    expect(sb.height).toBeGreaterThan(500);
    await shot(page, "desktop-sidebar-walk");
    const edge = side.getByRole("separator", { name: /Resize chat sidebar/ });
    await edge.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await box(side)).width).toBeGreaterThan(sb.width + 20);
    await page.reload();
    await fab(page).click();
    await expect(page.getByRole("complementary", { name: /Chat with the agent/ })).toBeVisible(); // the last mode is remembered
    // Grown first: a press while the sidebar still grows (the drawing loading behind it) is released after the button
    // has moved off the pointer, so no click reaches it (the press only focuses it).
    await settled(page);
    await page.getByRole("button", { name: "Collapse to the bubble" }).click();
    await expect(page.getByRole("complementary", { name: /Chat with the agent/ })).toHaveCount(0);
    await expect(fab(page)).toBeVisible();
    await expect(fab(page)).toBeFocused();
  } finally {
    await server.stop();
  }
});

test("the floating window resizes from its free corner and remembers its size", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await fab(page).click();
    await settled(page);
    const before = await box(chat(page));
    const grip = chat(page).getByRole("separator", { name: /Resize chat window/ });
    await grip.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await box(chat(page))).width).toBeGreaterThan(before.width + 20);
    expect((await box(chat(page))).height).toBeGreaterThan(before.height + 20);
    await settled(page);
    const grown = await box(chat(page));
    await page.keyboard.press("Escape");
    await expect(chat(page)).toHaveCount(0);
    await fab(page).click();
    await settled(page);
    expect(Math.abs((await box(chat(page))).width - grown.width)).toBeLessThanOrEqual(1);
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`on a phone the launcher sits above the dock and the chat is a sheet, one at a time: ${scheme}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 400, height: 860 },
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const server = await project();
    // A claimed listener, so the status line is the one-line "next turn" this layout check measures.
    const agents = await agentsOf(server);
    try {
      await agents.claim(await agents.register("Claude Code · phone test"));
      await open(page, server);
      const dock = await box(page.locator(".archer-stage-dock"));
      const b = await box(fab(page));
      expect(b.y + b.height).toBeLessThanOrEqual(dock.y);
      await fab(page).tap();
      const sheet = chat(page);
      await expect(sheet).toBeVisible();
      const s = await box(sheet);
      expect(Math.round(s.x)).toBe(0);
      expect(Math.round(s.width)).toBe(400);
      expect(Math.round(s.y + s.height)).toBe(860);
      await expect(page.getByRole("button", { name: "Expand into a sidebar" })).toHaveCount(0);
      await shot(page, `phone-${scheme}-chat`);
      // The status line fits the sheet, on one line, and the page does not scroll sideways.
      await message(page).fill("Is the queue SQS?");
      await message(page).press("Enter");
      await expect(status(page)).toHaveText(NEXT_TURN);
      const line = await box(status(page));
      expect(line.x).toBeGreaterThanOrEqual(s.x);
      expect(line.x + line.width).toBeLessThanOrEqual(s.x + s.width);
      expect(line.height).toBeLessThan(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(page, `phone-${scheme}-chat-saved`);
    } finally {
      agents.close();
      await server.stop();
      await context.close();
    }
  });
}

test("a chat sheet and a dock sheet are never open together on a phone", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 400, height: 860 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const server = await project();
  try {
    await open(page, server);
    await fab(page).tap();
    await expect(chat(page)).toBeVisible();
    await page.getByRole("button", { name: "Collapse to the bubble" }).tap();
    await expect(chat(page)).toHaveCount(0);
    // The diagram panel's chip (0.6.4, D5): its sheet holds the walkthroughs and the key.
    const keyChip = page.locator(".archer-stage-dock .archer-dock-chip--panel");
    await keyChip.tap();
    await expect(page.locator(".archer-dock-sheet")).toBeVisible();
    // The sheets cover each other's buttons; the events are what the rule is about.
    await fab(page).dispatchEvent("click");
    await expect(chat(page)).toBeVisible();
    await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
    await keyChip.dispatchEvent("click");
    await expect(page.locator(".archer-dock-sheet")).toBeVisible();
    await expect(chat(page)).toHaveCount(0);
  } finally {
    await server.stop();
    await context.close();
  }
});

test("reduced motion: it opens at once, with nothing animating", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const server = await project();
  try {
    await open(page, server);
    await fab(page).click();
    await expect(chat(page)).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) =>
                a.effect instanceof KeyframeEffect &&
                (a.effect.target as HTMLElement | null)?.classList.contains("archer-chat"),
            ).length,
      ),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await expect(chat(page)).toHaveCount(0);
  } finally {
    await server.stop();
    await context.close();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe: closed and open, ${scheme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const server = await project();
    try {
      await open(page, server);
      const closed = await new AxeBuilder({ page }).analyze();
      expect(closed.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
      await fab(page).click();
      await message(page).fill("Hello");
      const floating = await new AxeBuilder({ page }).analyze();
      expect(floating.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
      await page.getByRole("button", { name: "Expand into a sidebar" }).click();
      await expect(page.getByRole("complementary", { name: /Chat with the agent/ })).toBeVisible();
      const side = await new AxeBuilder({ page }).analyze();
      expect(side.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
      await shot(page, `desktop-${scheme}-sidebar-plain`);
    } finally {
      await server.stop();
      await context.close();
    }
  });
}
