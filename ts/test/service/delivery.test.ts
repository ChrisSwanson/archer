// Delivery semantics behind the socket (review 0.7.0 decisions 3, 5, 10): per comment, acknowledged
// once written, routed to the conversation's last answerer while it is live, and an unknown id refused.
// A real ProjectState on a temp project; the Delivery is driven directly so the write outcome is chosen.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LISTENER_EXPIRY_MS, type InboxMessage } from "../../src/agents/contract.ts";
import { CommentsStore } from "../../src/comments/store.ts";
import type { TargetRef, Thread } from "../../src/comments/contract.ts";
import { MAX_LISTENERS_BYTES } from "../../src/agents/pins.ts";
import { Delivery, type AfterWrite } from "../../src/service/listeners.ts";
import { configureWritePolicy } from "../../src/config/write-policy.ts";
import { pageText } from "../../src/service/project-facts.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, commentOperation, project } from "./support.ts";

const open: { state: ProjectState; delivery: Delivery }[] = [];
afterEach(async () => {
  for (const { state, delivery } of open.splice(0)) {
    delivery.stop();
    state.close();
  }
  await cleanUp();
});

async function setup(options: { stateDir?: string; root?: string } = {}) {
  const root = options.root ?? project();
  const state = await ProjectState.open(root, (slug) => `http://127.0.0.1:1/projects/${slug}/`);
  let now = 1_000_000_000;
  const launches: string[] = [];
  const delivery = new Delivery({
    projects: () => [state],
    now: () => now,
    home: "/home/someone",
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    launch: async (_, message) => {
      launches.push(message.text);
      return { pid: 1 };
    },
  });
  open.push({ state, delivery });
  const register = (label = "Claude Code · test") =>
    delivery.registerAgent({ root: state.root, cwd: state.root, host: "claude-code", label }).agentId;
  const claimed = (): string => {
    const id = register();
    expect(delivery.claimListener({ root: state.root, agentId: id }).claimed).toBe(true);
    return id;
  };
  /** The person writes and sends, as the bubble does. */
  const send = (body: string): Thread => {
    const thread = state.createThreadOnce(
      commentOperation.create({
        target: "view:flow",
        anchor: { kind: "view" },
        body,
        context: { page: "/projects/x/" },
      }),
      "service",
    ).thread!;
    state.submitComments({ target: "view:flow", threadId: thread.id });
    return thread;
  };
  const reply = (threadId: string, body: string): void => {
    state.replyThreadOnce(
      threadId,
      commentOperation.reply("view:flow", { body, context: { page: "/projects/x/" } }),
      "service",
    );
    state.submitComments({ target: "view:flow", threadId });
  };
  const status = (threadId: string) => state.threadById(threadId)?.status;
  return {
    state,
    delivery,
    root: state.root,
    register,
    claimed,
    send,
    reply,
    status,
    advance: (ms: number) => {
      now += ms;
    },
    launches,
  };
}

const lost: AfterWrite = (callback) => callback(false);
const held = (): { afterWrite: AfterWrite; write(ok: boolean): void } => {
  let pending: ((ok: boolean) => void) | undefined;
  return {
    afterWrite: (callback) => {
      pending = callback;
    },
    write: (ok) => pending?.(ok),
  };
};
async function threadRevision(root: string, threadId: string): Promise<number> {
  return new CommentsStore((await import("../../src/project/index.ts")).findProject(root)).find(threadId)!.revision;
}
const texts = (messages: readonly InboxMessage[]) => messages.map((m) => m.text);

test("an answer that was not written takes nothing: the comments arrive again (C2, L8)", async () => {
  const { delivery, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("Draw the auth flow");
  const first = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, undefined, lost);
  expect("messages" in first && texts(first.messages)).toEqual(["Draw the auth flow"]);
  expect(status(thread.id)).toBe("sent");
  const again = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 });
  expect("messages" in again && texts(again.messages)).toEqual(["Draw the auth flow"]);
  expect(status(thread.id)).toBe("read");
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 20 })).toEqual({ timedOut: true });
});

test("a wait whose connection closed hands nothing over", async () => {
  const { delivery, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("Hello");
  const closed = new AbortController();
  closed.abort();
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, closed.signal)).toEqual({
    timedOut: true,
  });
  expect(status(thread.id)).toBe("sent");
});

test("comments in an answer not yet written are not handed to a second wait", async () => {
  const { delivery, root, claimed, send } = await setup();
  const id = claimed();
  send("Once");
  const write = held();
  const first = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, undefined, write.afterWrite);
  expect("messages" in first).toBe(true);
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 20 })).toEqual({ timedOut: true });
  write.write(true);
});

test("every person comment the agent has not received, oldest first, each with its id (L M6)", async () => {
  const { delivery, root, claimed, send, reply, status } = await setup();
  const id = claimed();
  const thread = send("Draw the auth flow");
  reply(thread.id, "Include token refresh");
  const answer = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 });
  expect("messages" in answer && answer.messages.map((m) => [m.threadId, m.text, typeof m.commentId])).toEqual([
    [thread.id, "Draw the auth flow", "string"],
    [thread.id, "Include token refresh", "string"],
  ]);
  expect(status(thread.id)).toBe("read");
  // A later reply carries only itself.
  reply(thread.id, "And logout");
  const next = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 });
  expect("messages" in next && texts(next.messages)).toEqual(["And logout"]);
});

