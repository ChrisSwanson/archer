/**
 * Comments and notes in a real browser: the whole loop the person and the
 * agent have (phase2-feedback-loop.md), and what jsdom cannot see -- focus
 * moving where it should, an anchored discussion preserving the canvas, the
 * left project inbox, bounded discussions at phone width, a pin
 * pressed with a real pointer, real text selection in a note, and axe.
 *
 * Against the TypeScript service (`ts/src/service`) with the agent's own tool
 * code (`ts/src/comments/agent.ts`): the real thing, nothing standing in for it.
 */
import { commentOperation } from "../support/comment-operations";
import { files as projectPage } from "./support/primary-navigation";
import AxeBuilder from "@axe-core/playwright";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { chooseComment } from "./support/element-menu";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.ARCHER_TEST_PAGE ?? testPage();
const FIXTURES = resolve(HERE, "../../../ts/test/fixtures");
const SHOTS = process.env.ARCHER_SHOTS;

const FLOW = "flowchart LR\n  web[Web app] e1@-->|HTTPS| api[API]\n  api e2@--> db[(Database)]\n";
const NOTE_BODY =
  "# Auth\n\nTokens expire after an hour. Refresh tokens expire after a week.\n\n- Sessions live in the **cache**.\n";
const view = (id: string, title: string, kind = "freeform") =>
  `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${title}"\nsource = ".archer/${id}.mmd"\n\n`;
const FILES = {
  "archer.toml": `version = 1\n\n${view("system", "The system")}${view("other", "The other system")}`,
  ".archer/system.mmd": FLOW,
  ".archer/other.mmd": FLOW,
  ".archer/notes/auth.md": `---\ntype: decision\ndiagrams: [../system.mmd]\n---\n${NOTE_BODY}`,
};

type Thread = {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly comments: readonly { readonly body: string }[];
};

/** What a test needs of a server: the page, the agent presenting, and the agent's side of comments. */
type Backend = {
  readonly url: string;
  present(viewId: string): Promise<void>;
  /** `get_comments`: sent threads become read. */
  agentRead(): Promise<Thread[]>;
  agentReply(threadId: string, body: string, revision: number): Promise<void>;
  agentResolve(threadId: string, revision: number): Promise<void>;
  /** A draft written elsewhere (another tab, another diagram), as the page would write it. */
  draft(target: string, body: string): Promise<void>;
  stop(): Promise<void>;
};

/** A draft as the owner's page writes it: an operation (ADR 0016), with the browser's cookie and Origin. */
async function postDraft(
  server: { fetch(path: string, init?: RequestInit): Promise<Response> },
  target: string,
  body: string,
): Promise<void> {
  const response = await server.fetch("api/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(commentOperation.create({ target, anchor: { kind: "view" }, body })),
  });
  expect(response.ok, `a draft on ${target}`).toBe(true);
}

const BACKENDS = {
  async service(files: Record<string, string> = FILES): Promise<Backend> {
    // The loop here is the queued one: drafts held until the person sends them.
    const project = await startTsProject({ files, pagePath: PAGE, commentSubmission: "queued" });
    return {
      url: project.url,
      present: (id) => project.present(id),
      agentRead: async () => (await project.agentInbox()) as Thread[],
      agentReply: (id, body, revision) => project.agentReply(id, body, revision),
      agentResolve: (id, revision) => project.agentResolve(id, revision),
      draft: (target, body) => postDraft(project, target, body),
      stop: () => project.stop(),
    };
  },
};

let backend: Backend | undefined;
let problems: string[];

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  await page.close();
  await backend?.stop();
  backend = undefined;
  expect(problems, "the page logged errors or warnings").toEqual([]);
});

type OpenOptions = {
  scheme?: "light" | "dark";
  design?: "current";
  files?: Record<string, string>;
  viewId?: string;
  drawn?: (page: Page) => Promise<void>;
};

async function open(page: Page, options: OpenOptions = {}): Promise<Backend> {
  backend = await BACKENDS.service(options.files);
  await page.emulateMedia({ colorScheme: options.scheme ?? "light" });
  await page.addInitScript(() => localStorage.setItem(`archer-comments:${location.pathname}:hold`, "true"));
  await page.goto(backend.url);
  await backend.present(options.viewId ?? "system");
  const drawn = options.drawn ?? ((p: Page) => expect(p.locator(".react-flow__node.archer-node")).toHaveCount(3));
  await drawn(page);
  return backend;
}

