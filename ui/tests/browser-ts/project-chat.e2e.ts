// The project conversation in a real browser (wave 2, ticket 08; ADR 0034 §10 as amended): the bubble on the
// project and folder pages is the project's chat; on a diagram or note page it has a "This diagram / Whole
// project" switch; every message reaches the agent with the page it was sent from. An isolated project and
// the real service; never the live one.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml": 'version = 1\nname = "Shop"\ndescription = "An online shop."\n',
  ".archer/diagrams/flows/checkout.mmd": "flowchart LR\n basket[Basket] e1@--> pay[Payment]\n",
  ".archer/diagrams/context.mmd": "flowchart LR\n shop[Shop] e1@--> bank[Bank]\n",
  ".archer/notes/operations.md": "# Operations\n\nRunning the shop.\n",
};
let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

type Seen = {
  target?: string;
  anchor?: { kind?: string };
  status?: string;
  comments?: { author: string; body: string; context?: { page: string; document?: string } }[];
};

async function start(page: Page): Promise<string> {
  server = await sharedTsProject({ files });
  await page.goto(server.agentUrl);
  return new URL(server.agentUrl).pathname.split("/")[2]!;
}
async function visit(page: Page, slug: string, path: string): Promise<void> {
  await page.goto(new URL(`/projects/${slug}/${path}`, server!.agentUrl).href);
}
const fab = (page: Page, about: string | RegExp) =>
  page.getByRole("button", { name: typeof about === "string" ? `Chat with the agent about ${about}` : about });
const box = (page: Page) => page.getByRole("textbox", { name: "Message to the agent" });
const talk = (page: Page) => page.getByRole("group", { name: "Talk about" });
async function say(page: Page, text: string): Promise<void> {
  await box(page).fill(text);
  await box(page).press("Enter");
}
const inbox = async (): Promise<Seen[]> => (await server!.agentInbox()) as Seen[];
const threadOn = async (target: string): Promise<Seen | undefined> => (await inbox()).find((t) => t.target === target);

test("the project page's bubble is the project's chat, and the agent receives the message with the page it came from", async ({
  page,
}) => {
  const slug = await start(page);
  await visit(page, slug, "");
  await expect(fab(page, "Shop")).toBeVisible();
  await fab(page, "Shop").click();
  const dialog = page.getByRole("dialog", { name: /Chat with the agent\s+Shop/ });
  await expect(dialog).toBeVisible();
  await expect(talk(page)).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("Nothing yet. Ask the agent about the whole project.");
  await say(page, "Is the worker idempotent?");
  await expect(page.getByRole("log")).toContainText("Is the worker idempotent?");
  // D7 as of 0.7.0 (ADR 0035 §8): no agent session claimed this checkout, so the line says so and what to do;
  // nothing claims delivery.
  const status = dialog.getByRole("status").and(page.getByTestId("chat-status"));
  await expect(status).toHaveText(
    /^No agent is listening in this checkout\s*Start an agent session in this project; it gets this message first\.$/,
  );
  await expect(box(page)).toBeFocused();
  await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(1);
  const thread = (await threadOn("project:"))!;
  expect(thread.anchor?.kind).toBe("project");
  expect(thread.comments![0]).toMatchObject({
    author: "person",
    body: "Is the worker idempotent?",
    context: { page: `/projects/${slug}/` },
  });
  expect(thread.comments![0]!.context).not.toHaveProperty("document");
  // Never the access token, however the page was reached.
  expect(JSON.stringify(thread)).not.toMatch(/token/i);
  await expect(status).toHaveText("Read by the agent");
});

