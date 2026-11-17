// O189–O191 (codex-1201/1202/1203): a finished write never takes away text typed while it waited.
//
// O189: Reply, Save and Add comment took the text at the click, awaited the write, then forgot whatever was kept
// and emptied (or reset) every box of that draft: words typed while the request was in flight were gone, from the
// boxes and from storage. The request is held here only to fix the order.
// O190: "Use it here" waited for the drafts lock, then copied the closed tab's older text over what the person typed
// meanwhile. The real lock is held from a helper page, as the reviewer did.
// O191: Discard on the "Your unsaved edit … is kept" notice forgot the edit without telling the other mounted editor,
// which kept the discarded words and could write them back.
import { commentOperation } from "../support/comment-operations";
import { expect, test, type Page, type Request, type Route } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { caretToLineEnd } from "./support/keys";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function start(): Promise<TsProject> {
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
  return project;
}
async function open(page: Page): Promise<TsProject> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const p = await start();
  await page.goto(p.url);
  return p;
}

/** Every kept draft's body of one kind (`reply:`, `edit:`, or a new comment's 8-hex anchor key) in this origin's storage. */
const kept = (page: Page, kind: "reply" | "edit" | "comment"): Promise<string[]> =>
  page.evaluate((kind) => {
    const bodies: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (!key.startsWith("archer.comment-draft.v1:")) continue;
      const tail = key.split("\0").pop()!;
      const is = kind === "comment" ? /^[0-9a-f]{8}(~|$)/.test(tail) : tail.startsWith(`${kind}:`);
      if (!is) continue;
      try {
        const body = (JSON.parse(localStorage.getItem(key)!) as { body?: unknown }).body;
        if (typeof body === "string") bodies.push(body);
      } catch {
        /* not a draft */
      }
    }
    return bodies.sort();
  }, kind);

/** The service's comments on the thread, as the agent would read them. */
async function serviceBodies(p: TsProject): Promise<string[]> {
  const origin = new URL(p.url).origin;
  const listed = (await (await p.fetch("api/comments?target=view%3Asystem", { headers: { origin } })).json()) as {
    threads: { comments: { body: string }[] }[];
  };
  return listed.threads.flatMap((t) => t.comments.map((c) => c.body));
}

/** Holds the first request matching `matches` until `release()`; `sent()` is what it carried. */
async function hold(
  page: Page,
  url: RegExp,
  method: string,
): Promise<{ readonly seen: Promise<Request>; release(): void }> {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let seen!: (r: Request) => void;
  const seenP = new Promise<Request>((done) => {
    seen = done;
  });
  let once = false;
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method || once) {
      await route.continue();
      return;
    }
    once = true;
    seen(route.request());
    await gate;
    await route.continue();
  });
  return { seen: seenP, release };
}

const discussion = (page: Page) => page.getByRole("region", { name: "Contextual discussion" });
const review = (page: Page) => page.getByRole("region", { name: "Project Review" });
const pin = (page: Page) => page.locator('.react-flow__node[data-id="web"] [data-pin-thread]');
const notifications = (page: Page) => page.getByRole("button", { name: /^Notifications\b/ });
/** The page has taken the write's answer: its live region says so. */
const answered = (page: Page, said: RegExp) =>
  expect(page.locator(".archer-review-announcer", { hasText: said })).toHaveCount(1);
const bodyOf = (r: Request): string =>
  (r.postDataJSON() as { body?: string; payload?: { body?: string } }).payload?.body ??
  (r.postDataJSON() as { body?: string }).body ??
  "";

test("O189: a reply typed on while Reply waits keeps the newer words, in both boxes and through reload", async ({
  page,
}) => {
  const p = await open(page);
  await notifications(page).click();
  await review(page).getByText("Who calls the API?").first().click();
  const inbox = review(page).getByRole("textbox", { name: "Your reply", exact: true });
  await inbox.fill("R12 reply to submit");
  const held = await hold(page, /\/api\/comments\/[^/]+\/replies$/, "POST");
  await review(page).getByRole("button", { name: "Reply", exact: true }).click();
  const request = await held.seen;
  // The review closes with its thread expanded (its box stays mounted); the diagram's box takes the typing.
  await notifications(page).click();
  await expect(review(page)).toBeHidden();
  await pin(page).click();
  const floating = discussion(page).getByRole("textbox", { name: "Your reply", exact: true });
  await expect(floating).toHaveValue("R12 reply to submit");
  await caretToLineEnd(floating);
  await floating.pressSequentially(" and UNIQUE AFTER");
  await expect.poll(() => kept(page, "reply")).toEqual(["R12 reply to submit and UNIQUE AFTER"]);
  held.release();
  await expect.poll(() => serviceBodies(p)).toContain("R12 reply to submit");
  await answered(page, /^Reply (sent|saved)/);
  expect(bodyOf(request)).toBe("R12 reply to submit");
  // Sent is sent; what was typed after the click stays, a reply not sent yet.
  await expect(floating).toHaveValue("R12 reply to submit and UNIQUE AFTER");
  const inboxBox = page.locator('[id^="primary-inbox-card-"] textarea');
  await expect(inboxBox).toHaveValue("R12 reply to submit and UNIQUE AFTER");
  await expect.poll(() => kept(page, "reply")).toEqual(["R12 reply to submit and UNIQUE AFTER"]);
  await page.reload();
  await pin(page).click();
  await expect(discussion(page).getByRole("textbox", { name: "Your reply", exact: true })).toHaveValue(
    "R12 reply to submit and UNIQUE AFTER",
  );
  expect((await serviceBodies(p)).filter((b) => b === "R12 reply to submit")).toHaveLength(1);
});