test("an unknown id is refused on every method that names one (C8)", async () => {
  const { delivery, root } = await setup();
  const unknown = "ag-ffffffffffff";
  const code = async (run: () => unknown): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "none";
  };
  expect(await code(() => delivery.inbox({ root, agentId: unknown }))).toBe("agent_unknown");
  expect(await code(() => delivery.inbox({ root, agentId: unknown, brief: true }))).toBe("agent_unknown");
  expect(await code(() => delivery.waitMessage({ root, agentId: unknown, timeoutMs: 10 }))).toBe("agent_unknown");
  expect(await code(() => delivery.heartbeat({ agentId: unknown, via: "hook" }))).toBe("agent_unknown");
  expect(await code(() => delivery.claimListener({ root, agentId: unknown }))).toBe("agent_unknown");
  expect(await code(() => delivery.reportActivity({ root, agentId: unknown }))).toBe("agent_unknown");
});

test("an away listener reports in through inbox and takes its messages (L5)", async () => {
  const { delivery, root, claimed, send, advance, status } = await setup();
  const id = claimed();
  advance(LISTENER_EXPIRY_MS + 1);
  expect(delivery.registry.status(root)).toMatchObject({ away: true, state: "next-turn" });
  const thread = send("Still there?");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["Still there?"]);
  expect(status(thread.id)).toBe("read");
  expect(delivery.registry.status(root).away).toBe(false);
});

test("a conversation stays with the agent that answered it; the hook counts only the asker's (decision 5, L M8)", async () => {
  const { delivery, root, claimed, register, send, reply, advance } = await setup();
  const listener = claimed();
  const answerer = register("Codex · test");
  const thread = send("First");
  const other = send("Elsewhere");
  // The answerer fetched and replied through the comment operations.
  delivery.reportActivity({ root, agentId: answerer, answered: [thread.id] });
  reply(thread.id, "Follow-up");
  expect(delivery.inbox({ root, agentId: answerer, brief: true }).count).toBe(2);
  expect(texts(delivery.inbox({ root, agentId: listener }).messages)).toEqual(["Elsewhere"]);
  const third = register("Third");
  expect(delivery.inbox({ root, agentId: third, brief: true }).count).toBe(0);
  expect(texts(delivery.inbox({ root, agentId: answerer }).messages)).toEqual(["First", "Follow-up"]);
  // Once the answerer goes away, a new comment on its thread goes to the listener.
  advance(LISTENER_EXPIRY_MS + 1);
  delivery.heartbeat({ agentId: listener, via: "cli" });
  reply(thread.id, "Anyone?");
  expect(texts(delivery.inbox({ root, agentId: listener }).messages)).toEqual(["Anyone?"]);
  expect(other.id).not.toBe(thread.id);
});

test("get_comments by the recipient records read; by anyone else it does not (C9, M7)", async () => {
  const { delivery, root, claimed, register, send, status } = await setup();
  const listener = claimed();
  const bystander = register("Bystander");
  const thread = send("Look at this");
  const revision = (await Promise.resolve(
    new CommentsStore((await import("../../src/project/index.ts")).findProject(root)).find(thread.id),
  ))!.revision;
  expect(delivery.reportActivity({ root, agentId: bystander, fetched: [{ threadId: thread.id, revision }] })).toEqual({
    read: [],
  });
  expect(status(thread.id)).toBe("sent");
  expect(delivery.reportActivity({ root, agentId: listener, fetched: [{ threadId: thread.id, revision }] })).toEqual({
    read: [thread.id],
  });
  expect(status(thread.id)).toBe("read");
  expect(await delivery.waitMessage({ root, agentId: listener, timeoutMs: 20 })).toEqual({ timedOut: true });
});

test("a get_comments report refused by the comments rule hands nothing over (PD-1)", async () => {
  const { delivery, root, claimed, send, status } = await setup();
  const listener = claimed();
  const thread = send("Look at this");
  const revision = threadRevision(root, thread.id);
  const dir = mkdtempSync(join(tmpdir(), "archer-pd1-"));
  const config = join(dir, "archer.toml");
  writeFileSync(config, `version = 1\n[[projects]]\npath = ${JSON.stringify(root)}\ncomments = false\n`);
  const restore = configureWritePolicy({ env: { ARCHER_CONFIG: config } });
  let code: unknown;
  try {
    delivery.reportActivity({ root, agentId: listener, fetched: [{ threadId: thread.id, revision: await revision }] });
  } catch (error) {
    code = (error as { code?: unknown }).code;
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(code).toBe("write_rule_denied");
  expect(status(thread.id)).toBe("sent");
  // Nothing was recorded as delivered: the thread still waits for its listener.
  expect(texts(delivery.inbox({ root, agentId: listener }).messages)).toEqual(["Look at this"]);
});

test("Launch: only while nobody listens live, only for a waiting thread, once per project per 30 s (decision 1)", async () => {
  const { delivery, state, claimed, send, advance, launches } = await setup();
  const code = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "none";
  };
  const first = send("Please draw it");
  const second = send("And this");
  const id = claimed();
  expect(await code(() => delivery.launch(state, first.id))).toBe("listener_live");
  advance(LISTENER_EXPIRY_MS + 1);
  expect(await delivery.launch(state, first.id)).toMatchObject({ launched: true });
  expect(launches).toEqual(["Please draw it"]);
  expect(await code(() => delivery.launch(state, second.id))).toBe("launch_busy");
  advance(30_001);
  delivery.inbox({ root: state.root, agentId: id });
  advance(LISTENER_EXPIRY_MS + 1);
  expect(await code(() => delivery.launch(state, second.id))).toBe("thread_not_waiting");
});

