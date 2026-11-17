import { commentOperation } from "../support/comment-operations";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

type Comment = { readonly id: string; readonly createdAt: string };
type Thread = { readonly id: string; readonly revision: number; readonly comments: readonly Comment[] };

/** A write as the owner's page sends it (its cookie and Origin, `project.fetch`); its answer, parsed. */
async function request(
  _page: Page,
  project: TsProject,
  method: "POST" | "PATCH",
  path: string,
  data: unknown,
): Promise<unknown> {
  const response = await project.fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** A create or reply, sent as its operation (ADR 0016): the receipt's thread. */
const threadOf = (ack: unknown): Thread => (ack as { thread: Thread }).thread;

async function createThread(page: Page, project: TsProject, target: string, body: string): Promise<Thread> {
  return threadOf(
    await request(
      page,
      project,
      "POST",
      "api/comments",
      commentOperation.create({ target, anchor: { kind: "view" }, body }),
    ),
  );
}

async function submit(page: Page, project: TsProject, target: string, threadId: string): Promise<void> {
  await request(page, project, "POST", "api/comments/submit", commentOperation.submit({ target, threadId }));
}

async function retainResolved(page: Page, project: TsProject, target: string, thread: Thread): Promise<void> {
  await submit(page, project, target, thread.id);
  const read = ((await project.agentInbox()) as Thread[]).find((candidate) => candidate.id === thread.id);
  expect(read, `the agent inbox contains ${thread.id}`).toBeDefined();
  await project.agentResolve(thread.id, read!.revision);
}

function files() {
  const view = (id: string, title: string): string =>
    `[[views]]\nid = "${id}"\nkind = "freeform"\ntitle = "${title}"\nsource = ".archer/${id}.mmd"\n`;
  return {
    "archer.toml": `version = 1\n\n${view("alpha", "Alpha")}${view("beta", "Beta")}${view("history", "History")}`,
    ".archer/alpha.mmd": "flowchart LR\n  a[Alpha]\n",
    ".archer/beta.mmd": "flowchart LR\n  b[Beta]\n",
    ".archer/history.mmd": "flowchart LR\n  h[History]\n",
  };
}

async function seedActivity(
  page: Page,
  project: TsProject,
): Promise<{
  readonly beta: readonly Thread[];
  readonly historyReplyAt: string;
}> {
  const history = await createThread(page, project, "view:history", "Original history question");
  const historyReply = threadOf(
    await request(
      page,
      project,
      "POST",
      `api/comments/${history.id}/replies`,
      commentOperation.reply("view:history", { body: "The retained reply" }),
    ),
  );
  const historyReplyAt = historyReply.comments.at(-1)!.createdAt;
  await request(page, project, "PATCH", `api/comments/${history.id}/${history.comments[0]!.id}`, {
    body: "Edited question, same activity time",
  });
  await retainResolved(page, project, "view:history", historyReply);
  await project.agentWrite(
    "history",
    ".archer/history.mmd",
    "flowchart LR\n  h[History after an unrelated file edit]\n",
  );

  const alphaResolvedOne = await createThread(page, project, "view:alpha", "Resolved alpha one");
  await retainResolved(page, project, "view:alpha", alphaResolvedOne);
  const alphaResolvedTwo = await createThread(page, project, "view:alpha", "Resolved alpha two");
  await retainResolved(page, project, "view:alpha", alphaResolvedTwo);
  await createThread(page, project, "view:alpha", "Open alpha thread");

  const beta = [
    await createThread(page, project, "view:beta", "Open beta one"),
    await createThread(page, project, "view:beta", "Open beta two"),
  ];
  for (const thread of beta) await submit(page, project, "view:beta", thread.id);
  const inbox = (await project.agentInbox()) as Thread[];
  return {
    beta: beta.map((thread) => inbox.find((candidate) => candidate.id === thread.id)!),
    historyReplyAt,
  };
}

const rowFor = (page: Page, target: string) => page.locator(`[data-browser-row][data-target="${target}"]`);
const titleOrder = (page: Page) => page.locator("[data-browser-row] .archer-folder-tree-open").allTextContents();
const threads = (page: Page, target: string) => rowFor(page, target).locator('[data-column="threads"]');

test("discussion activity is shown, sortable, filterable, and live in the Folders tree", async ({ page }) => {
  const project = await sharedTsProject({ files: files() });
  try {
    const seeded = await seedActivity(page, project);
    await page.goto(project.address(`q=`));

    const tree = page.getByRole("treegrid", { name: "Project files" });
    await expect(tree).toBeVisible();
    await expect(tree.getByRole("columnheader")).toHaveText(["Name", "Title", "Kind", "Threads", "Edited", "Created"]);

    // Total threads, and how many are open: the history's one thread is resolved.
    await expect(threads(page, "view:history")).toHaveText("1");
    await expect(threads(page, "view:alpha")).toHaveText("3 · 1 open");
    await expect(threads(page, "view:beta")).toHaveText("2 · 2 open");
    await expect(threads(page, "view:beta")).toHaveAttribute("data-open", "true");
    await expect(threads(page, "view:beta")).toHaveCSS("font-size", "12px");
    await expect(threads(page, "view:beta")).toHaveAccessibleName("2 threads, 2 open");
    expect(seeded.historyReplyAt).not.toBe("");

    await tree
      .getByRole("columnheader", { name: /^Threads/ })
      .getByRole("button", { name: "Threads", exact: true })
      .click();
    await expect.poll(() => titleOrder(page)).toEqual(["Alpha", "Beta", "History"]);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Project Filters" })
      .getByRole("combobox", { name: "Sort by", exact: true })
      .selectOption("unresolved:desc");
    await expect.poll(() => titleOrder(page)).toEqual(["Beta", "Alpha", "History"]);

    const discussions = page
      .locator("section.archer-filter-section")
      .filter({ has: page.getByText("Discussions", { exact: true }) });
    await expect(discussions).toBeVisible();
    const totalFilter = discussions.getByRole("group", { name: "Total threads", exact: true });
    await totalFilter.getByRole("combobox", { name: "Total threads condition" }).selectOption("between");
    await totalFilter.getByLabel("Minimum", { exact: true }).fill("3");
    await totalFilter.getByLabel("Maximum", { exact: true }).fill("3");
    await expect.poll(() => titleOrder(page)).toEqual(["Alpha"]);
    await page.getByRole("button", { name: "Close filters", exact: true }).click();
    await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    const unresolvedFilter = page.getByRole("group", { name: "Unresolved threads", exact: true });
    await unresolvedFilter.getByRole("combobox", { name: "Unresolved threads condition" }).selectOption("between");
    await unresolvedFilter.getByLabel("Minimum", { exact: true }).fill("2");
    await unresolvedFilter.getByLabel("Maximum", { exact: true }).fill("2");
    await expect.poll(() => titleOrder(page)).toEqual(["Beta"]);
    await page.getByRole("button", { name: "Close filters", exact: true }).click();
    await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect.poll(() => titleOrder(page)).toEqual(["Beta", "Alpha", "History"]);
    await page.getByRole("button", { name: "Close filters", exact: true }).click();

    // Live: resolving a thread updates the open count, never the total.
    await project.agentResolve(seeded.beta[0]!.id, seeded.beta[0]!.revision);
    await expect(threads(page, "view:beta")).toHaveText("2 · 1 open");
    await project.agentResolve(seeded.beta[1]!.id, seeded.beta[1]!.revision);
    await expect(threads(page, "view:beta")).toHaveText("2");
  } finally {
    await project.stop();
  }
});

for (const mode of [
  { name: "fine pointer", width: 1440, hasTouch: false, phone: false },
  { name: "coarse pointer", width: 390, hasTouch: true, phone: true },
] as const) {
  // On a desktop the Title column holds one ellipsized line; on a phone the tree has no columns,
  // and the whole title wraps beneath the file name.
  test(`a long title stays bounded in its row, its whole text in its tooltip, with a ${mode.name}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: mode.width, height: 844 }, hasTouch: mode.hasTouch });
    const page = await context.newPage();
    const longTitle =
      "A deliberately long architecture title whose complete meaning must remain available while its crowded table cell stays on one line";
    const project = await sharedTsProject({
      files: {
        "archer.toml": `version = 1\n[[views]]\nid = "long"\nkind = "freeform"\ntitle = "${longTitle}"\nsource = ".archer/long.mmd"\n`,
        ".archer/long.mmd": "flowchart LR\n  long[Long title]\n",
      },
    });
    try {
      await createThread(page, project, "view:long", "Keep this visible");
      await page.goto(project.address(`q=`));
      const row = rowFor(page, "view:long");
      const button = row.getByRole("button", { name: longTitle, exact: true });
      await expect(button).toBeVisible();
      await expect(row.locator('[data-column="title"]')).toHaveAttribute("title", longTitle);
      await expect(threads(page, "view:long")).toHaveText("1 · 1 open");
      const geometry = await row.locator('[data-column="title"]').evaluate((cell) => {
        const text = cell.querySelector<HTMLElement>(".archer-folder-tree-open")!;
        const cellBox = cell.getBoundingClientRect(),
          textBox = text.getBoundingClientRect();
        return {
          fullText: text.textContent,
          oneLine: textBox.height <= Number.parseFloat(getComputedStyle(text).lineHeight) * 1.2 || textBox.height <= 32,
          overflowed: text.scrollWidth > text.clientWidth,
          bounded: textBox.right <= cellBox.right + 1,
          whiteSpace: getComputedStyle(text).whiteSpace,
          textOverflow: getComputedStyle(text).textOverflow,
        };
      });
      expect(geometry.fullText).toBe(longTitle);
      expect(geometry.bounded).toBe(true);
      if (mode.phone) {
        expect(geometry.overflowed).toBe(false);
        expect(geometry.whiteSpace).toBe("normal");
      } else {
        expect(geometry.oneLine).toBe(true);
        expect(geometry.overflowed).toBe(true);
        expect(geometry.whiteSpace).toBe("nowrap");
        expect(geometry.textOverflow).toBe("ellipsis");
      }
    } finally {
      await context.close();
      await project.stop();
    }
  });
}
