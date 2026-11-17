// The chat's recipient and delivery states in a real browser (ADR 0035 §7–8), against the TypeScript service
// with its listener routes answered by the test (the service side is built apart): the three honest lines,
// the picker by keyboard, Launch, nothing moving when the listing arrives, the phone sheet and axe. The
// service's `listeners` event reaches the chat as the window event the stream bridge raises (unit-tested
// in chat-listeners-bridge.test.ts); here the test raises it.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env["CHAT_SHOTS"];
const agent = (id: string, label: string, host = "claude-code") => ({
  agentId: id,
  root: "/r",
  cwd: "/r",
  host,
  label,
  lastActive: "2026-10-26T10:00:00.000Z",
});
const CLAUDE = agent("a1", "Claude Code · ~/code/archer");
const CODEX = agent("a2", "Codex · ~/code/archer", "codex");
const WT = agent("w1", "Claude Code · ~/code/archer-wt");
const listing = (state: "listening" | "next-turn" | "none", extra: Record<string, unknown> = {}) => ({
  current: {
    root: "/r",
    state,
    listener: state === "none" ? null : CLAUDE,
    pinnedByPerson: false,
    agents: state === "none" ? [] : [CLAUDE, CODEX],
  },
  otherCheckouts: [
    { root: "/r-wt", name: "worktree wt", state: "next-turn", listener: WT, pinnedByPerson: false, agents: [WT] },
  ],
  // The service says this viewer is the person (decision 23); a test of anyone else overrides it.
  personal: true,
  ...extra,
});