test("the page sees no absolute path in an agent's label (C15, L16)", async () => {
  const { delivery, state, register } = await setup();
  register("Claude Code · /opt/work/secret-project");
  register("Codex · /home/someone/code/app");
  const labels = delivery
    .listing(state)
    .current.agents.map((agent) => agent.label)
    .sort();
  expect(labels).toEqual(["Claude Code · …/secret-project", "Codex · ~/code/app"]);
  expect(pageText("resolves to /srv/x/y, outside /home/someone/p.", "/home/someone")).toBe(
    "resolves to …/y, outside ~/p.",
  );
});

// ---- review round 2 (decisions 16, 17, 18, 23)

test("a failed answer's comment is not lost: a thread in an unwritten answer waits, then comes whole (17, 43, Codex N2)", async () => {
  const { delivery, root, claimed, send, reply, status } = await setup();
  const id = claimed();
  const thread = send("First");
  const write = held();
  const first = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, undefined, write.afterWrite);
  expect("messages" in first && texts(first.messages)).toEqual(["First"]);
  reply(thread.id, "Second");
  // The thread is in an answer not yet written: a second wait is handed nothing of it until that answer settles.
  const second = delivery.waitMessage({ root, agentId: id, timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(status(thread.id)).toBe("sent");
  write.write(false);
  const again = await second;
  expect("messages" in again && texts(again.messages)).toEqual(["First", "Second"]);
  expect(status(thread.id)).toBe("read");
});

test("records, claims and agents survive a restart: the relay registering first leaves the CLI's wait listening (16, N1, N3, N9)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-"));
  const one = await setup({ stateDir });
  const id = one.claimed();
  const thread = one.send("A");
  const got = await one.delivery.waitMessage({ root: one.root, agentId: id, timeoutMs: 1_000 });
  expect("messages" in got && texts(got.messages)).toEqual(["A"]);
  one.delivery.handOver();
  const two = await setup({ stateDir, root: one.root });
  // Loaded with its saved clock (decision 28): it was heard from moments ago, so it is live and still the listener.
  expect(two.delivery.registry.status(two.root)).toMatchObject({
    state: "next-turn",
    away: false,
    listener: { agentId: id },
  });
  // The relay of the same session registers its id first, from another folder of the checkout.
  two.delivery.registerAgent({
    root: two.root,
    cwd: join(two.root, ".archer"),
    host: "claude-code",
    label: "Claude Code · test",
    agentId: id,
  });
  two.reply(thread.id, "B");
  const next = await two.delivery.waitMessage({ root: two.root, agentId: id, timeoutMs: 1_000 });
  // A was received before the restart: only B comes.
  expect("messages" in next && texts(next.messages)).toEqual(["B"]);
});

test("the person's pin beats conversation affinity (18, Claude 5)", async () => {
  const { delivery, state, root, register, claimed, send, reply, advance } = await setup();
  const a = claimed();
  const x = register("X");
  const thread = send("draw it");
  expect(texts(delivery.inbox({ root, agentId: a }).messages)).toEqual(["draw it"]);
  delivery.reportActivity({ root, agentId: a, answered: [thread.id] });
  delivery.pin(state, x);
  reply(thread.id, "now add refresh");
  advance(30_000);
  const got = await delivery.waitMessage({ root, agentId: x, timeoutMs: 1_000 });
  expect("messages" in got && texts(got.messages)).toEqual(["now add refresh"]);
});

test("the listing says personal and launcher only to the person; the event carries neither (23)", async () => {
  const { delivery, state } = await setup();
  expect(delivery.listing(state)).not.toHaveProperty("launcher");
  expect(delivery.listing(state)).not.toHaveProperty("personal");
  expect(delivery.listing(state, { personal: true })).toMatchObject({ personal: true, launcher: true });
  const seen: unknown[] = [];
  const unsubscribe = state.subscribe((event, payload) => {
    if (event === "listeners") seen.push(payload);
  });
  delivery.registerAgent({ root: state.root, cwd: state.root, host: "codex", label: "Codex" });
  unsubscribe();
  expect(seen.length).toBeGreaterThan(0);
  for (const payload of seen) {
    expect(payload).not.toHaveProperty("launcher");
    expect(payload).not.toHaveProperty("personal");
  }
});

