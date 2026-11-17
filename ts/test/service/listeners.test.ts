// Delivery over the management socket and the page (ADR 0035 §7–8): register and claim, wait for the
// person's messages (waiting ones first, then on the comment event), the inbox, the listing of a
// checkout and its worktrees, the person's pin and the SSE event the bubble follows.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LISTENER_EVENT, type InboxMessage, type ListenerListing } from "../../src/agents/contract.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { connectService, ServiceCallError, type ServiceClient } from "../../src/service/service-client.ts";
import {
  apiBase,
  cleanUp,
  events,
  exactly,
  http,
  json,
  ownerCookie,
  project,
  service,
  tempDir,
  write,
  pageHttp,
} from "./support.ts";

afterEach(cleanUp);

async function attached() {
  const { svc, state } = await service();
  const root = project();
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root });
  const page = apiBase(url);
  const origin = new URL(url).origin;
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { origin, "content-type": "application/json" },
  ) => pageHttp(`${page}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  /** The person writes a comment on the diagram and sends it, as the bubble does. */
  const send = async (body: string): Promise<Thread> => {
    const created = await post("api/comments", {
      target: "view:flow",
      anchor: { kind: "view" },
      body,
      context: { page: "/projects/x/" },
    });
    expect(created.status, created.body).toBe(200);
    const thread = JSON.parse(created.body) as Thread;
    expect((await post("api/comments/submit", { target: "view:flow", threadId: thread.id })).status).toBe(200);
    return thread;
  };
  const claimed = async (cwd = root): Promise<string> => {
    const { agentId } = await client.call("registerAgent", {
      root,
      cwd,
      host: "claude-code",
      label: "Claude Code · test",
    });
    expect((await client.call("claimListener", { root, agentId })).claimed).toBe(true);
    return agentId;
  };
  return { svc, state, root, client, url, page, origin, post, send, claimed };
}

const code = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof ServiceCallError) return error.error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("claim over the socket", () => {
  test("claims the checkout with the exact text, and scoping refusals keep their codes", async () => {
    const { client, root } = await attached();
    const { agentId } = await client.call("registerAgent", {
      root,
      cwd: join(root, ".archer"),
      host: "codex",
      label: "Codex",
    });
    const claim = await client.call("claimListener", { root, agentId });
    expect(claim).toMatchObject({ claimed: true, listener: { agentId, root, host: "codex" } });
    expect(claim.text).toMatch(/^Listening for .+ \(main checkout, .+\)$/);
    const outside = await client.call("registerAgent", { root, cwd: tempDir(), host: "codex", label: "Elsewhere" });
    expect(await code(client.call("claimListener", { root, agentId: outside.agentId }))).toBe("cwd_outside_checkout");
    expect(await code(client.call("claimListener", { root: tempDir(), agentId }))).toBe("project_not_attached");
    expect(await code(client.call("heartbeat", { agentId: "ag-ffffffffffff", via: "cli" }))).toBe("agent_unknown");
  });
});

describe("waitMessage", () => {
  test("waiting messages come back at once, oldest first, with the where text; they are then read", async () => {
    const { client, claimed, send, page } = await attached();
    const agentId = await claimed();
    const first = await send("First question");
    const second = await send("Second question");
    const answer = await client.call("waitMessage", {
      root: (await client.call("listProjects", {})).projects[0]!.root,
      agentId,
      timeoutMs: 5_000,
    });
    expect("messages" in answer).toBe(true);
    const messages = (answer as { messages: InboxMessage[] }).messages;
    expect(messages.map((m) => [m.threadId, m.text, m.target])).toEqual([
      [first.id, "First question", "view:flow"],
      [second.id, "Second question", "view:flow"],
    ]);
    expect(messages[0]?.where).toContain("sent from /projects/x/");
    expect(messages[0]?.where).toContain("file .archer/flow.mmd");
    const threads = ((await json(`${page}api/comments?target=view:flow`)) as { threads: Thread[] }).threads;
    expect(threads.map((t) => t.status)).toEqual(["read", "read"]);
  });

  test("with nothing waiting it wakes on the comment event, and the page is told the state", async () => {
    const { client, claimed, send, page, root } = await attached();
    const agentId = await claimed();
    const stream = await events(`${page}api/events`);
    const waiting = client.call("waitMessage", { root, agentId, timeoutMs: 20_000 });
    expect(((await stream.next(LISTENER_EVENT)) as ListenerListing).current.state).toBe("listening");
    const thread = await send("Are you there?");
    expect(await waiting).toEqual({
      messages: [expect.objectContaining({ threadId: thread.id, text: "Are you there?" })],
    });
    expect(((await stream.next(LISTENER_EVENT)) as ListenerListing).current.state).toBe("next-turn");
    stream.close();
  });

  test("times out with nothing, refuses anyone but the listener, and a closed connection stops waiting", async () => {
    const { svc, client, claimed, root } = await attached();
    const agentId = await claimed();
    expect(await client.call("waitMessage", { root, agentId, timeoutMs: 50 })).toEqual({ timedOut: true });
    const other = await client.call("registerAgent", { root, cwd: root, host: "other", label: "Other" });
    expect(await code(client.call("waitMessage", { root, agentId: other.agentId, timeoutMs: 50 }))).toBe(
      "not_listener",
    );
    const second: ServiceClient = await connectService(svc.socketPath);
    void second.call("waitMessage", { root, agentId, timeoutMs: 20_000 }).catch(() => undefined);
    await expect.poll(async () => (await client.call("listListeners", { root })).current.state).toBe("listening");
    second.close();
    await expect.poll(async () => (await client.call("listListeners", { root })).current.state).toBe("next-turn");
  });

  test("a stop refuses an open wait rather than waiting for it", async () => {
    const { svc, client, claimed, root } = await attached();
    const agentId = await claimed();
    const waiting = code(client.call("waitMessage", { root, agentId, timeoutMs: 600_000 }));
    await expect.poll(async () => (await client.call("listListeners", { root })).current.state).toBe("listening");
    const started = Date.now();
    await svc.close();
    expect(await waiting).toBe("service_stopping");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a new claim ends the former listener's wait", async () => {
    const { client, claimed, root } = await attached();
    const first = await claimed();
    const waiting = code(client.call("waitMessage", { root, agentId: first, timeoutMs: 20_000 }));
    await expect.poll(async () => (await client.call("listListeners", { root })).current.state).toBe("listening");
    await claimed();
    expect(await waiting).toBe("not_listener");
  });
});

describe("inbox", () => {
  test("without the listener's id it lists without marking; brief only counts; with it the listener takes them", async () => {
    const { client, claimed, send, page, root } = await attached();
    const agentId = await claimed();
    await send("Hello");
    expect(await client.call("inbox", { root })).toMatchObject({ count: 1, messages: [{ text: "Hello" }] });
    expect(await client.call("inbox", { root, agentId, brief: true })).toEqual({ count: 1, messages: [] });
    const status = async () =>
      ((await json(`${page}api/comments?target=view:flow`)) as { threads: Thread[] }).threads[0]?.status;
    expect(await status()).toBe("sent");
    expect(await client.call("inbox", { root, agentId })).toMatchObject({ count: 1, messages: [{ text: "Hello" }] });
    expect(await status()).toBe("read");
    expect(await client.call("inbox", { root })).toEqual({ count: 0, messages: [] });
  });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

describe("listing", () => {
  test("the checkout and its repository's other checkouts, never another project", async () => {
    const { svc } = await service();
    const main = join(tempDir(), "pageturner");
    mkdirSync(main);
    write(main, ".archer/notes/a.md", "# A\n");
    git(main, "init", "-q", "-b", "main");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "one");
    const worktree = join(tempDir(), "order-notes");
    git(main, "worktree", "add", "-q", "-b", "demo/order-notes", worktree);
    const unrelated = project();
    const client = await connectService(svc.socketPath);
    try {
      for (const root of [main, worktree, unrelated]) await client.call("attach", { root });
      const { agentId } = await client.call("registerAgent", {
        root: worktree,
        cwd: worktree,
        host: "claude-code",
        label: "In the worktree",
      });
      await client.call("claimListener", { root: worktree, agentId });
      const listing = await client.call("listListeners", { root: main });
      expect(listing.current).toMatchObject({ root: main, state: "none", listener: null, agents: [] });
      expect(listing.otherCheckouts).toEqual([
        expect.objectContaining({
          root: worktree,
          name: "pageturner-order-notes",
          state: "next-turn",
          listener: expect.objectContaining({ agentId }),
        }),
      ]);
      expect((await client.call("listListeners", { root: unrelated })).otherCheckouts).toEqual([]);
    } finally {
      client.close();
    }
  });
});

describe("the page", () => {
  test("bootstrap names the capability; GET lists; the person pins with the page's Origin, an agent's token cannot", async () => {
    const { client, page, post, claimed, root, svc } = await attached();
    const boot = (await json(`${page}api/bootstrap`)) as { capabilities: Record<string, boolean> };
    expect(boot.capabilities["listeners"]).toBe(true);
    const agentId = await claimed();
    const listed = (await json(`${page}api/listeners`)) as ListenerListing;
    expect(listed.current).toMatchObject({
      state: "next-turn",
      listener: { agentId },
      pinnedByPerson: false,
      agents: [{ agentId }],
    });
    // Any access-link holder reads this: no absolute path names the account (S13).
    expect(JSON.stringify(listed)).not.toContain(root);
    // Without the page's Origin, or from another, the browser's cookie admits no write; the agent's service token
    // is no Bearer credential: each is the bare 404 before anything is read.
    const cookie = (await ownerCookie(page))!;
    const pin = (headers: Record<string, string>) =>
      exactly(`${page}api/listeners/pin`, { method: "POST", headers, body: JSON.stringify({ agentId }) });
    expect((await pin({ cookie, "content-type": "application/json" })).status).toBe(404);
    expect((await pin({ cookie, origin: "http://evil.invalid", "content-type": "application/json" })).status).toBe(404);
    expect((await pin({ authorization: `Bearer ${svc.token}`, "content-type": "application/json" })).status).toBe(404);
    expect((await post("api/listeners/pin", { agentId: "x; rm" })).status).toBe(422);
    const pinned = await post("api/listeners/pin", { agentId });
    expect(pinned.status, pinned.body).toBe(200);
    expect(JSON.parse(pinned.body)).toMatchObject({ pinnedByPerson: true, listener: { agentId } });
    expect(pinned.body).not.toContain(root);
    // An agent's claim now says the person chose another listener.
    const other = await client.call("registerAgent", { root, cwd: root, host: "codex", label: "Codex" });
    expect(await client.call("claimListener", { root, agentId: other.agentId })).toMatchObject({
      claimed: false,
      pinnedBy: { agentId },
    });
    expect(JSON.parse((await post("api/listeners/pin", { agentId: null })).body)).toMatchObject({
      pinnedByPerson: false,
    });
    expect((await pageHttp(`${page}api/listeners/nope`)).status).toBe(404);
  });

  test("pin and Launch are the owner's: an access link or paired device is refused, the service token's cookie is not (decision 1, C3, M2)", async () => {
    const { svc, client, url, claimed, send } = await attached();
    const agentId = await claimed();
    const thread = await send("Launch for me");
    const origin = new URL(url).origin;
    const slug = new URL(url).pathname.split("/")[2]!;
    const grant = await client.call("issueAccess", { label: "Phone" });
    const exchanged = await pageHttp(`${origin}/projects/${slug}/?token=${grant.token}`);
    const linkCookie = (exchanged.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const write = (path: string, body: unknown, headers: Record<string, string>) =>
      pageHttp(`${origin}/p/${slug}/${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    for (const headers of [{ cookie: linkCookie }, { authorization: `Bearer ${grant.token}` }]) {
      const pin = await write("api/listeners/pin", { agentId }, headers);
      expect(pin.status).toBe(403);
      expect(JSON.parse(pin.body)).toMatchObject({ error: { code: "person_only" } });
      expect((await write("api/listeners/launch", { threadId: thread.id }, headers)).status).toBe(403);
    }
    // A link holder still reads the listing, without `personal` (round 2, decision 23).
    const linkListing = await pageHttp(`${origin}/p/${slug}/api/listeners`, { headers: { cookie: linkCookie } });
    expect(linkListing.status).toBe(200);
    expect(JSON.parse(linkListing.body)).not.toHaveProperty("personal");
    // The owner's own sign-in: the service token's cookie, on this computer.
    const own = await pageHttp(`${origin}/projects/${slug}/?token=${svc.token}`);
    const ownCookie = (own.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    expect(
      JSON.parse((await pageHttp(`${origin}/p/${slug}/api/listeners`, { headers: { cookie: ownCookie } })).body),
    ).toMatchObject({ personal: true });
    expect((await write("api/listeners/pin", { agentId }, { cookie: ownCookie })).status).toBe(200);
  });

  test("Launch without a launcher set says how to set one, and the listing offers no Launch", async () => {
    const { post, send, page } = await attached();
    expect(((await json(`${page}api/listeners`)) as ListenerListing).launcher).toBeUndefined();
    const thread = await send("Start someone");
    const launched = await post("api/listeners/launch", { threadId: thread.id });
    expect(launched.status).toBe(409);
    expect(JSON.parse(launched.body)).toMatchObject({ error: { code: "launcher_not_configured" } });
    expect((await post("api/listeners/launch", { threadId: "t-000000000000" })).status).toBe(404);
  });
});

