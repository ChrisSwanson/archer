// O188 (codex-1101): an unsent reply has one text, whichever box shows it. The diagram's discussion kept its own
// copy of a reply (FloatingDiscussion `replyDrafts`) that Project Review never updated, and a reply box given a
// nonempty copy skipped the kept reply: after "Show on diagram" the older copy came back, and the next keystroke
// wrote it over the newer kept text. Two boxes for one thread (the review closed with the thread expanded, then its
// pin) also each held their own text.
import { commentOperation } from "../support/comment-operations";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { caretToLineEnd } from "./support/keys";
import { sharedTsProject } from "./support/shared-service";

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@-->|calls| api[API]\n",
    },
  });
  await project.present("system");
  const origin = new URL(project.url).origin;
  const made = await project.fetch("api/comments", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(
      commentOperation.create({
        target: "view:system",
        anchor: { kind: "node", id: "web", label: "Web" },
        body: "Who calls the API?",
      }),
    ),
  });
  expect(made.ok).toBe(true);
  await page.goto(project.url);
}

/** Every kept reply's body in this tab's storage. */
const keptReplies = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const bodies: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)!;
        if (!key.includes("reply:")) continue;
        try {
          const body = (JSON.parse(store.getItem(key)!) as { body?: unknown }).body;
          if (typeof body === "string") bodies.push(body);
        } catch {
          /* not a draft */
        }
      }
    }
    return bodies;
  });

const discussion = (page: Page) => page.getByRole("region", { name: "Contextual discussion" });
const review = (page: Page) => page.getByRole("region", { name: "Project Review" });
const pin = (page: Page) => page.locator('.react-flow__node[data-id="web"] [data-pin-thread]');

test("O188: a reply continued in Project Review comes back whole on the diagram, and typing there keeps it", async ({
  page,
}) => {
  await open(page);
  await pin(page).click();
  const floating = discussion(page).getByRole("textbox", { name: "Your reply", exact: true });
  await floating.fill("earlier");
  await page.keyboard.press("Escape");
  await expect(discussion(page)).toHaveCount(0);

  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await review(page).getByText("Who calls the API?").first().click();
  const inbox = review(page).getByRole("textbox", { name: "Your reply", exact: true });
  await expect(inbox).toHaveValue("earlier");
  await caretToLineEnd(inbox);
  await inbox.pressSequentially(" and NEWEST inbox addition");
  await expect.poll(() => keptReplies(page)).toEqual(["earlier and NEWEST inbox addition"]);

  await review(page).getByRole("button", { name: "Show on diagram" }).click();
  const back = discussion(page).getByRole("textbox", { name: "Your reply", exact: true });
  await expect(back).toHaveValue("earlier and NEWEST inbox addition");
  await caretToLineEnd(back);
  await back.pressSequentially(" continued");
  await expect.poll(() => keptReplies(page)).toEqual(["earlier and NEWEST inbox addition continued"]);

  await page.reload();
  await expect(discussion(page).getByRole("textbox", { name: "Your reply", exact: true })).toHaveValue(
    "earlier and NEWEST inbox addition continued",
  );
});

test("O188: two boxes for one thread's reply hold one text, the newest", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await review(page).getByText("Who calls the API?").first().click();
  const inbox = review(page).getByRole("textbox", { name: "Your reply", exact: true });
  await inbox.fill("from the review");
  const inboxBox = page.locator('[id^="primary-inbox-card-"] textarea');
  // The review closed with its thread still expanded: its box stays mounted, out of sight.
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await expect(review(page)).toBeHidden();
  await pin(page).click();
  const floating = discussion(page).getByRole("textbox", { name: "Your reply", exact: true });
  await expect(floating).toHaveValue("from the review");
  await caretToLineEnd(floating);
  await floating.pressSequentially(" then the diagram");
  await expect.poll(() => keptReplies(page)).toEqual(["from the review then the diagram"]);
  // The hidden box, still mounted, reads the same, so it can never write an older text back.
  await expect(inboxBox).toHaveCount(1);
  await expect(inboxBox).toHaveValue("from the review then the diagram");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await expect(inbox).toHaveValue("from the review then the diagram");
  await caretToLineEnd(inbox);
  await inbox.pressSequentially("!");
  await expect.poll(() => keptReplies(page)).toEqual(["from the review then the diagram!"]);
  await page.reload();
  await pin(page).click();
  await expect(discussion(page).getByRole("textbox", { name: "Your reply", exact: true })).toHaveValue(
    "from the review then the diagram!",
  );
});

/** Every kept edit's body in this tab's storage. */
const keptEdits = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const bodies: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)!;
        if (!key.includes("edit:")) continue;
        try {
          const body = (JSON.parse(store.getItem(key)!) as { body?: unknown }).body;
          if (typeof body === "string") bodies.push(body);
        } catch {
          /* not a draft */
        }
      }
    }
    return bodies;
  });

test("O188: two boxes for one comment's edit hold one text, the newest", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await review(page).getByText("Who calls the API?").first().click();
  await review(page).getByRole("button", { name: "Edit", exact: true }).click();
  const inbox = review(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await inbox.fill("Who calls the API, and how often?");
  await expect.poll(() => keptEdits(page)).toEqual(["Who calls the API, and how often?"]);
  const inboxBox = page.locator('[id^="primary-inbox-card-"] textarea[class~="archer-composer-text"]').first();
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await expect(review(page)).toBeHidden();
  await pin(page).click();
  const floating = discussion(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await expect(floating).toHaveValue("Who calls the API, and how often?");
  await caretToLineEnd(floating);
  await floating.pressSequentially(" Daily?");
  await expect.poll(() => keptEdits(page)).toEqual(["Who calls the API, and how often? Daily?"]);
  await expect(inboxBox).toHaveValue("Who calls the API, and how often? Daily?");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  const again = review(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await expect(again).toHaveValue("Who calls the API, and how often? Daily?");
  await caretToLineEnd(again);
  await again.pressSequentially("!");
  await expect.poll(() => keptEdits(page)).toEqual(["Who calls the API, and how often? Daily?!"]);
  await page.reload();
  await pin(page).click();
  await expect(discussion(page).getByRole("textbox", { name: "Edit your comment", exact: true })).toHaveValue(
    "Who calls the API, and how often? Daily?!",
  );
});