test("a thread with more person comments than the old receipt bound still becomes read once all were delivered (decision 27)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("c0");
  // 5,001 person comments since the agent's last turn: one past the 5,000 receipts round 4 kept.
  const file = join(root, ".archer", "flow.comments.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as { threads: { comments: Record<string, unknown>[] }[] };
  const first = data.threads[0]!.comments[0]!;
  data.threads[0]!.comments = Array.from({ length: 5_001 }, (_, i) => ({
    ...first,
    id: `c-${i.toString(16).padStart(12, "0")}`,
    body: `c${i}`,
    createdAt: new Date(Date.parse(String(first["createdAt"])) + i).toISOString(),
  }));
  writeFileSync(file, JSON.stringify(data));
  await expect.poll(() => state.threadById(thread.id)?.comments.length).toBe(5_001);
  const inbox = delivery.inbox({ root, agentId: id });
  expect(inbox.count).toBe(5_001);
  expect(status(thread.id)).toBe("read");
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 20 })).toEqual({ timedOut: true });
});

test("a long thread delivered in two answers still becomes read: an unread thread keeps its record (decisions 35, 55)", async () => {
  const { delivery, state, root, claimed, send, reply, status } = await setup();
  const id = claimed();
  const thread = send("c0");
  // 5,000 person comments held in one unwritten answer.
  const file = join(root, ".archer", "flow.comments.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as { threads: { comments: Record<string, unknown>[] }[] };
  const first = data.threads[0]!.comments[0]!;
  data.threads[0]!.comments = Array.from({ length: 5_000 }, (_, i) => ({
    ...first,
    id: `c-${i.toString(16).padStart(12, "0")}`,
    body: `c${i}`,
    createdAt: new Date(Date.parse(String(first["createdAt"])) + i).toISOString(),
  }));
  writeFileSync(file, JSON.stringify(data));
  await expect.poll(() => state.threadById(thread.id)?.comments.length).toBe(5_000);
  const write = held();
  const answer = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, undefined, write.afterWrite);
  expect("messages" in answer && answer.messages.length).toBe(5_000);
  // Comment 5,001 arrives before that answer is written.
  reply(thread.id, "c5000");
  write.write(true);
  expect(status(thread.id)).toBe("sent");
  const next = delivery.inbox({ root, agentId: id });
  expect(texts(next.messages)).toEqual(["c5000"]);
  expect(status(thread.id)).toBe("read");
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 20 })).toEqual({ timedOut: true });
});

/** Replaces the comments file's threads with `count` sent threads of `per` person comments each. */
function manyThreads(
  root: string,
  count: number,
  per: number,
): {
  file: string;
  data: { threads: { id: string; comments: Record<string, unknown>[] }[] };
  first: Record<string, unknown>;
} {
  const file = join(root, ".archer", "flow.comments.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    threads: { id: string; comments: Record<string, unknown>[] }[];
  };
  const seed = data.threads[0]!;
  const { context: _context, ...first } = seed.comments[0]!;
  const at = Date.parse(String(first["createdAt"]));
  const hex = (n: number) => n.toString(16).padStart(12, "0");
  data.threads = Array.from({ length: count }, (_, t) => ({
    ...seed,
    id: `t-${hex(t)}`,
    comments: Array.from({ length: per }, (_, i) => ({
      ...first,
      id: `c-${hex(t * per + i)}`,
      body: `t${t}c${i}`,
      createdAt: new Date(at + t * per + i).toISOString(),
    })),
  }));
  writeFileSync(file, JSON.stringify(data));
  return { file, data, first };
}

test("one record per thread: 500 threads of 50 comments, each with a later arrival, stay under the file bound and nothing re-delivers after a restart (decision 55)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-"));
  const one = await setup({ stateDir });
  const id = one.claimed();
  one.send("seed");
  const { file, data, first } = manyThreads(one.root, 500, 50);
  await expect.poll(() => one.state.waitingThreads().length).toBe(500);
  const write = held();
  const answer = await one.delivery.waitMessage(
    { root: one.root, agentId: id, timeoutMs: 1_000 },
    undefined,
    write.afterWrite,
  );
  expect("messages" in answer && answer.messages.length).toBe(25_000);
  // Every thread gets one more comment before that answer is written: none of them is read.
  const late = Date.parse(String(first["createdAt"])) + 1_000_000;
  data.threads.forEach((thread, t) =>
    thread.comments.push({
      ...first,
      id: `c-late${String(t).padStart(8, "0")}`,
      body: `late ${t}`,
      createdAt: new Date(late + t).toISOString(),
    }),
  );
  writeFileSync(file, JSON.stringify(data));
  await expect.poll(() => one.state.threadById(data.threads[499]!.id)?.comments.length).toBe(51);
  write.write(true);
  expect(one.delivery.trackedThreads).toBe(500);
  const saved = readFileSync(join(stateDir, "listeners.json"), "utf8");
  expect(Buffer.byteLength(saved)).toBeLessThan(MAX_LISTENERS_BYTES);
  one.delivery.handOver();
  const two = await setup({ stateDir, root: one.root });
  // After the restart only the late comments come, one per thread.
  const inbox = two.delivery.inbox({ root: two.root, agentId: id }, () => {});
  expect(inbox.count).toBe(500);
  expect(new Set(texts(inbox.messages))).toEqual(new Set(data.threads.map((_, t) => `late ${t}`)));
});