describe("get_comments by the listener (review M7, C9)", () => {
  test("the application passes the caller's agent id: the listener's fetch records read, another's does not; a reply keeps the thread", async () => {
    const { createApplication } = await import("../../src/application/index.ts");
    const { svc, client, claimed, send, page, root, post } = await attached();
    const listener = await claimed();
    const thread = await send("Have a look");
    const status = async () =>
      ((await json(`${page}api/comments?target=view:flow`)) as { threads: Thread[] }).threads[0]?.status;
    const app = (agentId?: string) =>
      createApplication({
        cwd: root,
        findService: () => connectService(svc.socketPath),
        ...(agentId === undefined ? {} : { agentId }),
      });
    const anonymous = app();
    await anonymous.call("get_comments", {});
    expect(await status()).toBe("sent");
    const other = (await client.call("registerAgent", { root, cwd: root, host: "codex", label: "Other" })).agentId;
    await app(other).call("get_comments", {});
    expect(await status()).toBe("sent");
    const mine = app(listener);
    await mine.call("get_comments", {});
    expect(await status()).toBe("read");
    // The other agent answers: a follow-up on that thread is its, not the listener's.
    const revision = ((await json(`${page}api/comments?target=view:flow`)) as { threads: Thread[] }).threads[0]!
      .revision;
    await app(other).call("reply_comment", { threadId: thread.id, body: "On it", expectedRevision: revision });
    const followUp = await post("api/comments/" + thread.id + "/replies", {
      body: "Thanks",
      context: { page: "/projects/x/" },
    });
    expect(followUp.status, followUp.body).toBe(200);
    expect((await post("api/comments/submit", { target: "view:flow", threadId: thread.id })).status).toBe(200);
    expect(await client.call("inbox", { root, agentId: other, brief: true })).toEqual({ count: 1, messages: [] });
    expect(await client.call("inbox", { root, agentId: listener, brief: true })).toEqual({ count: 0, messages: [] });
  });
});
