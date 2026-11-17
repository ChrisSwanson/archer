// Comments on walkthroughs in a real browser (ADR 0034 §9; the approved prototype is the look): right-click and
// C on a step row, an element comment while stepping carries its step, the server stores the anchors, step rows
// count, a thread names its step, and "?" lists the rows only while a walkthrough is open. An isolated project
// holding slice 1's fixture; never the live service. `WALK_SHOTS=<dir>` also writes the screenshots.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env["WALK_SHOTS"];
const project = (): Promise<TsProject> => sharedTsProject({ files: walkthroughFiles() });

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
}

const panel = (page: Page) => page.getByRole("region", { name: "Walkthrough", exact: true });
const step = (page: Page) => page.getByRole("slider", { name: "Step" });
const row = (page: Page, title: string) =>
  page.locator(".archer-walk-step", { has: page.locator(".archer-walk-step-title", { hasText: title }) });
const discussion = (page: Page) => page.getByRole("region", { name: "Contextual discussion" });
const threads = async (server: TsProject): Promise<{ anchor: Record<string, unknown>; status: string }[]> =>
  (
    (await (await server.fetch("api/comments?target=view:containers", { redirect: "follow" })).json()) as {
      threads: { anchor: Record<string, unknown>; status: string }[];
    }
  ).threads;

async function startDeclined(page: Page, scope: "desktop" | "phone" = "desktop"): Promise<void> {
  const press = async (locator: ReturnType<Page["locator"]>) => (scope === "phone" ? locator.tap() : locator.click());
  await press(page.locator(".archer-walk-open"));
  await press(
    page.getByRole("group", { name: "Walkthroughs on this diagram" }).getByRole("button", { name: /Declined card/ }),
  );
  await expect(step(page)).toHaveValue("1");
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function write(page: Page, text: string): Promise<void> {
  await discussion(page).getByRole("textbox", { name: "Comment" }).fill(text);
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
}

test("right-click and C on step rows comment on the step; a box comment carries the step it was seen on", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await startDeclined(page);

    // Right-click a row: the composer opens for that step, and the service stores a step anchor.
    await row(page, "The card is declined").locator(".archer-walk-head").click({ button: "right" });
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("Step 3 · The card is declined");
    await write(page, "The release is not immediate");
    await expect.poll(async () => (await threads(server)).length).toBe(1);
    expect((await threads(server))[0]!.anchor).toMatchObject({
      kind: "step",
      walkthrough: "declined-card",
      step: "the-card-is-declined",
      label: "3. The card is declined",
    });
    // The row counts it, in the person's blue pin.
    await expect(row(page, "The card is declined").locator(".archer-pin")).toHaveText("1");

    // C on a focused row; the context-menu key does the same.
    await row(page, "Try another card").locator(".archer-walk-head").focus();
    await page.keyboard.press("c");
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("Step 5 · Try another card");
    await page.keyboard.press("Escape");
    await row(page, "Amira checks out").locator(".archer-walk-head").focus();
    await page.keyboard.press("Shift+F10");
    await expect(discussion(page).locator(".primary-floating-context")).toHaveText("Step 1 · Amira checks out");
    await discussion(page).getByRole("button", { name: "Cancel" }).click();

    // A box seen while stepping: the element, with the step.
    await step(page).fill("3");
    await page.locator(".react-flow__node[data-id='api']").click({ button: "right" });
    await write(page, "Why does the API own this?");
    await expect.poll(async () => (await threads(server)).length).toBe(2);
    expect((await threads(server))[1]!.anchor).toMatchObject({
      kind: "node",
      id: "api",
      context: { walkthrough: "declined-card", step: "the-card-is-declined" },
    });
    await expect(
      page.locator(".react-flow__node[data-id='api'] .archer-pin, .archer-pins[data-owner='api'] .archer-pin"),
    ).toBeVisible();
    // The pin stays full strength above the focus fade, on a box the walkthrough has faded: the product of
    // every opacity up to the root. A faded box fades by colour (its words keep their contrast), so the wrapper's own inline opacity marks it.
    const fadedBox = () =>
      page
        .locator(".react-flow__node")
        .evaluateAll(
          (nodes) => nodes.find((n) => (n as HTMLElement).style.opacity === "0.25")?.getAttribute("data-id") ?? null,
        );
    await expect.poll(fadedBox, { message: "a box the step has faded" }).not.toBeNull();
    const faded = await fadedBox();
    // The faded box may be the system frame, whose centre the floating discussion covers: closed first, or the
    // right-click races the panel (seen under load, 0.6.4).
    await discussion(page).getByRole("button", { name: "Close discussion" }).click();
    await expect(discussion(page)).toHaveCount(0);
    await page.locator(`.react-flow__node[data-id='${faded}']`).click({ button: "right" });
    await write(page, "Why is this one in the background?");
    const pin = page.locator(`.archer-pins[data-owner='${faded}'] .archer-pin`);
    await expect(pin).toBeVisible();
    expect(
      await pin.evaluate((el) => {
        let o = 1;
        for (let n: Element | null = el; n !== null; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        return o;
      }),
    ).toBe(1);
    expect(
      await page
        .locator(`.react-flow__node[data-id='${faded}']`)
        .evaluate((n) => Number((n as HTMLElement).style.opacity)),
    ).toBeLessThan(1);
  } finally {
    await server.stop();
  }
});

