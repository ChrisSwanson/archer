// The recipient picker and Launch against the REAL TypeScript service (ADR 0035 §7–8, review decisions 1, 15 and
// 23): no route is mocked, so a pick the page offers is one the service accepts. Agent sessions are registered and
// claim on the service's management socket, as `archer listen --claim` does. Assertions marked [G1] need the 0.7.0
// round-2 service fix (wave4/fix2-service: the listing says `personal: true` to the person's own sign-in on this
// computer, which this page is); before it the page offers no Pin and no Launch at all.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { agentsOf, type Agents } from "../support/listener-agent";
import { startTsProject, type TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { testPage } from "./support/page-path";

const fab = (page: Page) => page.getByRole("button", { name: /^Chat with the agent about/ });
const status = (page: Page) => page.getByTestId("chat-status");
const picker = (page: Page) => page.getByRole("button", { name: /^To / });
const message = (page: Page) => page.getByRole("textbox", { name: "Message to the agent" });

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    "git",
    ["-c", "user.name=archer-test", "-c", "user.email=test@archer.invalid", "-c", "init.defaultBranch=main", ...args],
    { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
};

/** The walkthrough project as a git repository with one linked worktree beside it (`<root>-wt`). */
async function repository(): Promise<{ server: TsProject; worktree: string }> {
  let worktree = "";
  const server = await startTsProject({
    pagePath: testPage(),
    files: walkthroughFiles(),
    beforeService: async (_state, root) => {
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "commit", "-qm", "fixture");
      worktree = `${root}-wt`;
      git(root, "worktree", "add", "-q", worktree, "-b", "side");
    },
  });
  return { server, worktree };
}

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await page.mouse.move(700, 450);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
  await fab(page).click();
}