test("the same conversation continues on a folder page, and the agent's reply arrives in it", async ({ page }) => {
  const slug = await start(page);
  await visit(page, slug, "");
  await fab(page, "Shop").click();
  await say(page, "First, on the project page");
  await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(1);
  await visit(page, slug, "diagrams/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await fab(page, "Shop").click();
  await expect(page.getByRole("log")).toContainText("First, on the project page");
  await say(page, "Then, on a folder");
  await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(2);
  const thread = (await threadOn("project:"))!;
  expect(thread.comments![1]!.context).toEqual({ page: `/projects/${slug}/diagrams/` });
  const id = (thread as { id: string }).id;
  await server!.agentReply(id, "Yes: the worker keys each job.", (thread as { revision: number }).revision);
  await expect(page.getByRole("log")).toContainText("Yes: the worker keys each job.");
});

test("the search page has the project's chat too, and says it was sent from search", async ({ page }) => {
  const slug = await start(page);
  // Words: an empty search on a project is the project's own page, so it is named with words (O172).
  await visit(page, slug, "?q=worker");
  await expect(page.getByRole("searchbox", { name: "Search projects and files" })).toHaveValue("worker");
  expect(new URL(page.url()).search).toBe("?q=worker");
  await fab(page, "Shop").click();
  await say(page, "From search");
  await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(1);
  expect((await threadOn("project:"))!.comments![0]!.context).toEqual({ page: `/projects/${slug}/?search` });
});

test("on a diagram page the switch picks the diagram or the whole project, and each message names the file", async ({
  page,
}) => {
  const slug = await start(page);
  await visit(page, slug, "diagrams/context.mmd");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await fab(page, /^Chat with the agent about/).click();
  const switcher = talk(page);
  await expect(switcher.getByRole("button", { name: "This diagram" })).toHaveAttribute("aria-pressed", "true");
  await expect(switcher.getByRole("button", { name: "Whole project" })).toHaveAttribute("aria-pressed", "false");
  await say(page, "About this diagram");
  await expect.poll(async () => (await inbox()).filter((t) => t.target?.startsWith("view:")).length).toBe(1);
  const onDiagram = (await inbox()).find((t) => t.target?.startsWith("view:"))!;
  expect(onDiagram.comments![0]!.context).toEqual({
    page: `/projects/${slug}/diagrams/context.mmd`,
    document: ".archer/diagrams/context.mmd",
  });
  await switcher.getByRole("button", { name: "Whole project" }).click();
  await expect(page.getByRole("dialog")).toContainText("Shop");
  await expect(page.getByRole("log")).toContainText("Nothing yet. Ask the agent about the whole project.");
  await say(page, "About the whole project, asked from a diagram");
  await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(1);
  expect((await threadOn("project:"))!.comments![0]!.context).toEqual({
    page: `/projects/${slug}/diagrams/context.mmd`,
    document: ".archer/diagrams/context.mmd",
  });
  // The diagram's own conversation is where it was left.
  await switcher.getByRole("button", { name: "This diagram" }).click();
  await expect(page.getByRole("log")).toContainText("About this diagram");
  await expect(page.getByRole("log")).not.toContainText("whole project, asked");
});

test("on a note page it says 'This note', and a project message names the note", async ({ page }) => {
  const slug = await start(page);
  await visit(page, slug, "notes/operations.md");
  await expect(page.getByRole("article", { name: /Reading Operations/ })).toBeVisible();
  await fab(page, /^Chat with the agent about Operations/).click();
  await expect(talk(page).getByRole("button", { name: "This note" })).toHaveAttribute("aria-pressed", "true");
  await talk(page).getByRole("button", { name: "Whole project" }).click();
  await say(page, "From a note");
  await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(1);
  const where = (await threadOn("project:"))!.comments![0]!.context!;
  expect(where.page).toBe(`/projects/${slug}/notes/operations.md`);
  expect(where.document).toBe(".archer/notes/operations.md");
});

test("the bubble keeps the corner on the project page, inside the window, and the chat passes axe", async ({
  page,
}) => {
  const slug = await start(page);
  await visit(page, slug, "");
  const b = (await fab(page, "Shop").boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(1440);
  expect(b.y + b.height).toBeLessThanOrEqual(900);
  expect(b.x).toBeGreaterThan(900);
  await fab(page, "Shop").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("the project page's chat is a bottom sheet, and sends", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const slug = await start(page);
    await visit(page, slug, "");
    await fab(page, "Shop").tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const d = (await dialog.boundingBox())!;
    expect(d.y + d.height).toBeLessThanOrEqual(844 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await say(page, "From a phone");
    await expect.poll(async () => (await threadOn("project:"))?.comments?.length).toBe(1);
  });
});