const panel = (page: Page) => page.getByRole("region", { name: "Contextual discussion", exact: true });
const reviewInbox = (page: Page) => page.getByRole("region", { name: "Project Review", exact: true });
const rail = (page: Page) => page.getByRole("navigation", { name: "Workspace", exact: true });
const railOpen = (page: Page) => page.getByRole("button", { name: /^Notifications/ });
async function openNote(page: Page): Promise<Locator> {
  await (await projectPage(page)).getByRole("button", { name: "Auth", exact: true }).click();
  return page.getByRole("article", { name: "Reading Auth" });
}
const pinOf = (element: Locator) => element.locator(".archer-pin");

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(" ")}`));
}

/** The agent's view of one thread, by its first words, after it fetched. */
async function inbox(server: Backend, words: string): Promise<Thread> {
  const found = (await server.agentRead()).find((t) => t.comments[0]?.body.startsWith(words));
  expect(found, `the agent was handed "${words}"`).toBeDefined();
  return found!;
}

/** The person's half: comment on a node from the keyboard, edit it, send it. Returns the thread's card. */
async function commentEditSend(page: Page, server: Backend): Promise<Locator> {
  // Review starts collapsed; no discussion is open.
  await expect(panel(page)).toBeHidden();
  await expect(railOpen(page)).toBeVisible();

  await page.getByRole("button", { name: "Select mode", exact: true }).click();
  await page.locator('.react-flow__node[data-id="web"]').click();
  await page.keyboard.press("c");
  const box = panel(page).getByRole("textbox", { name: "Comment" });
  await expect(box).toBeFocused();
  await expect(panel(page).locator(".primary-floating-context")).toHaveText("Node: Web app");
  await box.fill("Does the web app call the API directly?");
  await page.keyboard.press("Control+Enter");

  const thread = panel(page).getByRole("article", { name: /Node: Web app/ });
  await expect(thread).toBeFocused();
  await expect(thread.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.locator(".archer-review-toggle")).toBeVisible();
  const pin = pinOf(page.locator('.react-flow__node[data-id="web"]'));
  await expect(pin).toHaveText("1");
  await expect(pin).toHaveAttribute("data-state", "draft");
  // Nothing has reached the agent.
  expect(await server.agentRead()).toEqual([]);

  await thread.getByRole("button", { name: "Edit" }).click();
  const editor = thread.getByRole("textbox", { name: "Edit your comment" });
  await expect(editor).toBeFocused();
  await editor.fill("Does the web app call the API directly, or through the gateway?");
  await thread.getByRole("button", { name: "Save" }).click();
  await expect(thread.getByText("edited")).toBeVisible();
  await expect(thread.getByRole("button", { name: "Edit" })).toBeFocused();

  await panel(page).getByRole("button", { name: "Send queued comments (1)" }).click();
  await expect(thread.getByText("Sent", { exact: true })).toBeVisible();
  await expect(pin).toHaveAttribute("data-state", "sent");
  return thread;
}

test(`service: the agent reads, answers and resolves; the person dismisses`, async ({ page }) => {
  const backend = await open(page);
  const thread = await commentEditSend(page, backend);
  const pin = pinOf(page.locator('.react-flow__node[data-id="web"]'));

  const fetched = await inbox(backend, "Does the web app call the API directly, or through the gateway?");
  expect(fetched.status).toBe("read");
  await expect(thread.getByText("Read by the agent")).toBeVisible();

  await backend.agentReply(fetched.id, "Directly; the gateway is only for partners.", fetched.revision);
  await expect(thread.getByText("Directly; the gateway is only for partners.")).toBeVisible();
  await expect(thread.getByText("Answered", { exact: true })).toBeVisible();
  await expect(page.locator(".archer-review-announcer")).toHaveText("The agent replied on Node: Web app.");
  await expect(pin.locator(".archer-pin-agent")).toBeVisible();

  await backend.agentResolve(fetched.id, fetched.revision);
  await expect(thread.getByText("Resolved by the agent")).toBeVisible();
  // Kept with the agent's last reply, until dismissed.
  await expect(thread.getByText("Directly; the gateway is only for partners.")).toBeVisible();
  await thread.getByRole("button", { name: "Dismiss" }).click();
  await expect(panel(page).getByRole("article")).toHaveCount(0);
  await expect(page.locator(".archer-stage .archer-pin")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="web"]')).toBeFocused();
});

test(`service: sends every draft in the project, across two diagrams, in one action`, async ({ page }) => {
  const backend = await open(page);
  await backend.draft("view:other", "On the other diagram");
  await page.locator('.react-flow__node[data-id="api"]').click({ button: "right" });
  await chooseComment(page);
  await panel(page).getByRole("textbox", { name: "Comment" }).fill("On this one");
  await panel(page).getByRole("button", { name: "Add comment" }).click();

  const send = panel(page).getByRole("button", { name: "Send queued comments (2)" });
  await expect(send).toBeVisible();
  await expect(panel(page).getByText("Where the drafts are")).toHaveCount(0);
  await send.click();
  await expect(panel(page).getByRole("button", { name: /^Send queued comments/ })).toHaveCount(0);
  await expect(page.locator(".archer-review-announcer")).toHaveText(/Sent 2 threads to the agent/);
  const handed = (await backend.agentRead()).map((t) => t.comments[0]?.body).sort();
  expect(handed).toEqual(["On the other diagram", "On this one"]);
});

test(`service: an edit after sending makes a draft again, and the agent's answer to the old words is refused`, async ({
  page,
}) => {
  const backend = await open(page);
  const thread = await commentEditSend(page, backend);
  const fetched = await inbox(backend, "Does the web app");
  await thread.getByRole("button", { name: "Edit" }).click();
  await thread.getByRole("textbox", { name: "Edit your comment" }).fill("Scratch that: why is there a gateway at all?");
  await thread.getByRole("button", { name: "Save" }).click();
  await expect(thread.getByText("Changed after sending")).toBeVisible();
  await expect(pinOf(page.locator('.react-flow__node[data-id="web"]'))).toHaveAttribute("data-state", "draft");
  await expect(panel(page).getByRole("button", { name: "Send queued comments (1)" })).toBeEnabled();
  await expect(backend.agentReply(fetched.id, "To the old words", fetched.revision)).rejects.toThrow();
});