test("O189: an edit typed on while Save waits keeps the newer words, without a false 'changed' warning", async ({
  page,
}) => {
  const p = await open(page);
  await notifications(page).click();
  await review(page).getByText("Who calls the API?").first().click();
  await review(page).getByRole("button", { name: "Edit", exact: true }).click();
  const inbox = review(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await inbox.fill("Edited to submit");
  const held = await hold(page, /\/api\/comments\/[^/]+\/[^/]+$/, "PATCH");
  await review(page).getByRole("button", { name: "Save", exact: true }).click();
  const request = await held.seen;
  await notifications(page).click();
  await expect(review(page)).toBeHidden();
  await pin(page).click();
  const floating = discussion(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await expect(floating).toHaveValue("Edited to submit");
  await caretToLineEnd(floating);
  await floating.pressSequentially(" UNIQUE AFTER");
  await expect.poll(() => kept(page, "edit")).toEqual(["Edited to submit UNIQUE AFTER"]);
  held.release();
  await expect.poll(() => serviceBodies(p)).toContain("Edited to submit");
  await answered(page, /^Comment updated/);
  expect(bodyOf(request)).toBe("Edited to submit");
  await expect(floating).toHaveValue("Edited to submit UNIQUE AFTER");
  await expect(discussion(page).getByText("This comment changed since you started editing it")).toHaveCount(0);
  await expect.poll(() => kept(page, "edit")).toEqual(["Edited to submit UNIQUE AFTER"]);
  await page.reload();
  await pin(page).click();
  await expect(discussion(page).getByRole("textbox", { name: "Edit your comment", exact: true })).toHaveValue(
    "Edited to submit UNIQUE AFTER",
  );
  await expect(discussion(page).getByText("This comment changed since you started editing it")).toHaveCount(0);
});

test("O189: a new comment typed on while Add comment waits stays open with the newer words, through reload", async ({
  page,
}) => {
  const p = await open(page);
  await page.locator('.react-flow__node[data-id="api"]').click({ button: "right" });
  await chooseComment(page);
  const form = page.getByRole("form", { name: "New comment" });
  const text = form.getByRole("textbox", { name: "Comment", exact: true });
  await text.fill("New to submit");
  const held = await hold(page, /\/api\/comments$/, "POST");
  await form.getByRole("button", { name: "Add comment" }).click();
  const request = await held.seen;
  await caretToLineEnd(text);
  await text.pressSequentially(" UNIQUE AFTER");
  await expect.poll(() => kept(page, "comment")).toEqual(["New to submit UNIQUE AFTER"]);
  held.release();
  await expect.poll(() => serviceBodies(p)).toContain("New to submit");
  await answered(page, /^Comment (sent|saved)/);
  expect(bodyOf(request)).toBe("New to submit");
  await expect(form).toBeVisible();
  await expect(text).toHaveValue("New to submit UNIQUE AFTER");
  await expect.poll(() => kept(page, "comment")).toEqual(["New to submit UNIQUE AFTER"]);
  await page.reload();
  await expect(
    page.getByRole("form", { name: "New comment" }).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("New to submit UNIQUE AFTER");
});

/**
 * Tab A keeps an older draft and closes; tab B offers it; the drafts lock is held from a helper page while B's
 * "Use it here" waits, and B is typed in meanwhile. `typeIn` opens B's box of the kind under test.
 */
async function adoptWhileTyping(page: Page, kind: "reply" | "edit"): Promise<void> {
  const p = await start();
  const context = page.context();
  const a = await context.newPage();
  await a.setViewportSize({ width: 1440, height: 900 });
  await a.goto(p.url);
  await pin(a).click();
  const older = kind === "reply" ? "R12 older closed-tab reply" : "R12 older closed-tab edit";
  const name = kind === "reply" ? "Your reply" : "Edit your comment";
  if (kind === "edit") await discussion(a).getByRole("button", { name: "Edit", exact: true }).click();
  await discussion(a).getByRole("textbox", { name, exact: true }).fill(older);
  await expect.poll(() => kept(a, kind)).toEqual([older]);
  await a.close();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(p.url);
  await pin(page).click();
  const use = discussion(page).getByRole("button", { name: "Use it here" });
  await expect(use).toBeVisible();
  const helper = await context.newPage();
  await helper.goto(p.url);
  await helper.evaluate(
    () =>
      new Promise<void>((granted) => {
        void navigator.locks.request(
          "archer.drafts.v1",
          () =>
            new Promise<void>((release) => {
              (window as unknown as { release: () => void }).release = release;
              granted();
            }),
        );
      }),
  );
  await use.click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => ((await navigator.locks.query()).pending ?? []).filter((l) => l.name === "archer.drafts.v1").length,
      ),
    )
    .toBe(1);
  const box = discussion(page).getByRole("textbox", { name, exact: true });
  await caretToLineEnd(box);
  const newer = " R12 NEW UNIQUE typed while adoption pending";
  await box.pressSequentially(newer);
  const typed = await box.inputValue();
  await expect.poll(() => kept(page, kind)).toEqual([older, typed].sort());
  await helper.evaluate(() => {
    (window as unknown as { release: () => void }).release();
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const q = await navigator.locks.query();
        return [...(q.pending ?? []), ...(q.held ?? [])].filter((l) => l.name === "archer.drafts.v1").length;
      }),
    )
    .toBe(0);
  await helper.close();
  // What B typed is B's, kept; the closed tab's older text is not copied over it (it stays, still offered).
  await expect(box).toHaveValue(typed);
  await expect.poll(() => kept(page, kind)).toEqual([older, typed].sort());
  await page.reload();
  await pin(page).click();
  await expect(discussion(page).getByRole("textbox", { name, exact: true })).toHaveValue(typed);
}