// ---- review rounds 6-8 (decisions 49, 55): each sent person comment is recorded with its hash as delivered

/** Rewrites one thread's comments in its file and sends it again (status sent), as an edit from elsewhere would. */
async function rewrite(
  state: ProjectState,
  threadId: string,
  comments: (all: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  const file = join(state.root, ".archer", "flow.comments.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    threads: { id: string; status: string; revision: number; comments: Record<string, unknown>[] }[];
  };
  const thread = data.threads.find((t) => t.id === threadId)!;
  const next = comments(thread.comments);
  thread.comments = next;
  thread.status = "sent";
  thread.revision += 1;
  writeFileSync(file, JSON.stringify(data));
  await expect
    .poll(() =>
      state
        .threadById(threadId)
        ?.comments.map((c) => c.id)
        .join(),
    )
    .toBe(next.map((c) => c["id"]).join());
}

test("an edit of a delivered comment sends that comment again and does not read the thread while it changes (55, round-6 F1)", async () => {
  const { delivery, state, root, claimed, send, reply, status } = await setup();
  const id = claimed();
  const thread = send("A");
  reply(thread.id, "B");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A", "B"]);
  expect(status(thread.id)).toBe("read");
  const a = state.threadById(thread.id)!.comments[0]!;
  state.editComment(thread.id, a.id, { body: "A, edited" });
  state.submitComments({ target: "view:flow", threadId: thread.id });
  expect(status(thread.id)).toBe("sent");
  const write = held();
  const again = delivery.inbox({ root, agentId: id }, write.afterWrite);
  expect(texts(again.messages)).toEqual(["A, edited"]);
  // Edited again while that answer is on its way: its write must not read the changed thread.
  state.editComment(thread.id, a.id, { body: "A, edited twice" });
  state.submitComments({ target: "view:flow", threadId: thread.id });
  write.write(true);
  expect(status(thread.id)).toBe("sent");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A, edited twice"]);
  expect(status(thread.id)).toBe("read");
});

test("a deleted comment, a tied timestamp or an insert before delivered comments loses nothing (55, round-6 F2)", async () => {
  const { delivery, state, root, claimed, send, reply } = await setup();
  const id = claimed();
  const thread = send("A");
  reply(thread.id, "B");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A", "B"]);
  // B removed; C carries B's time, D a newer one.
  await rewrite(state, thread.id, ([a, b]) => [
    a!,
    { ...b!, id: "c-tied", body: "C" },
    { ...b!, id: "c-newer", body: "D", createdAt: new Date(Date.parse(String(b!["createdAt"])) + 5).toISOString() },
  ]);
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["C", "D"]);
  // A comment put in before the delivered ones.
  await rewrite(state, thread.id, ([a, ...rest]) => [a!, { ...a!, id: "c-inserted", body: "X" }, ...rest]);
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["X"]);
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
});

test("an old file's marks load as no record: unanswered person comments come once more (55, round-6 F3)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-"));
  const root = project();
  const one = await setup({ stateDir, root });
  const id = one.claimed();
  const thread = one.send("A");
  one.reply(thread.id, "B");
  const [, b] = one.state.threadById(thread.id)!.comments;
  one.delivery.handOver();
  const file = join(stateDir, "listeners.json");
  const wire = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  // Round 4: B's receipt while A was still undelivered; decision 43: a watermark at B; decision 48: a prefix mark.
  wire["receipts"] = { [one.root]: [[thread.id, b!.id, b!.createdAt, 9_001]] };
  wire["watermarks"] = { [one.root]: [[thread.id, b!.id, b!.createdAt]] };
  wire["delivered"] = { roots: [one.root], marks: [[0, thread.id, 2, "0123456789abcdef", "fedcba9876543210"]] };
  delete wire["records"];
  writeFileSync(file, JSON.stringify(wire), { mode: 0o600 });
  const two = await setup({ stateDir, root });
  expect(two.delivery.trackedThreads).toBe(0);
  two.reply(thread.id, "C");
  expect(texts(two.delivery.inbox({ root: two.root, agentId: id }).messages)).toEqual(["A", "B", "C"]);
  expect(two.status(thread.id)).toBe("read");
});