test("a pick in the picker pins that agent in the service; a sibling worktree's agent is shown, not pickable", async ({
  page,
}) => {
  const { server, worktree } = await repository();
  let agents: Agents | undefined;
  try {
    agents = await agentsOf(server);
    await agents.call("attach", { root: worktree });
    const first = await agents.register("Claude Code · first");
    const second = await agents.register("Codex · second", { host: "codex" });
    const sibling = await agents.register("Claude Code · sibling", { root: worktree });
    await agents.claim(first);
    await agents.claim(sibling, worktree);
    await open(page, server);
    // [G1] the person's page gets `personal: true`, so the row is the picker (before G1 it is text only).
    await expect(picker(page)).toHaveAccessibleName("To Claude Code · first");
    await expect(status(page)).toBeAttached();

    // This checkout's other agent: the service now has it as the person's pick.
    await picker(page).click();
    const list = page.getByRole("listbox", { name: "Send messages to" });
    await expect(list.getByRole("group", { name: "This checkout" }).getByRole("option")).toHaveCount(2);
    await list.getByRole("option", { name: /Codex · second/ }).click();
    await expect(picker(page)).toHaveAccessibleName("To Codex · second");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect
      .poll(async () => (await agents!.listing()).current)
      .toMatchObject({ listener: { agentId: second }, pinnedByPerson: true });

    // The sibling worktree's agent is said under its own heading as information, never as an option (decision 15),
    // and its own checkout keeps it as listener.
    await picker(page).click();
    await expect(list.getByRole("option")).toHaveCount(3); // the two here, and "Whichever agent claims it"
    await expect(list.getByRole("option", { name: /sibling/ })).toHaveCount(0);
    const elsewhere = page.getByRole("list", { name: "Other checkouts" });
    await expect(elsewhere.getByRole("listitem")).toHaveText(/^Listening in .*Claude Code · sibling/);
    await page.getByText(/^Listening in /).click();
    await expect(picker(page)).toHaveAccessibleName("To Codex · second");
    await expect
      .poll(async () => (await agents!.listing(worktree)).current)
      .toMatchObject({ listener: { agentId: sibling }, pinnedByPerson: false });

    // Giving the role back.
    await list.getByRole("option", { name: "Whichever agent claims it" }).click();
    await expect.poll(async () => (await agents!.listing()).current.pinnedByPerson).toBe(false);
  } finally {
    agents?.close();
    await server.stop();
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("a listener event before the chat opens still leaves the person Pin: the read is made, the event never stands in for it (decision 31)", async ({
  page,
}) => {
  const server = await startTsProject({ pagePath: testPage(), files: walkthroughFiles() });
  let agents: Agents | undefined;
  try {
    // Every `listeners` event the stream bridge raises, as the page sees it.
    await page.addInitScript(() => {
      const seen: unknown[] = [];
      (window as unknown as { __listenerEvents: unknown[] }).__listenerEvents = seen;
      window.addEventListener("archer:listeners", (e) => seen.push((e as CustomEvent<unknown>).detail));
    });
    const reads: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/api\/listeners$/.test(new URL(r.url()).pathname)) reads.push(r.url());
    });
    agents = await agentsOf(server);
    await server.present("containers");
    await page.goto(server.url);
    await page.mouse.move(700, 450);
    await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
    // The stream is open (it announced itself), then an agent registers and claims while the chat is closed.
    await page.waitForFunction(() =>
      (window as unknown as { __listenerEvents: unknown[] }).__listenerEvents.includes(null),
    );
    const first = await agents.register("Claude Code · first");
    await agents.claim(first);
    await page.waitForFunction(() =>
      (window as unknown as { __listenerEvents: unknown[] }).__listenerEvents.some(
        (d) => typeof d === "object" && d !== null,
      ),
    );
    const event = await page.evaluate(
      () =>
        (window as unknown as { __listenerEvents: unknown[] }).__listenerEvents.find(
          (d) => typeof d === "object" && d !== null,
        ) as Record<string, unknown>,
    );
    // The service's event carries neither of the person's fields.
    expect(event).not.toHaveProperty("personal");
    expect(event).not.toHaveProperty("launcher");
    expect(reads).toHaveLength(0);
    await fab(page).click();
    await expect(picker(page)).toHaveAccessibleName("To Claude Code · first");
    await expect(picker(page)).toBeEnabled();
    expect(reads).toHaveLength(1);
  } finally {
    agents?.close();
    await server.stop();
  }
});

test("without a launcher there is no Launch, and the service refuses one asked for anyway", async ({ page }) => {
  const server = await startTsProject({ pagePath: testPage(), files: walkthroughFiles() });
  try {
    await open(page, server);
    // The thread the page creates, and the project's API base, from the page's own request.
    const created = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/comments$/.test(new URL(r.url()).pathname),
    );
    await message(page).fill("Please draw the queue");
    await message(page).press("Enter");
    const response = await created;
    const made = (await response.json()) as { id?: string; thread?: { id?: string } };
    const threadId = made.id ?? made.thread?.id;
    expect(threadId).toEqual(expect.any(String));
    const launchUrl = response.url().replace(/api\/comments$/, "api/listeners/launch");
    await expect(status(page)).toContainText("No agent is listening in this checkout");
    // From the page, with its cookie and Origin: the refusal is the service's, not the page's.
    const answer = await page.evaluate(
      async ({ url, threadId }) => {
        const reply = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId }),
        });
        return {
          status: reply.status,
          body: (await reply.json().catch(() => null)) as { error?: { code?: string } } | null,
        };
      },
      { url: launchUrl, threadId },
    );
    expect(answer.status).toBe(409);
    expect(answer.body?.error?.code).toBe("launcher_not_configured");
    // Nothing was started: still nobody listens.
    await expect(status(page)).toContainText("No agent is listening in this checkout");
    // The listing says `launcher` only when one is set, and the page offers Launch only then.
    await expect(page.getByRole("button", { name: /Launch/ })).toHaveCount(0);
  } finally {
    await server.stop();
  }
});