test("O190: Use it here waiting on the drafts lock never copies an older reply over one typed meanwhile", async ({
  page,
}) => {
  await adoptWhileTyping(page, "reply");
});

test("O190: Use it here waiting on the drafts lock never copies an older edit over one typed meanwhile", async ({
  page,
}) => {
  await adoptWhileTyping(page, "edit");
});

test("O191: Discard on the kept-edit notice also clears the other mounted editor", async ({ page }) => {
  await open(page);
  await notifications(page).click();
  await review(page).getByText("Who calls the API?").first().click();
  await review(page).getByRole("button", { name: "Edit", exact: true }).click();
  await review(page).getByRole("textbox", { name: "Edit your comment", exact: true }).fill("Edit to be discarded");
  const inboxBox = page.locator('[id^="primary-inbox-card-"] textarea[class~="archer-composer-text"]').first();
  await notifications(page).click();
  await expect(review(page)).toBeHidden();
  await pin(page).click();
  const floating = discussion(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await expect(floating).toHaveValue("Edit to be discarded");
  await floating.press("Escape");
  await discussion(page).getByRole("button", { name: "Discard it" }).click();
  await expect.poll(() => kept(page, "edit")).toEqual([]);
  // The hidden review editor no longer holds the discarded words.
  await expect(inboxBox).not.toHaveValue("Edit to be discarded");
  await page.keyboard.press("Escape");
  await notifications(page).click();
  const again = review(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  if ((await again.count()) > 0) {
    await caretToLineEnd(again);
    await again.pressSequentially("!");
    expect(await kept(page, "edit")).not.toContain("Edit to be discarded!");
  }
  await page.reload();
  await expect.poll(() => kept(page, "edit")).not.toContain("Edit to be discarded");
});

// O208 (codex-1302): Save A committed, its answer held; typed on; another person saved B, so the editor rightly said
// the comment changed and offered "Save over it". A's older answer then replaced the newer thread the page held, and
// the warning went away although Archer still held B. An answer older than the thread the page holds no longer
// replaces it.
test("O208: an edit's older answer leaves the warning about a change saved after it", async ({ page, browser }) => {
  const p = await open(page);
  await pin(page).click();
  await discussion(page).getByRole("button", { name: "Edit", exact: true }).click();
  const box = discussion(page).getByRole("textbox", { name: "Edit your comment", exact: true });
  await box.fill("Edit A");
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let committed!: () => void;
  const landed = new Promise<void>((done) => {
    committed = done;
  });
  await page.route(/\/api\/comments\/[^/]+\/[^/]+$/, async (route: Route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    committed();
    await gate;
    await route.fulfill({ response });
  });
  await discussion(page).getByRole("button", { name: "Save", exact: true }).click();
  await landed;
  await caretToLineEnd(box);
  await box.pressSequentially(" and newer");
  // Another person, in a fresh profile, saves B; the first page hears of it and says so.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await other.newPage();
  await b.goto(p.url);
  await pin(b).click();
  await discussion(b).getByRole("button", { name: "Edit", exact: true }).click();
  await discussion(b).getByRole("textbox", { name: "Edit your comment", exact: true }).fill("Edit B from elsewhere");
  await discussion(b).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(() => serviceBodies(p)).toContain("Edit B from elsewhere");
  await other.close();
  const warning = discussion(page).getByText("This comment changed since you started editing it");
  await expect(warning).toBeVisible();
  await expect(discussion(page).getByRole("button", { name: "Save over it" })).toBeVisible();
  release();
  await answered(page, /^Comment updated/);
  await expect(box).toHaveValue("Edit A and newer");
  await expect(warning).toBeVisible();
  await expect(discussion(page).getByRole("button", { name: "Save over it" })).toBeVisible();
  expect(await serviceBodies(p)).toContain("Edit B from elsewhere");
});