test(`service: a pin pressed opens its thread, from the rail, and selects its element`, async ({ page }) => {
  const backend = await open(page);
  await backend.draft("view:system", "On the whole diagram");
  // Two threads written, then their discussion closed. `api`'s discussion opens beside it, over `db`: closed
  // first, as a person would, or the right-click lands only while Playwright's scroll of the clipped canvas
  // outlasts React Flow's reset of it (O52, O60).
  for (const id of ["api", "db"]) {
    if (id !== "api") {
      await panel(page).getByRole("button", { name: "Close discussion" }).click();
      await expect(panel(page)).toBeHidden();
    }
    await page.locator(`.react-flow__node[data-id="${id}"]`).click({ button: "right" });
    await chooseComment(page);
    await panel(page).getByRole("textbox", { name: "Comment" }).fill(`About ${id}`);
    await panel(page).getByRole("button", { name: "Add comment" }).click();
    await expect(panel(page).getByText(`About ${id}`, { exact: true })).toBeVisible();
  }
  await panel(page).getByRole("button", { name: "Close discussion" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator(".archer-review-toggle")).toBeVisible();
  await railOpen(page).click();
  await expect(
    reviewInbox(page)
      .locator(".primary-inbox-meta .archer-thread-status")
      .filter({ hasText: /^Draft$/ }),
  ).toHaveCount(3);
  await reviewInbox(page).getByRole("button", { name: "Close project review" }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 5 } });

  const pin = pinOf(page.locator('.react-flow__node[data-id="db"]'));
  await expect(pin).toHaveText("2");
  // The pin sits on its element's corner, outside the label, and is what a press there hits.
  const node = (await page.locator('.react-flow__node[data-id="db"]').boundingBox())!;
  const at = (await pin.boundingBox())!;
  expect(at.x + at.width).toBeGreaterThan(node.x + node.width - 2);
  expect(at.y).toBeLessThan(node.y);
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest(".archer-pin")?.textContent ?? null,
    [at.x + at.width / 2, at.y + at.height / 2],
  );
  expect(hit).toBe("2");

  const stageBefore = await page.locator(".archer-stage").boundingBox();
  await pin.click();
  const thread = panel(page).getByRole("article", { name: /Node: Database/ });
  await expect(thread).toBeFocused();
  await expect(thread).toHaveAttribute("data-active", "true");
  await expect(page.locator('.react-flow__node[data-id="db"]')).toHaveClass(/selected/);
  await expect(page.locator('.react-flow__node[data-id="api"]')).not.toHaveClass(/selected/);
  expect(await page.locator(".archer-stage").boundingBox()).toEqual(stageBefore);
  const side = (await panel(page).boundingBox())!;
  const pinAfter = (await pin.boundingBox())!;
  expect(
    side.x + side.width <= pinAfter.x ||
      side.x >= pinAfter.x + pinAfter.width ||
      side.y + side.height <= pinAfter.y ||
      side.y >= pinAfter.y + pinAfter.height,
  ).toBe(true);
  expect(side.x).toBeGreaterThanOrEqual(0);
  expect(side.x + side.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("service: pins on a sequence diagram's participants and messages open their threads", async ({ page }) => {
  await open(page, {
    files: {
      "archer.toml": `version = 1\n\n${view("trace", "The trace", "sequence")}`,
      ".archer/trace.mmd": readFileSync(resolve(FIXTURES, "sequence", "widened.mmd"), "utf8"),
    },
    viewId: "trace",
    drawn: (p) => expect(p.locator('[data-seq-channel="participants"][role="button"]')).toHaveCount(3),
  });
  const participant = page.locator('[data-seq-channel="participants"][data-seq-id="api"][role="button"]');
  const message = page.locator('[data-seq-channel="messages"][role="button"]').nth(1);
  for (const [target, words] of [
    [participant, "Who owns the API?"],
    [message, "Why GET?"],
  ] as const) {
    await target.click({ button: "right" });
    await panel(page).getByRole("textbox", { name: "Comment" }).fill(words);
    await panel(page).getByRole("button", { name: "Add comment" }).click();
    await expect(panel(page).getByText(words, { exact: true })).toBeVisible();
  }
  await expect(page.locator(".archer-svg-pin")).toHaveCount(2);
  await expect(participant).toHaveAttribute("aria-label", /has comments$/);
  await panel(page).getByRole("button", { name: "Close discussion" }).click();

  await page.locator(".archer-svg-pin").filter({ hasText: "2" }).click();
  await expect(panel(page).getByRole("article", { name: /Edge:/ })).toBeFocused();
  await expect(message).toHaveAttribute("aria-pressed", "true");
});

test("service: pins on a journey's tasks open their threads", async ({ page }) => {
  await open(page, {
    files: {
      "archer.toml": `version = 1\n\n${view("day", "The day", "journey")}`,
      ".archer/day.mmd": readFileSync(resolve(FIXTURES, "journey", "widened.mmd"), "utf8"),
    },
    viewId: "day",
    drawn: (p) => expect(p.locator("[data-journey-id]")).toHaveCount(10),
  });
  const task = page.locator('[data-journey-id="do-work"]');
  await task.click({ button: "right" });
  await panel(page).getByRole("textbox", { name: "Comment" }).fill("Why the low point?");
  await panel(page).getByRole("button", { name: "Add comment" }).click();
  await panel(page).getByRole("button", { name: "Close discussion" }).click();
  await page.locator('[data-journey-id="make-tea"]').click();
  await pinOf(task).click();
  await expect(panel(page).getByRole("article", { name: /Node: Do work/ })).toBeFocused();
  await expect(task).toHaveAttribute("aria-pressed", "true");
});

test("service: open a note, select a passage, and comment on it", async ({ page }) => {
  await open(page);
  const note = await openNote(page);
  const body = note.getByRole("document", { name: "Note: Auth" });
  await expect(note.getByRole("heading", { level: 1, name: "Auth" })).toBeVisible();
  await expect(body.locator("h2.archer-note-h1")).toHaveCount(0);
  await expect(body.locator("strong")).toHaveText("cache");

  // A real selection, made in the rendered note.
  await body
    .locator("p")
    .first()
    .evaluate((paragraph) => {
      const text = paragraph.firstChild as Text;
      const start = text.data.indexOf("expire after a week");
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + "expire after a week".length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  const commentOnSelection = page.getByRole("button", { name: "Comment on selection" });
  await expect(commentOnSelection).toBeEnabled();
  await commentOnSelection.click();
  // The panel names the passage; the composer itself no longer repeats it.
  await expect(panel(page).locator(".primary-floating-context")).toHaveText("Passage: “expire after a week”");
  await expect(panel(page).getByRole("form", { name: "New comment" })).toBeVisible();
  await panel(page).getByRole("textbox", { name: "Comment" }).fill("Is a week too long?");
  await panel(page).getByRole("button", { name: "Add comment" }).click();

  // The service found the passage in the note's source and moved the saved
  // thread into the note's inline discussion margin.
  const discussions = note.getByRole("complementary", { name: "Note discussions", exact: true });
  const thread = discussions.getByRole("article", { name: /Passage/ });
  await expect(thread.getByText("Is a week too long?")).toBeVisible();
  await expect(thread.getByText("Orphaned")).toHaveCount(0);
  await expect(thread.getByRole("textbox", { name: "Your reply" })).toBeVisible();
  await expect(body.locator("mark.archer-passage")).toHaveText("expire after a week");
  await expect(note.getByRole("button", { name: "Open discussion on this passage" })).toBeVisible();
  // A note's draft is in the project's count.
  await railOpen(page).click();
  const review = reviewInbox(page);
  await expect(review.getByRole("button", { name: "Send queued comments (1)" })).toBeVisible();
  await expect(review.getByText("Where the drafts are")).toHaveCount(0);
  await expect(review.getByRole("alert")).toHaveCount(0);
});

test("service: project review overlays the drawing from the right without moving it, including phones", async ({
  page,
}) => {
  await open(page);
  const stage = await page.locator(".archer-stage").boundingBox();
  await railOpen(page).click();
  await expect(reviewInbox(page)).toBeVisible();
  await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
  // Settled against the right edge once it has slid in.
  const width = page.viewportSize()!.width;
  await expect
    .poll(async () => {
      const box = (await reviewInbox(page).boundingBox())!;
      return Math.round(box.x + box.width);
    })
    .toBe(width);
  const side = (await reviewInbox(page).boundingBox())!;
  expect(side.width).toBeGreaterThan(300);
  const rail = (await page.locator(".primary-rail").boundingBox())!;
  expect(side.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  expect(await page.locator(".archer-stage").boundingBox()).toEqual(stage);
  await page.setViewportSize({ width: 420, height: 800 });
  await page.reload();
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
  const toggle = page.locator(".archer-review-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const phoneStage = await page.locator(".archer-stage").boundingBox();
  await toggle.click();
  await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
  const narrow = (await reviewInbox(page).boundingBox())!;
  expect(narrow.width).toBeLessThanOrEqual(420);
  expect(await page.locator(".archer-stage").boundingBox()).toEqual(phoneStage);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await reviewInbox(page).getByRole("button", { name: "Close project review" }).click();
  await expect(toggle).toBeFocused();
});

test("service: inbox and floating composer controls follow reading order by Tab", async ({ page }) => {
  await open(page);
  await railOpen(page).click();
  await reviewInbox(page).getByRole("button", { name: "Close project review" }).focus();
  await page.keyboard.press("Tab");
  // The tab strip is one stop: the chosen tab.
  await expect(reviewInbox(page).getByRole("tab", { name: /^All/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(reviewInbox(page).getByRole("button", { name: "New comment" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("textbox", { name: "Comment" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page).getByRole("form", { name: "New comment" })).toHaveCount(0);
});

/** Every state a thread can be in, on screen at once: changed, read, answered, resolved; then a composer. */
async function everyState(page: Page, backend: Backend): Promise<void> {
  for (const id of ["web", "api", "db"]) {
    // Right-clicked where it can be seen: the last thread's discussion, open beside its node, covers the next node.
    // A click through it landed only while Playwright's scroll of the canvas' clipped wrapper outlasted React Flow's
    // reset of that scroll, which load reverses (O52).
    if (id !== "web") {
      await panel(page).getByRole("button", { name: "Close discussion" }).click();
      await expect(panel(page)).toBeHidden();
    }
    await page.locator(`.react-flow__node[data-id="${id}"]`).click({ button: "right" });
    await chooseComment(page);
    await panel(page).getByRole("textbox", { name: "Comment" }).fill(`About ${id}`);
    await panel(page).getByRole("button", { name: "Add comment" }).click();
    await expect(panel(page).getByText(`About ${id}`, { exact: true })).toBeVisible();
  }
  await panel(page)
    .getByRole("button", { name: /^Send queued comments \(\d+\)$/ })
    .click();
  await railOpen(page).click();
  // Threads sit under their diagram's heading; each collapsed entry wears its status badge.
  const systemThreads = reviewInbox(page)
    .locator(".primary-inbox-group")
    .filter({ hasText: "About web" })
    .locator(".primary-inbox-thread");
  const elsewhere = reviewInbox(page)
    .locator(".primary-inbox-group")
    .filter({ hasText: "Elsewhere" })
    .locator(".primary-inbox-thread");
  await expect(systemThreads.locator(".archer-thread-status").filter({ hasText: /^Sent$/ })).toHaveCount(3);
  await expect(elsewhere.locator(".archer-thread-status")).toHaveText(/^Sent$/);
  const handed = await backend.agentRead();
  const by = (words: string) => handed.find((t) => t.comments[0]?.body === words)!;
  await backend.agentReply(by("About web").id, "The platform team.", by("About web").revision);
  await backend.agentReply(by("About api").id, "Fixed in the diagram.", by("About api").revision);
  await backend.agentResolve(by("About api").id, by("About api").revision);
  await expect(
    systemThreads.locator(".archer-thread-status").filter({ hasText: /^Resolved by the agent$/ }),
  ).toBeVisible();
  await expect(systemThreads.locator(".archer-thread-status").filter({ hasText: /^Answered$/ })).toBeVisible();
  await expect(systemThreads.locator(".archer-thread-status").filter({ hasText: /^Read by the agent$/ })).toHaveCount(
    1,
  );
  await expect(elsewhere.locator(".archer-thread-status")).toHaveText(/^Read by the agent$/);
  // The entry expands in place; the thread is edited there.
  await reviewInbox(page)
    .getByRole("button", { name: /About db/ })
    .click();
  const db = reviewInbox(page).getByRole("article", { name: /Node: Database/ });
  await db.getByRole("button", { name: "Edit" }).click();
  await db.getByRole("textbox", { name: "Edit your comment" }).fill("About db, again");
  await db.getByRole("button", { name: "Save" }).click();
  await expect(
    reviewInbox(page).locator(".primary-inbox-meta .archer-thread-status").filter({ hasText: "Changed after sending" }),
  ).toBeVisible();
}

// One design since phase 3b; the row keeps its name.
for (const design of ["current"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing with every thread state, the rail, a composer and an open note · ${design} ${scheme}`, async ({
      page,
    }) => {
      const backend = await open(page, { design, scheme });
      // The rail, collapsed, with counts and something to send.
      await backend.draft("view:other", "Elsewhere");
      await expect(page.locator(".archer-review-toggle")).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await everyState(page, backend);
      if ((await railOpen(page).getAttribute("aria-expanded")) === "false") await railOpen(page).click();
      await expect(reviewInbox(page)).toBeVisible();
      await reviewInbox(page).getByRole("button", { name: "Close project review" }).click();
      await page.locator(".react-flow__pane").click({ position: { x: 300, y: 5 } });
      await page.keyboard.press("c");
      await expect(panel(page).getByRole("textbox", { name: "Comment" })).toBeVisible();
      const note = await openNote(page);
      await expect(note.getByRole("document", { name: "Note: Auth" }).locator("strong")).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }
}

// Screenshots for review, only when asked for (ARCHER_SHOTS=<dir>): 1440 and 390, light and dark.
for (const width of [1440, 390] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshot · ${width} ${scheme}`, async ({ page }) => {
      test.skip(SHOTS === undefined, "set ARCHER_SHOTS to a directory to save screenshots");
      const backend = await open(page, { scheme });
      await backend.draft("view:other", "Elsewhere");
      // Populate the full project inbox before opening one floating discussion at `width`.
      await everyState(page, backend);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await reviewInbox(page)
        .getByRole("button", { name: /About web/ })
        .click();
      await panel(page)
        .getByRole("article", { name: /Node: Web app/ })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/drawer-${width}-${scheme}.png` });
      await panel(page).getByRole("button", { name: "Close discussion" }).click();
      await page.screenshot({ path: `${SHOTS}/${width === 1440 ? "rail" : "pins"}-${width}-${scheme}.png` });
    });
  }
}

// Editor geometry needs a browser: jsdom has neither wrapping nor scrollHeight.
test("service: comment editors grow with their text", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Select mode", exact: true }).click();
  await page.locator('.react-flow__node[data-id="web"]').click();
  await page.keyboard.press("c");
  const editor = panel(page).getByRole("textbox", { name: "Comment", exact: true });
  await expect(editor).toBeFocused();
  const before = (await editor.boundingBox())!.height;
  const long = Array.from({ length: 12 }, (_, i) => `Review line ${i + 1}: explain this part of the diagram.`).join(
    "\n",
  );
  await editor.fill(long);
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(before * 2);
  expect(await editor.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await editor.fill("Short question");
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeLessThanOrEqual(before + 1);
  await editor.fill(Array.from({ length: 60 }, (_, i) => `Detailed review line ${i + 1}`).join("\n"));
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height);
  expect(await editor.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  const scroll = panel(page).locator(".primary-floating-content");
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The action is reachable through the panel's scroll, not a tiny input.
  const add = panel(page).getByRole("button", { name: "Add comment", exact: true });
  await add.scrollIntoViewIfNeeded();
  await expect(add).toBeInViewport();
});

test("service: editing and replying show all text, shrink, and keep their keyboard behavior", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Select mode", exact: true }).click();
  await page.locator('.react-flow__node[data-id="web"]').click();
  await page.keyboard.press("c");
  const composer = panel(page).getByRole("textbox", { name: "Comment", exact: true });
  const long = Array.from({ length: 12 }, (_, i) => `Review line ${i + 1}: explain this part of the diagram.`).join(
    "\n",
  );
  await composer.fill(long);
  await page.keyboard.press("Control+Enter");
  const thread = panel(page).getByRole("article", { name: /Node: Web app/ });
  await expect(thread).toBeFocused();
  await thread.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = thread.getByRole("textbox", { name: "Edit your comment" });
  await expect(editor).toBeFocused();
  // Initial text must fit before the person types anything.
  await expect.poll(() => editor.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  const large = (await editor.boundingBox())!.height;
  expect(await editor.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(long.length);
  await editor.fill("Shorter question");
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeLessThan(large / 2);
  await editor.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(3, 3));
  await page.keyboard.insertText("!");
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(4);
  await page.keyboard.press("Control+Enter");
  await expect(thread.locator(".archer-comment-body")).toHaveText("Sho!rter question");
  await expect(thread.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  const reply = thread.getByRole("textbox", { name: "Your reply" });
  await reply.focus();
  const small = (await reply.boundingBox())!.height;
  await reply.fill(long);
  await expect.poll(async () => (await reply.boundingBox())!.height).toBeGreaterThan(small * 2);
  expect(await reply.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await reply.fill("");
  await expect.poll(async () => (await reply.boundingBox())!.height).toBeLessThanOrEqual(small + 1);
  await reply.fill("Reply saved from the keyboard");
  await page.keyboard.press("Meta+Enter");
  await expect(thread.locator(".archer-comment-body").last()).toHaveText("Reply saved from the keyboard");
  await expect(reply).toHaveValue("");
  await reply.fill(long);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await page.locator('.react-flow__node[data-id="web"] .archer-pin').click();
  const reopened = panel(page).getByRole("article", { name: /Node: Web app/ });
  await expect(reopened.getByRole("textbox", { name: "Your reply" })).toHaveValue(long);
  await expect(reopened.locator(".archer-comment-body")).toHaveCount(2);
});

test("service: the editor reflows across phone widths without changing its text or caret", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Select mode", exact: true }).click();
  await page.locator('.react-flow__node[data-id="web"]').click();
  await page.keyboard.press("c");
  const editor = panel(page).getByRole("textbox", { name: "Comment", exact: true });
  const wrapped = "What happens when the payment provider takes longer to answer? ".repeat(20);
  await page.setViewportSize({ width: 720, height: 844 });
  await editor.fill(wrapped);
  const wide = (await editor.boundingBox())!.height;
  await editor.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(20, 25));
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(wide);
  const narrow = (await editor.boundingBox())!.height;
  expect(await editor.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 420, height: 844 });
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeLessThan(narrow);
  await expect(editor).toHaveValue(wrapped);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((el) => [
      (el as HTMLTextAreaElement).selectionStart,
      (el as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([20, 25]);
  expect(await editor.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
});