test("past the thread bound, records of read or gone threads go at once; at most 5,000 load (55, round-8 F4)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-"));
  const root = project();
  const one = await setup({ stateDir, root });
  const id = one.claimed();
  const thread = one.send("A");
  expect(texts(one.delivery.inbox({ root: one.root, agentId: id }).messages)).toEqual(["A"]);
  one.delivery.handOver();
  const file = join(stateDir, "listeners.json");
  const wire = JSON.parse(readFileSync(file, "utf8")) as { records: { roots: string[]; threads: unknown[][] } };
  // 5,000 records of threads that no longer exist, older than the real one: 5,001 in the file.
  wire.records.threads.unshift(...Array.from({ length: 5_000 }, (_, i) => [0, `t-gone${i}`, { c: "0123456789ab" }]));
  writeFileSync(file, JSON.stringify(wire), { mode: 0o600 });
  const two = await setup({ stateDir, root });
  expect(two.delivery.trackedThreads).toBe(5_000);
  // A second thread's delivery makes 5,001: the gone threads' records go before the answer settles.
  const other = two.send("Z");
  two.reply(thread.id, "B");
  expect(texts(two.delivery.inbox({ root: two.root, agentId: id }).messages)).toEqual(["Z", "B"]);
  expect(two.status(thread.id)).toBe("read");
  expect(two.status(other.id)).toBe("read");
  expect(two.delivery.trackedThreads).toBeLessThanOrEqual(5_000);
  two.delivery.handOver();
  const three = await setup({ stateDir, root });
  expect(three.delivery.trackedThreads).toBeLessThanOrEqual(5_000);
  three.reply(thread.id, "C");
  expect(texts(three.delivery.inbox({ root: three.root, agentId: id }).messages)).toEqual(["C"]);
});

test("an answer whose write never settles frees its threads at the deadline; its late write moves nothing (49, Codex F5)", async () => {
  const root = project();
  const state = await ProjectState.open(root, (slug) => `http://127.0.0.1:1/projects/${slug}/`);
  const delivery = new Delivery({ projects: () => [state], home: "/home/someone", writeDeadlineMs: 50 });
  open.push({ state, delivery });
  const id = delivery.registerAgent({ root: state.root, cwd: state.root, host: "claude-code", label: "x" }).agentId;
  delivery.claimListener({ root: state.root, agentId: id });
  const thread = state.createThreadOnce(
    commentOperation.create({
      target: "view:flow",
      anchor: { kind: "view" },
      body: "A",
      context: { page: "/projects/x/" },
    }),
    "service",
  ).thread!;
  state.submitComments({ target: "view:flow", threadId: thread.id });
  const never = held();
  const first = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, undefined, never.afterWrite);
  expect("messages" in first && texts(first.messages)).toEqual(["A"]);
  // A replacement listener's wait gets the thread once the deadline passes.
  const second = await delivery.waitMessage({ root, agentId: id, timeoutMs: 2_000 }, undefined, lost);
  expect("messages" in second && texts(second.messages)).toEqual(["A"]);
  never.write(true);
  expect(state.threadById(thread.id)?.status).toBe("sent");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
});

// ---- review round 7 (decisions 52, 53)

test("an earlier comment edited after the agent's reply is delivered, not silently read (55, round-7 F1)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const { findProject } = await import("../../src/project/index.ts");
  new CommentsStore(findProject(root)).reply(thread.id, "Done", "agent", state.threadById(thread.id)!.revision);
  expect(status(thread.id)).toBe("answered");
  const a = state.threadById(thread.id)!.comments[0]!;
  state.editComment(thread.id, a.id, { body: "A, corrected" });
  state.submitComments({ target: "view:flow", threadId: thread.id });
  expect(status(thread.id)).toBe("sent");
  expect(delivery.inbox({ root, agentId: id, brief: true }).count).toBe(1);
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A, corrected"]);
  expect(status(thread.id)).toBe("read");
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
});

test("a change that records no edit time still comes again: an earlier comment's context changed outside Archer (55, round-7 F1)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const { findProject } = await import("../../src/project/index.ts");
  new CommentsStore(findProject(root)).reply(thread.id, "Done", "agent", state.threadById(thread.id)!.revision);
  await rewrite(state, thread.id, (comments) =>
    comments.map((c) => (c["author"] === "person" ? { ...c, context: { page: "/projects/x/elsewhere" } } : c)),
  );
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  expect(status(thread.id)).toBe("read");
});

test("a context-only change of a delivered comment delivers it again (53, round-7 F2)", async () => {
  const { delivery, state, root, claimed, send, reply, status } = await setup();
  const id = claimed();
  const thread = send("A");
  reply(thread.id, "B");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A", "B"]);
  await rewrite(state, thread.id, ([a, b]) => [
    a!,
    { ...b!, context: { page: "/projects/x/other", document: ".archer/notes/x.md" } },
  ]);
  expect(status(thread.id)).toBe("sent");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["B"]);
  expect(status(thread.id)).toBe("read");
});

test("a draft on a delivered thread wakes nobody; a draft written and removed before a send re-sends nothing (55, round-8 F2)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const revision = state.threadById(thread.id)!.revision;
  state.replyThreadOnce(
    thread.id,
    commentOperation.reply("view:flow", { body: "half a thought", context: { page: "/projects/x/" } }),
    "service",
  );
  expect(state.threadById(thread.id)!.revision).toBeGreaterThan(revision);
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 50 })).toEqual({ timedOut: true });
  const draft = state.threadById(thread.id)!.comments.at(-1)!;
  state.deleteComment(thread.id, draft.id);
  state.submitComments({ target: "view:flow", threadId: thread.id });
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 50 })).toEqual({ timedOut: true });
  expect(["read", "sent"]).toContain(status(thread.id));
});

// ---- review round 8 (decision 55)

