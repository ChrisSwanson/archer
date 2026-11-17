/**
 * The pairing code in a real browser against the real service (ADR 0014, amended 2026-10-22 and
 * 2026-10-31): the base address without a credential shows the code form; the form posts the code (never
 * in a URL) and a correct one answers one 303 to the projects page with a new grant's HttpOnly session
 * cookie; mistakes and limits answer the form again saying what to do. Desktop and phone width, keyboard
 * only, axe, no CSP violation, and the form without its script.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const PAGE = testPage();
let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(): Promise<TsProject> {
  server = await startTsProject({
    pagePath: PAGE,
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/diagrams/system.mmd"\n',
      ".archer/diagrams/system.mmd": "flowchart LR\n sys[System] e1@--> ext[Partner]\n",
    },
  });
  return server;
}

const field = (page: Page) => page.getByRole("textbox", { name: "Enter your pairing code" });
/** Press Open and wait for the answer's page (the form is an ordinary POST: each answer is a new document). */
async function submit(page: Page): Promise<void> {
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Open" }).click()]);
}
/** Every CSP report the page's documents make, from the console (Chromium logs each refused load, script or form). */
function cspReports(page: Page): string[] {
  const reports: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) reports.push(message.text());
  });
  return reports;
}
const wrongOf = (code: string): string => `${code.slice(0, -1)}${code.endsWith("Z") ? "Y" : "Z"}`;

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width}px a typed code opens the projects page with a revocable grant`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const csp = cspReports(page);
    const server = await start();
    const { code, url } = await server.issuePairingCode();
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1, name: "Open Archer" })).toBeVisible();
    await expect(field(page)).toBeFocused();
    // The form fits the width: no horizontal scroll, the button at least 44px tall and on screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const button = await page.getByRole("button", { name: "Open" }).boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);

    // Typed loosely, lower case and without the dash: shown upper case with the dash.
    await page.keyboard.type(code.replace("-", "").toLowerCase());
    await expect(field(page)).toHaveValue(code);
    const answer = page.waitForResponse((response) => new URL(response.url()).pathname === "/-/pair");
    await page.keyboard.press("Enter");
    // One 303 to a clean address, carrying the session cookie; the code is in no address.
    const exchange = await answer;
    expect(exchange.status()).toBe(303);
    expect(exchange.headers()["location"]).toBe("/projects/");
    expect(exchange.request().postData()).toMatch(/^code=/);
    await page.waitForURL(/\/projects\/$/);
    await expect(page.getByText("System").first()).toBeVisible();
    expect(page.url()).not.toContain(code.slice(0, 4));
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(csp).toEqual([]);
    const grant = (await server.listAccess()).find((entry) => entry.label.startsWith("Paired "));
    expect(grant?.revokedAt).toBeNull();

    // The same code again, from a fresh browser context, says it was used.
    const other = await page.context().browser()!.newPage();
    try {
      await other.goto(url);
      await field(other).fill(code);
      await submit(other);
      await expect(other.getByRole("alert")).toHaveText(/already used/);
      await expect(field(other)).toHaveAttribute("aria-invalid", "true");
    } finally {
      await other.close();
    }
  });
}

test("a wrong code says so; too many wrong codes say to wait; a malformed one is caught before sending", async ({
  page,
}) => {
  const server = await start();
  const { code, url } = await server.issuePairingCode();
  await page.goto(url);
  await field(page).fill("ABC");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/Not a valid code: it has 8 letters and digits/);
  for (let i = 0; i < 5; i++) {
    await field(page).fill(wrongOf(code));
    await submit(page);
    await expect(page.getByRole("alert")).toHaveText(/Not a valid code\. Check it/);
    await expect(field(page)).toHaveAttribute("aria-invalid", "true");
    await expect(field(page)).toBeFocused();
    await expect(page.getByRole("button", { name: "Open" })).toBeEnabled();
  }
  await field(page).fill(code);
  await submit(page);
  await expect(page.getByRole("alert")).toHaveText(/Too many tries: wait a minute/);
  await expect(field(page)).toBeFocused();
  // Typing again clears the old reason.
  await page.keyboard.type("a");
  await expect(page.getByRole("alert")).toHaveText("");
  // The answer's page is the form itself: axe holds there too.
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test("a refused page address links to the code form", async ({ page }) => {
  const server = await start();
  const name = new URL(server.agentUrl).pathname.split("/")[2]!;
  await page.goto(new URL(`/projects/${name}/`, server.agentUrl).href);
  await page.getByRole("link", { name: "Enter it here" }).click();
  await expect(field(page)).toBeVisible();
});

test("without the script, the form still pairs, and no code is in any address", async ({ browser }) => {
  const server = await start();
  const { code, url } = await server.issuePairingCode();
  const scriptless = async (typed: string, check: (page: Page) => Promise<void>): Promise<void> => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await field(page).fill(typed);
      await submit(page);
      await check(page);
      expect(page.url()).not.toContain(code.slice(0, 4));
    } finally {
      await context.close();
    }
  };
  // Typed loosely: the service reads it as the script would have shown it.
  await scriptless(code.replace("-", "").toLowerCase(), (page) => page.waitForURL(/\/projects\/$/));
  // A refused code answers the form again with the reason, without the script.
  await scriptless(code, (page) => expect(page.getByRole("alert")).toHaveText(/already used/));
  expect((await server.listAccess()).filter((entry) => entry.label.startsWith("Paired "))).toHaveLength(1);
});