test("C with nothing selected is about the walkthrough, and ? lists the rows only while one is open", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog").getByText("A step row")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await startDeclined(page);
    await page
      .locator(".react-flow__pane")
      .click({ position: { x: 5, y: 5 } })
      .catch(() => undefined);
    await page.keyboard.press("c");
    // Nothing selected: the chat opens (slice 10), about the walkthrough while one is open.
    const chat = page.getByRole("dialog", { name: /Chat with the agent/ });
    await expect(chat).toBeVisible();
    await expect(chat.getByRole("button", { name: "Walkthrough" })).toHaveAttribute("aria-pressed", "true");
    await expect(chat.getByRole("log")).toContainText("about this walkthrough");
    await expect(discussion(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(chat).toHaveCount(0);
    await panel(page)
      .getByRole("button", { name: /Amira checks out/ })
      .focus();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog").getByText("A step row")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("A Sequence message")).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("a step thread names its step, and the chip opens it", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await server.agentCreateComment(
      "view:containers",
      { kind: "step", walkthrough: "declined-card", step: "the-card-is-declined", label: "" },
      "Check the webhook signature.",
    );
    await startDeclined(page);
    // The agent's thread may open its discussion by itself; the badge opens it when it has not.
    if (!(await discussion(page).isVisible())) await row(page, "The card is declined").locator(".archer-pin").click();
    await expect(discussion(page).getByRole("button", { name: "Walkthrough · step 3" })).toBeVisible();
    await discussion(page).getByRole("button", { name: "Walkthrough · step 3" }).click();
    await expect(step(page)).toHaveValue("3");
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`a step discussion follows inserted content in an unchanged panel (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const server = await project();
    try {
      await open(page, server);
      await startDeclined(page);
      const target = row(page, "Amira checks out");
      await target.locator(".archer-walk-head").click({ button: "right" });
      await expect(discussion(page).getByRole("textbox", { name: "Comment" })).toBeVisible();
      const positions = () =>
        page.evaluate(() => {
          const anchor = document
            .querySelector('.archer-walk-step[data-step-id="amira-checks-out"]')!
            .getBoundingClientRect();
          const bubble = document.querySelector(".primary-floating-discussion")!.getBoundingClientRect();
          const panel = document.querySelector(".archer-diagram-panel")!.getBoundingClientRect();
          return { anchor: anchor.top, bubble: bubble.top, panel: { width: panel.width, height: panel.height } };
        });
      const before = await positions();
      await shot(page, `step-follow-${scheme}-before`);
      await target.evaluate((anchor) => {
        const preceding = document.createElement("li");
        preceding.style.height = "100px";
        preceding.setAttribute("role", "presentation");
        anchor.before(preceding);
      });
      await expect.poll(async () => (await positions()).anchor - before.anchor).toBeGreaterThan(0);
      const movement = (await positions()).anchor - before.anchor;
      await expect.poll(async () => (await positions()).bubble - before.bubble).toBeCloseTo(movement, 0);
      const after = await positions();
      expect(after.panel).toEqual(before.panel);
      await shot(page, `step-follow-${scheme}-after`);
    } finally {
      await server.stop();
    }
  });
}

for (const scope of ["desktop", "phone"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screens: ${scope} ${scheme}`, async ({ browser }) => {
      test.skip(SHOTS === undefined, "set WALK_SHOTS to write screenshots");
      test.setTimeout(150_000);
      const context = await browser.newContext({
        colorScheme: scheme,
        ...(scope === "phone" ? { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true } : {}),
      });
      const page = await context.newPage();
      const server = await project();
      try {
        await open(page, server);
        await server.agentCreateComment(
          "view:containers",
          { kind: "step", walkthrough: "declined-card", step: "the-card-is-declined", label: "" },
          "Say the webhook's signature is checked.",
        );
        await server.agentCreateComment(
          "view:containers",
          {
            kind: "node",
            id: "api",
            label: "",
            context: { walkthrough: "declined-card", step: "the-card-is-declined" },
          },
          "Why does the API own this?",
        );
        await startDeclined(page, scope);
        await page.keyboard.press("ArrowDown").catch(() => undefined);
        await shot(page, `s9p-${scope}-${scheme}-rows`);
        const target = row(page, "Try another card").locator(".archer-walk-head");
        if (scope === "desktop") await target.click({ button: "right" });
        else {
          await target.focus();
          await page.keyboard.press("c");
        }
        await expect(discussion(page).getByRole("textbox", { name: "Comment" })).toBeVisible();
        await shot(page, `s9p-${scope}-${scheme}-composer-step`);
        await discussion(page).getByRole("button", { name: "Cancel" }).click();
        const boxPin = page.locator(".react-flow__node[data-id='api'] .archer-pin");
        await boxPin.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        if (await discussion(page).isVisible()) {
          await shot(page, `s9p-${scope}-${scheme}-box-pin-thread`);
          await discussion(page).getByRole("button", { name: "Close discussion" }).click();
        }
        // A phone's sheet closes behind a discussion: reopen it to reach the rows.
        if (scope === "phone" && !(await row(page, "The card is declined").isVisible()))
          await page.locator(".archer-dock-chip--panel").tap();
        await row(page, "The card is declined").locator(".archer-pin").click({ force: true, timeout: 10_000 });
        await expect(discussion(page).getByRole("button", { name: "Walkthrough · step 3" })).toBeVisible();
        await shot(page, `s9p-${scope}-${scheme}-step-thread-chip`);
        await discussion(page).getByRole("button", { name: "Close discussion" }).click();
        if (scope === "desktop") {
          await page.keyboard.press("?");
          await expect(page.getByRole("dialog").getByText("A step row")).toBeVisible();
          await shot(page, `s9p-${scope}-${scheme}-help`);
        }
      } finally {
        await server.stop();
        await context.close();
      }
    });
  }
}