test("an edit that records no edit time and a new follow-up both arrive (55, Codex round-8 F1)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const { findProject } = await import("../../src/project/index.ts");
  new CommentsStore(findProject(root)).reply(thread.id, "Done", "agent", state.threadById(thread.id)!.revision);
  // A corrected outside Archer (no editedAt), and a new follow-up B, sent together.
  await rewrite(state, thread.id, ([a, agent]) => [
    { ...a!, body: "A, corrected" },
    agent!,
    {
      ...a!,
      id: "c-follow",
      body: "B",
      createdAt: new Date(Date.parse(String(agent!["createdAt"])) + 1).toISOString(),
    },
  ]);
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A, corrected", "B"]);
  expect(status(thread.id)).toBe("read");
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
});

test("an edit stamped at the agent's reply time still arrives (55, Codex round-8 F1)", async () => {
  const { delivery, state, root, claimed, send } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const { findProject } = await import("../../src/project/index.ts");
  new CommentsStore(findProject(root)).reply(thread.id, "Done", "agent", state.threadById(thread.id)!.revision);
  await rewrite(state, thread.id, ([a, agent]) => [{ ...a!, body: "A2", editedAt: agent!["createdAt"] }, agent!]);
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A2"]);
});

test("status-only changes deliver nothing: resolved and reopened, a draft written and removed (55, Codex round-8 F2)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const { findProject } = await import("../../src/project/index.ts");
  new CommentsStore(findProject(root)).reply(thread.id, "Done", "agent", state.threadById(thread.id)!.revision);
  // Resolved, then put back to sent with the same comments.
  const file = join(root, ".archer", "flow.comments.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    threads: { id: string; status: string; revision: number }[];
  };
  data.threads.find((t) => t.id === thread.id)!.status = "resolved";
  writeFileSync(file, JSON.stringify(data));
  await expect.poll(() => status(thread.id)).toBe("resolved");
  await rewrite(state, thread.id, (comments) => comments);
  expect(status(thread.id)).toBe("sent");
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 50 })).toEqual({ timedOut: true });
  // A draft reply written, removed, and the thread sent.
  state.replyThreadOnce(
    thread.id,
    commentOperation.reply("view:flow", { body: "half a thought", context: { page: "/projects/x/" } }),
    "service",
  );
  state.deleteComment(thread.id, state.threadById(thread.id)!.comments.at(-1)!.id);
  state.submitComments({ target: "view:flow", threadId: thread.id });
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
});

test("each message says where its own comment was sent from; a context-only change on A carries A's new place (55, Codex round-8 F3)", async () => {
  const { delivery, state, root, claimed, status } = await setup();
  const id = claimed();
  const thread = state.createThreadOnce(
    commentOperation.create({
      target: "view:flow",
      anchor: { kind: "view" },
      body: "A",
      context: { page: "/projects/x/page-a" },
    }),
    "service",
  ).thread!;
  state.replyThreadOnce(
    thread.id,
    commentOperation.reply("view:flow", { body: "B", context: { page: "/projects/x/page-b" } }),
    "service",
  );
  state.submitComments({ target: "view:flow", threadId: thread.id });
  const first = delivery.inbox({ root, agentId: id }).messages;
  expect(first.map((m) => m.text)).toEqual(["A", "B"]);
  expect(first[0]!.where).toMatch(/sent from \/projects\/x\/page-a/);
  expect(first[1]!.where).toMatch(/sent from \/projects\/x\/page-b/);
  await rewrite(state, thread.id, ([a, b]) => [{ ...a!, context: { page: "/projects/x/page-a2" } }, b!]);
  const again = delivery.inbox({ root, agentId: id }).messages;
  expect(again.map((m) => m.text)).toEqual(["A"]);
  expect(again[0]!.where).toMatch(/sent from \/projects\/x\/page-a2/);
  expect(again[0]!.where).not.toMatch(/page-b/);
  expect(status(thread.id)).toBe("read");
});

// ---- review round 9 (decisions 56, 57)