type Calls = { list: number; pins: unknown[]; launches: unknown[] };
/** The service with listeners: the capability on the bootstrap, and the three routes answered here. */
async function withListeners(page: Page, first: unknown, hold?: Promise<void>): Promise<Calls> {
  const calls: Calls = { list: 0, pins: [], launches: [] };
  await page.route(/\/api\/bootstrap(\?|$)/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { capabilities?: Record<string, unknown> } | null;
    await route.fulfill({
      response,
      json: { ...body, capabilities: { ...(body?.capabilities ?? {}), listeners: true } },
    });
  });
  await page.route(/\/api\/listeners(\/pin|\/launch)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/pin")) {
      calls.pins.push(route.request().postDataJSON());
      await route.fulfill({
        json: { ...(first as { current: object }).current, listener: CODEX, pinnedByPerson: true },
      });
      return;
    }
    if (url.pathname.endsWith("/launch")) {
      calls.launches.push(route.request().postDataJSON());
      await route.fulfill({ json: { launched: true } });
      return;
    }
    calls.list += 1;
    if (hold !== undefined) await hold;
    await route.fulfill({ json: first });
  });
  return calls;
}
const project = (): Promise<TsProject> => sharedTsProject({ files: walkthroughFiles() });
async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await page.mouse.move(700, 450);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
}
const fab = (page: Page) => page.getByRole("button", { name: /^Chat with the agent about/ });
const chat = (page: Page) => page.locator(".archer-chat");
const status = (page: Page) => page.getByTestId("chat-status");
const picker = (page: Page) => page.getByRole("button", { name: /^To / });
const message = (page: Page) => page.getByRole("textbox", { name: "Message to the agent" });
/** Raises the `listeners` event as the service sends it: never `personal` or `launcher` (the person's GET only). */
const announce = (page: Page, detail: Record<string, unknown>) => {
  const { personal: _p, launcher: _l, ...event } = detail;
  return page.evaluate((d) => window.dispatchEvent(new CustomEvent("archer:listeners", { detail: d })), event);
};
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `listeners-${name}.png`) });
}
/** The chat grows out of its bubble for about 200 ms: measure it once none of its animations run. */
const settled = async (page: Page): Promise<void> => {
  await expect(chat(page)).toBeVisible();
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
async function send(page: Page, text: string): Promise<void> {
  await message(page).fill(text);
  await message(page).press("Enter");
}

test("the line says the listing's state: listening, the next turn, nobody with what to do; nothing moves when it arrives", async ({
  page,
}) => {
  const server = await project();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const calls = await withListeners(page, listing("listening"), held);
  try {
    await open(page, server);
    expect(calls.list).toBe(0); // read only when the chat opens
    await fab(page).click();
    await expect(picker(page)).toBeDisabled();
    await settled(page);
    const before = await page.locator(".archer-chat-log").boundingBox();
    release();
    await expect(picker(page)).toHaveAccessibleName("To Claude Code · ~/code/archer");
    const after = await page.locator(".archer-chat-log").boundingBox();
    expect(after!.y).toBe(before!.y);
    await send(page, "Is the queue SQS?");
    await expect(status(page)).toHaveText("Listening · Claude Code");
    await shot(page, "listening");
    await announce(page, listing("next-turn"));
    await expect(status(page)).toHaveText("Waiting for the agent's next turn");
    await expect(chat(page)).not.toContainText("Listening ·");
    await announce(page, listing("none"));
    await expect(status(page)).toContainText("No agent is listening in this checkout");
    await expect(status(page)).toContainText("Start an agent session in this project");
    await expect(page.getByRole("button", { name: "Launch an agent" })).toHaveCount(0);
    await shot(page, "none");
    expect(calls.list).toBe(1);
    // The page never scrolls.
    expect(await page.evaluate(() => document.documentElement.scrollHeight === window.innerHeight)).toBe(true);
  } finally {
    await server.stop();
  }
});

test("the picker works by keyboard alone, shows other checkouts as information, and pins the choice", async ({
  page,
}) => {
  const server = await project();
  const calls = await withListeners(page, listing("listening"));
  try {
    await open(page, server);
    await fab(page).click();
    await expect(picker(page)).toBeEnabled();
    await picker(page).focus();
    await page.keyboard.press("ArrowDown");
    const list = page.getByRole("listbox", { name: "Send messages to" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("group", { name: "This checkout" }).getByRole("option")).toHaveCount(2);
    // Another checkout's listener: said, never offered (decision 15).
    await expect(list.getByRole("option")).toHaveCount(2);
    await expect(page.getByRole("list", { name: "Other checkouts" }).getByRole("listitem")).toHaveText(
      /^Listening in worktree wt.*archer-wt · next turn$/,
    );
    await expect(list.getByRole("option", { name: /Claude Code · ~\/code\/archer\b/ }).first()).toBeFocused();
    // The list opens over the conversation, inside the chat and the window.
    const box = (await list.boundingBox())!,
      panel = (await chat(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
    await shot(page, "picker");
    const axe = await new AxeBuilder({ page }).include(".archer-chat").analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(picker(page)).toBeFocused();
    await expect.poll(() => calls.pins).toEqual([{ agentId: "a2" }]);
    await expect(picker(page)).toHaveAccessibleName("To Codex · ~/code/archer");
    // Escape closes the list, not the chat.
    await page.keyboard.press("Enter");
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(chat(page)).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("Launch shows only while nobody listens and a launcher is configured, and launches the waiting thread", async ({
  page,
}) => {
  const server = await project();
  const calls = await withListeners(page, listing("none", { launcher: true }));
  try {
    await open(page, server);
    await fab(page).click();
    await send(page, "Please draw the queue");
    const launch = page.getByRole("button", { name: "Launch an agent" });
    await expect(launch).toBeVisible();
    await launch.click();
    await expect.poll(() => calls.launches.length).toBe(1);
    expect(calls.launches[0]).toMatchObject({ threadId: expect.any(String) });
    await expect(page.getByRole("alert")).toContainText("Asked your launch command");
    await expect(status(page)).toContainText("No agent is listening in this checkout");
    await announce(page, listing("next-turn", { launcher: true }));
    await expect(launch).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("the delivery order's step fits the status line, and while an agent starts there is no Launch (ADR 0035, amended 2026-10-31)", async ({
  page,
}) => {
  const server = await project();
  await withListeners(page, listing("none", { launcher: true }));
  try {
    await open(page, server);
    await fab(page).click();
    const posted = page.waitForResponse(
      (response) => response.request().method() === "POST" && /\/api\/comments$/.test(new URL(response.url()).pathname),
    );
    await send(page, "Please draw the queue");
    // The chat's create is an ADR 0016 operation (O100): its answer is the receipt, with the thread it made.
    const threadId = ((await (await posted).json()) as { thread: { id: string } }).thread.id;
    expect(threadId).toEqual(expect.any(String));
    await expect(page.getByRole("button", { name: "Launch an agent" })).toBeVisible();
    const until = new Date(Date.now() + 120_000).toISOString();
    await announce(
      page,
      listing("next-turn", { pending: [{ threadId, step: "next-turn", host: "claude-code", waitMs: 120_000, until }] }),
    );
    await expect(status(page)).toHaveText("Waiting 2 min for Claude Code's next turn, then launching an agent");
    // The longer line wraps inside the chat: nothing overflows the panel or is cut off.
    const fits = await page.evaluate(() => {
      const line = document.querySelector<HTMLElement>("[data-testid='chat-status']")!,
        panel = document.querySelector<HTMLElement>(".archer-chat")!;
      const a = line.getBoundingClientRect(),
        b = panel.getBoundingClientRect();
      return { inside: a.left >= b.left && a.right <= b.right, unclipped: line.scrollWidth <= line.clientWidth };
    });
    expect(fits).toEqual({ inside: true, unclipped: true });
    await shot(page, "next-turn-step");
    await announce(page, listing("none", { pending: [{ threadId, step: "launching", until }] }));
    await expect(status(page)).toHaveText("Starting an agent for this message…");
    await expect(page.getByRole("button", { name: /Launch/ })).toHaveCount(0);
    // The step ends without an agent: today's Launch is back for the person.
    await announce(page, listing("none"));
    await expect(page.getByRole("button", { name: "Launch an agent" })).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("without personal true the row is text and there is no Launch, and an event does not change that", async ({
  page,
}) => {
  const server = await project();
  await withListeners(page, listing("none", { launcher: true, personal: undefined }));
  try {
    await open(page, server);
    await fab(page).click();
    await send(page, "Please draw the queue");
    await expect(status(page)).toContainText("No agent is listening in this checkout");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Launch/ })).toHaveCount(0);
    await announce(page, listing("none", { agents: [CODEX] }));
    await expect(status(page)).toContainText("No agent is listening in this checkout");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Launch/ })).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("a same-state listing keeps a pressed Launch waiting", async ({ page }) => {
  const server = await project();
  const calls = await withListeners(page, listing("none", { launcher: true }));
  try {
    await open(page, server);
    await fab(page).click();
    await send(page, "Please draw the queue");
    await page.getByRole("button", { name: "Launch an agent" }).click();
    await expect.poll(() => calls.launches.length).toBe(1);
    await announce(page, listing("none", { launcher: true }));
    await expect(page.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
  } finally {
    await server.stop();
  }
});

test("a listing read that keeps failing says it can't tell, not checking", async ({ page }) => {
  const server = await project();
  await withListeners(page, listing("listening"));
  let reads = 0;
  await page.route(/\/api\/listeners$/, async (route: Route) => {
    reads += 1;
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "busy" } } });
  });
  try {
    await open(page, server);
    await fab(page).click();
    await send(page, "Is the queue SQS?");
    await expect(status(page)).toHaveText("Sent · checking whether an agent is listening");
    // Three retries over about seven seconds, then it says so.
    await expect(status(page)).toHaveText("Sent · can't tell whether an agent is listening", { timeout: 15_000 });
    expect(reads).toBe(4);
    await expect(picker(page)).toHaveAccessibleName("To Can't tell who is listening");
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`on a phone the recipient row fits the sheet and its list stays on screen: ${scheme}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    const server = await project();
    await withListeners(page, listing("listening"));
    try {
      await server.present("containers");
      await page.goto(server.url);
      await fab(page).click();
      await expect(picker(page)).toBeEnabled();
      await picker(page).click();
      const list = page.getByRole("listbox");
      await expect(list).toBeVisible();
      const box = (await list.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      expect(box.y + box.height).toBeLessThanOrEqual(740);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const axe = await new AxeBuilder({ page }).include(".archer-chat").analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
      await shot(page, `phone-${scheme}`);
    } finally {
      await server.stop();
      await context.close();
    }
  });
}
