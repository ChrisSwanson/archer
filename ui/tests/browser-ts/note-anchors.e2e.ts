/** Real selection -> production service persistence -> live note reconciliation. */
import { files as projectPage } from "./support/primary-navigation";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const FLOW = "flowchart LR\n a[Client] e1@--> b[API]\n";
const note = (body: string) => `---\ntitle: Auth\ndiagrams: [../system.mmd]\n---\n${body}\n`;
let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function open(page: Page, markdown: string): Promise<Locator> {
  // These tests follow a passage comment from draft to sent: comments queued (the default sends each at once).
  server = await sharedTsProject({
    commentSubmission: "queued",
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
      ".archer/system.mmd": FLOW,
      ".archer/notes/auth.md": note(markdown),
    },
  });
  await page.goto(server.url);
  await server.present("system"); // isolated fixture; never the owner's demo
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(2);
  await (await projectPage(page)).getByRole("button", { name: "auth.md", exact: true }).click();
  await expect(page.getByRole("article", { name: "Reading auth.md" })).toBeVisible();
  const body = page.getByRole("document", { name: "Note: auth.md" });
  await expect(body).toBeVisible();
  return body;
}

async function select(body: Locator, quote: string): Promise<void> {
  await body.evaluate((root, words) => {
    const start = root.textContent!.indexOf(words);
    if (start < 0) throw new Error(`rendered passage missing: ${words}`);
    const end = start + words.length;
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let began = false;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const length = node.textContent!.length;
      if (!began && start < offset + length) {
        range.setStart(node, start - offset);
        began = true;
      }
      if (began && end <= offset + length) {
        range.setEnd(node, end - offset);
        break;
      }
      offset += length;
    }
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, quote);
}

async function comment(page: Page, body: Locator, quote: string): Promise<Locator> {
  await select(body, quote);
  const compose = page.getByRole("button", { name: "Comment on selection", exact: true });
  await expect(compose).toBeEnabled();
  await compose.click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Please clarify this passage.");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  const thread = page.getByRole("article", { name: /Passage/ });
  await expect(thread.getByText("Please clarify this passage.")).toBeVisible();
  await expect(thread.getByText("Draft", { exact: true })).toBeVisible();
  await expect(thread.getByText("Orphaned", { exact: true })).toHaveCount(0);
  await expect(body.locator("mark.archer-passage")).toHaveText(quote);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const persisted = JSON.parse(readFileSync(join(server!.root, ".archer/notes/auth.comments.json"), "utf8"));
  expect(persisted.threads).toHaveLength(1);
  expect(persisted.threads[0]).toMatchObject({ status: "draft", revision: 1, anchor: { kind: "passage", quote } });
  return thread;
}

for (const [name, markdown, quote] of [
  ["HTML entity", "Fish &amp; chips.", "Fish & chips"],
  ["reference link", "The [API][api] accepts tokens.\n\n[api]: https://example.com", "API"],
  ["escaped punctuation", "The \\*token\\* is literal.", "*token*"],
] as const) {
  test(`a selected rendered ${name} saves and marks its real passage`, async ({ page }) => {
    const body = await open(page, markdown);
    await comment(page, body, quote);
  });
}

test("a nearby edit keeps the unchanged passage and Show control; removal orphans it", async ({ page }) => {
  const body = await open(page, "The client sends a token to the API.");
  const thread = await comment(page, body, "sends a token");
  writeFileSync(join(server!.root, ".archer/notes/auth.md"), note("The new client sends a token to the API."));
  await expect(body).toContainText("The new client");
  const mark = body.locator("mark.archer-passage");
  await expect(mark).toHaveText("sends a token");
  await expect(thread.getByText("Orphaned", { exact: true })).toHaveCount(0);
  const threadId = await mark.getAttribute("data-thread-id");
  expect(threadId).not.toBeNull();
  const rail = page.getByRole("complementary", { name: "Note discussions" });
  const show = rail.locator(`.primary-note-discussion[data-thread-id="${threadId}"] .primary-note-discussion-bubble`);
  await expect(show).toBeVisible();
  await show.click();
  const persisted = JSON.parse(readFileSync(join(server!.root, ".archer/notes/auth.comments.json"), "utf8"));
  expect(persisted.threads[0].orphaned).toBeUndefined();
  writeFileSync(join(server!.root, ".archer/notes/auth.md"), note("The passage is removed."));
  await expect(body).toContainText("The passage is removed.");
  await expect(thread.getByText("Orphaned", { exact: true })).toBeVisible();
  await expect(body.locator("mark.archer-passage")).toHaveCount(0);
  await expect(rail.getByRole("region", { name: "Unplaced Discussions" })).toContainText(
    "Please clarify this passage.",
  );
});