/** Changes one thread's target or anchor in its file and sends it again, its comments as they are. */
async function relocate(state: ProjectState, threadId: string, change: Record<string, unknown>): Promise<void> {
  const file = join(state.root, ".archer", "flow.comments.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as { threads: Record<string, unknown>[] };
  const thread = data.threads.find((t) => t["id"] === threadId)!;
  Object.assign(thread, change, { status: "sent", revision: Number(thread["revision"]) + 1 });
  writeFileSync(file, JSON.stringify(data));
  await expect.poll(() => state.threadById(threadId)?.status).toBe("sent");
}

test("re-anchoring a delivered thread delivers its comment again (56, Codex round-9 F1)", async () => {
  const { delivery, state, root, claimed, send, status } = await setup();
  const id = claimed();
  const thread = send("A");
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  await relocate(state, thread.id, { anchor: { kind: "node", id: "api", label: "API" } });
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  expect(status(thread.id)).toBe("read");
});

test("retargeting a delivered thread delivers its comment again (56, Codex round-9 F1)", async () => {
  const root = project();
  const real = await ProjectState.open(root, (slug) => `http://127.0.0.1:1/projects/${slug}/`);
  // The store keeps a thread's target with its file; another source (an import, a move) could change it.
  let retarget: TargetRef | null = null;
  const moved = (thread: Thread | null): Thread | null =>
    thread === null || retarget === null ? thread : { ...thread, target: retarget };
  const state = new Proxy(real, {
    get: (target, key) => {
      if (key === "waitingThreads") return () => target.waitingThreads().map((thread) => moved(thread)!);
      if (key === "threadById") return (id: string) => moved(target.threadById(id));
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const delivery = new Delivery({ projects: () => [state], home: "/home/someone" });
  open.push({ state: real, delivery });
  const id = delivery.registerAgent({ root: real.root, cwd: real.root, host: "claude-code", label: "x" }).agentId;
  delivery.claimListener({ root: real.root, agentId: id });
  const thread = real.createThreadOnce(
    commentOperation.create({
      target: "view:flow",
      anchor: { kind: "view" },
      body: "A",
      context: { page: "/projects/x/" },
    }),
    "service",
  ).thread!;
  real.submitComments({ target: "view:flow", threadId: thread.id });
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  await relocate(real, thread.id, {});
  retarget = "view:other";
  expect(texts(delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
});

test("a late acknowledgement never undoes a newer pull's records (57, Codex round-9 F2)", async () => {
  const { delivery, state, root, claimed, send, reply, status } = await setup();
  const id = claimed();
  const thread = send("A");
  const write = held();
  const answer = await delivery.waitMessage({ root, agentId: id, timeoutMs: 1_000 }, undefined, write.afterWrite);
  expect("messages" in answer && texts(answer.messages)).toEqual(["A"]);
  // While that answer is on its way: A edited to A2, B added, both sent; the agent pulls that revision.
  const a = state.threadById(thread.id)!.comments[0]!;
  state.editComment(thread.id, a.id, { body: "A2" });
  reply(thread.id, "B");
  const pulled = state.threadById(thread.id)!;
  expect(
    delivery.reportActivity({ root, agentId: id, fetched: [{ threadId: thread.id, revision: pulled.revision }] }),
  ).toEqual({ read: [thread.id] });
  const { findProject } = await import("../../src/project/index.ts");
  new CommentsStore(findProject(root)).reply(thread.id, "Done", "agent", pulled.revision);
  expect(status(thread.id)).toBe("answered");
  // The older answer is acknowledged only now.
  write.write(true);
  // A draft written, removed, and the thread sent: nothing of the person's changed since the pull.
  state.replyThreadOnce(
    thread.id,
    commentOperation.reply("view:flow", { body: "half a thought", context: { page: "/projects/x/" } }),
    "service",
  );
  state.deleteComment(thread.id, state.threadById(thread.id)!.comments.at(-1)!.id);
  state.submitComments({ target: "view:flow", threadId: thread.id });
  expect(delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  expect(await delivery.waitMessage({ root, agentId: id, timeoutMs: 50 })).toEqual({ timedOut: true });
});

test("record order survives a restart: an acknowledgement older than a pull before the restart moves nothing after it (57)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-"));
  const root = project();
  const one = await setup({ stateDir, root });
  const id = one.claimed();
  const thread = one.send("A");
  expect(texts(one.delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  one.delivery.handOver();
  const saved = JSON.parse(readFileSync(join(stateDir, "listeners.json"), "utf8")) as {
    records: { seq: number; threads: [number, string, Record<string, [string, number]>][] };
  };
  const entry = saved.records.threads.find(([, t]) => t === thread.id)!;
  expect(Object.values(entry[2])[0]![1]).toBe(saved.records.seq);
  const two = await setup({ stateDir, root });
  two.reply(thread.id, "B");
  const got = two.delivery.inbox({ root, agentId: id }).messages;
  expect(texts(got)).toEqual(["B"]);
  const again = JSON.parse(readFileSync(join(stateDir, "listeners.json"), "utf8")) as { records: { seq: number } };
  expect(again.records.seq).toBeGreaterThan(saved.records.seq);
});

// ---- review round 10 (decision 59)

test("a saved sequence at the safe-integer limit is replaced on load: an edit is delivered once (59, Codex round-10 F2)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-"));
  const root = project();
  const one = await setup({ stateDir, root });
  const id = one.claimed();
  one.delivery.handOver();
  const file = join(stateDir, "listeners.json");
  const wire = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  wire["records"] = { roots: [root], threads: [], seq: Number.MAX_SAFE_INTEGER };
  writeFileSync(file, JSON.stringify(wire), { mode: 0o600 });
  const two = await setup({ stateDir, root });
  const thread = two.send("A");
  expect(texts(two.delivery.inbox({ root, agentId: id }).messages)).toEqual(["A"]);
  const a = two.state.threadById(thread.id)!.comments[0]!;
  two.state.editComment(thread.id, a.id, { body: "A2" });
  two.state.submitComments({ target: "view:flow", threadId: thread.id });
  expect(texts(two.delivery.inbox({ root, agentId: id }).messages)).toEqual(["A2"]);
  expect(two.status(thread.id)).toBe("read");
  expect(two.delivery.inbox({ root, agentId: id })).toMatchObject({ count: 0 });
  const saved = JSON.parse(readFileSync(file, "utf8")) as { records: { seq: number } };
  expect(saved.records.seq).toBeLessThan(2 ** 48);
});
