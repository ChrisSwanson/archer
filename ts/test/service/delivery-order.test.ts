// The delivery order (ADR 0035, amended 2026-10-31): a sent message goes to an agent listening now, else a
// registered session between turns gets next_turn_wait to take it, else the person's launcher runs, when
// launch = "auto" and the sender qualifies under launch_for. A real ProjectState on a temp project; the
// Delivery is driven directly on a controlled clock, with its timers run by the test.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LISTENER_EXPIRY_MS } from "../../src/agents/contract.ts";
import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicy } from "../../src/config/agents.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { Delivery, LAUNCH_REPEAT_MS, LAUNCHING_SHOWN_MS, type DeliveryTimers } from "../../src/service/listeners.ts";
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

const AUTO: DeliveryPolicy = { ...DEFAULT_DELIVERY_POLICY, launch: "auto" };
const OWNER = { owner: true } as const,
  LINK = { owner: false } as const;

/** A clock and the timers on it: `advance` moves the clock and runs what fell due, in order. */
function clock(start = 1_000_000_000) {
  let now = start,
    next = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: DeliveryTimers = {
    set: (run, ms) => {
      const id = ++next;
      due.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => {
      due.delete(id as number);
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      const [id, first] = [...due].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (first === undefined || first.at > end) break;
      due.delete(id!);
      now = first.at;
      first.run();
      // A launch is a promise: let it settle before the next timer.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { now: () => now, timers, advance, pending: () => due.size };
}

async function setup(
  options: { stateDir?: string; root?: string; policy?: DeliveryPolicy; time?: ReturnType<typeof clock> } = {},
) {
  const root = options.root ?? project();
  const state = await ProjectState.open(root, (slug) => `http://127.0.0.1:1/projects/${slug}/`);
  const time = options.time ?? clock();
  let policy: DeliveryPolicy | Error = options.policy ?? AUTO;
  const launches: string[] = [];
  const delivery = new Delivery({
    projects: () => [state],
    now: time.now,
    timers: time.timers,
    home: "/home/someone",
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    policy: () => {
      if (policy instanceof Error) throw policy;
      return policy;
    },
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
  /** The person writes and sends from the page, as the comments route does: then it arrives with their sign-in. */
  const send = (body: string, sender: { owner: boolean } = OWNER): Thread => {
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
    delivery.arrived(state, [thread.id], sender);
    return thread;
  };
  const reply = (threadId: string, body: string, sender: { owner: boolean } = OWNER): void => {
    state.replyThreadOnce(
      threadId,
      commentOperation.reply("view:flow", { body, context: { page: "/projects/x/" } }),
      "service",
    );
    state.submitComments({ target: "view:flow", threadId });
    delivery.arrived(state, [threadId], sender);
  };
  /** The steps as the owner's own sign-in reads them (D10: nobody else gets them). */
  const pending = () => delivery.listing(state, { personal: true }).pending ?? [];
  return {
    state,
    delivery,
    root: state.root,
    register,
    claimed,
    send,
    reply,
    launches,
    pending,
    time,
    setPolicy: (next: DeliveryPolicy | Error) => {
      policy = next;
    },
  };
}

describe("the order", () => {
  test("an agent listening now takes the message: nothing waits and nothing launches", async () => {
    const { delivery, root, claimed, send, launches, pending, time } = await setup();
    const id = claimed();
    const waiting = delivery.waitMessage({ root, agentId: id, timeoutMs: 60_000 });
    send("Draw the auth flow");
    expect(pending()).toEqual([]);
    const got = await waiting;
    expect("messages" in got && got.messages.map((m) => m.text)).toEqual(["Draw the auth flow"]);
    await time.advance(10 * 60_000);
    expect(launches).toEqual([]);
  });

  test("a listener between turns gets next_turn_wait; when it takes the message, nothing launches", async () => {
    const { delivery, state, root, claimed, send, launches, pending, time } = await setup();
    const id = claimed();
    const thread = send("Add the refresh path");
    expect(pending()).toEqual([
      {
        threadId: thread.id,
        step: "next-turn",
        host: "claude-code",
        waitMs: 120_000,
        until: new Date(time.now() + 120_000).toISOString(),
      },
    ]);
    // A link holder's or paired device's view of the listing has no step (D10).
    expect(delivery.listing(state)).not.toHaveProperty("pending");
    await time.advance(60_000);
    expect(delivery.inbox({ root, agentId: id }).messages.map((m) => m.text)).toEqual(["Add the refresh path"]);
    expect(pending()).toEqual([]);
    await time.advance(10 * 60_000);
    expect(launches).toEqual([]);
  });

  test("nobody takes it in the wait: the launcher runs once the listener is away, with the message", async () => {
    const { claimed, send, launches, pending, time } = await setup();
    claimed();
    await time.advance(30_000);
    const thread = send("Nobody is here");
    await time.advance(120_000 - 1);
    expect(launches).toEqual([]);
    await time.advance(1);
    expect(launches).toEqual(["Nobody is here"]);
    expect(pending()).toEqual([{ threadId: thread.id, step: "launching", until: expect.any(String) }]);
  });

  test("a listener heard from during the wait is still live at its end: the launch waits until it is away", async () => {
    const { delivery, claimed, send, launches, time } = await setup();
    const id = claimed();
    send("Wait for me");
    await time.advance(100_000);
    delivery.heartbeat({ agentId: id, via: "hook" });
    await time.advance(20_000);
    expect(launches).toEqual([]);
    await time.advance(LISTENER_EXPIRY_MS + 100_000 - 20_000);
    expect(launches).toEqual(["Wait for me"]);
  });

  test("nobody registered: the launcher runs at once", async () => {
    const { send, launches, pending } = await setup();
    send("Start someone");
    await Promise.resolve();
    expect(launches).toEqual(["Start someone"]);
    expect(pending()).toMatchObject([{ step: "launching" }]);
  });

  test("a session registered here but not listening gets the wait too", async () => {
    const { register, send, launches, pending, time } = await setup();
    register("Codex · test");
    send("Over to you");
    expect(pending()).toMatchObject([{ step: "next-turn" }]);
    await time.advance(120_000);
    expect(launches).toEqual(["Over to you"]);
  });

  test("next_turn left out: no wait; a live listener between turns still blocks the launch, the message waits", async () => {
    const { claimed, send, launches, pending, time } = await setup({
      policy: { ...AUTO, order: ["listener", "launch"] },
    });
    claimed();
    send("Straight to launch?");
    await time.advance(10 * 60_000);
    expect(launches).toEqual([]);
    expect(pending()).toEqual([]);
  });

  test("a next_turn_wait of 0s skips the wait", async () => {
    const { register, send, launches } = await setup({ policy: { ...AUTO, nextTurnWaitMs: 0 } });
    register();
    send("Now");
    await Promise.resolve();
    expect(launches).toEqual(["Now"]);
  });
});

describe("defaults and who may launch", () => {
  test("launch = ask (and no launcher: the default) never starts a process", async () => {
    const { send, register, launches, pending, time } = await setup({ policy: DEFAULT_DELIVERY_POLICY });
    send("Hello");
    register();
    send("Anyone?");
    await time.advance(60 * 60_000);
    expect(launches).toEqual([]);
    expect(pending()).toEqual([]);
  });

  test("launch_for owner: an access link's or paired device's message never launches; the owner's does", async () => {
    const { delivery, root, send, launches, time } = await setup();
    send("From a link", LINK);
    await time.advance(10 * 60_000);
    expect(launches).toEqual([]);
    // It still waits for the next agent.
    expect(delivery.inbox({ root }).messages.map((m) => m.text)).toEqual(["From a link"]);
    send("From the owner", OWNER);
    await Promise.resolve();
    expect(launches).toEqual(["From the owner"]);
  });

  test("launch_for anyone: a link holder's message launches too", async () => {
    const { send, launches } = await setup({ policy: { ...AUTO, launchFor: "anyone" } });
    send("From a link", LINK);
    await Promise.resolve();
    expect(launches).toEqual(["From a link"]);
  });

  test("the sender is judged when the message arrives; config narrowed during the wait wins at its end", async () => {
    const { register, send, launches, setPolicy, time } = await setup();
    register();
    send("Owner, waiting");
    setPolicy({ ...AUTO, launch: "ask" });
    await time.advance(10 * 60_000);
    expect(launches).toEqual([]);
  });

  test("X-16: launch_for narrowed to owner during the wait: a link holder's waiting message does not launch at its end", async () => {
    const { delivery, root, register, send, launches, setPolicy, pending, time } = await setup({
      policy: { ...AUTO, launchFor: "anyone" },
    });
    register();
    send("From a link, waiting", LINK);
    expect(pending()).toMatchObject([{ step: "next-turn" }]);
    setPolicy(AUTO);
    await time.advance(10 * 60_000);
    expect(launches).toEqual([]);
    expect(pending()).toEqual([]);
    expect(delivery.inbox({ root }).messages.map((m) => m.text)).toEqual(["From a link, waiting"]);
  });

  test("X-16: narrowed to owner, the owner's own waiting message still launches at the wait's end", async () => {
    const { register, send, launches, setPolicy, time } = await setup({ policy: { ...AUTO, launchFor: "anyone" } });
    register();
    send("From the owner, waiting");
    setPolicy(AUTO);
    await time.advance(120_000);
    expect(launches).toEqual(["From the owner, waiting"]);
  });

  test("X-16: launch_for narrowed while a link holder's message waits for the launched agent: the next step launches nothing", async () => {
    const { send, reply, launches, setPolicy, time } = await setup({ policy: { ...AUTO, launchFor: "anyone" } });
    const thread = send("First, from a link", LINK);
    await Promise.resolve();
    expect(launches).toEqual(["First, from a link"]);
    await time.advance(LAUNCH_REPEAT_MS + 1);
    reply(thread.id, "Second, from a link", LINK);
    setPolicy(AUTO);
    await time.advance(10 * 60_000);
    expect(launches).toEqual(["First, from a link"]);
  });

  test("config that cannot be read starts nothing", async () => {
    const { send, launches, setPolicy, pending } = await setup();
    setPolicy(new Error("archer.toml cannot be used"));
    send("Broken config");
    await Promise.resolve();
    expect(launches).toEqual([]);
    expect(pending()).toEqual([]);
  });
});

describe("once per message, once per project window", () => {
  test("two messages moments apart start one agent; an edit of a launched-for message starts none", async () => {
    const { state, send, launches, time } = await setup();
    const first = send("One");
    send("Two");
    await Promise.resolve();
    expect(launches).toEqual(["One"]);
    await time.advance(LAUNCH_REPEAT_MS + 1);
    const comment = state.threadById(first.id)!.comments[0]!;
    state.editComment(first.id, comment.id, { body: "One, edited" });
    state.submitComments({ target: "view:flow", threadId: first.id });
    expect(state.threadById(first.id)?.status).toBe("sent");
    delivery(state).arrived(state, [first.id], OWNER);
    await time.advance(10 * 60_000);
    expect(launches).toEqual(["One"]);
  });

  test("a new message on the thread after the window may launch again", async () => {
    const { send, reply, launches, time } = await setup();
    const thread = send("One");
    await Promise.resolve();
    await time.advance(LAUNCH_REPEAT_MS + 1);
    reply(thread.id, "Still there?");
    await Promise.resolve();
    // The first launch is still showing as starting: the new message waits for it, then starts one more.
    expect(launches).toEqual(["One"]);
    await time.advance(LAUNCHING_SHOWN_MS);
    expect(launches).toEqual(["One", "One\n\nStill there?"]);
  });

  test("a link holder's message on a launched-for thread starts no second launch under launch_for owner", async () => {
    const { send, reply, launches, time } = await setup();
    const thread = send("One");
    await Promise.resolve();
    reply(thread.id, "From a link", LINK);
    await time.advance(10 * 60_000);
    expect(launches).toEqual(["One"]);
  });

  test("a launched agent that claims but never takes the message: no step promises a second launch for it", async () => {
    const { delivery, root, register, send, launches, pending, time } = await setup();
    send("One");
    await Promise.resolve();
    expect(launches).toEqual(["One"]);
    // The launched agent claims, then goes quiet between turns without taking the message.
    const id = register();
    delivery.claimListener({ root, agentId: id });
    await time.advance(LAUNCHING_SHOWN_MS);
    expect(pending()).toEqual([]);
    await time.advance(10 * 60_000);
    expect(launches).toEqual(["One"]);
  });

  test("Launch pressed during the wait: the wait's end starts no second agent", async () => {
    const { delivery, state, register, send, launches, time } = await setup();
    register();
    const thread = send("Press it");
    await time.advance(10_000);
    await delivery.launch(state, thread.id);
    expect(launches).toEqual(["Press it"]);
    await time.advance(10 * 60_000);
    expect(launches).toEqual(["Press it"]);
  });

  test("launch = off removes the button: Launch is refused and the listing offers none", async () => {
    const { delivery, state, send } = await setup({ policy: { ...AUTO, launch: "off" } });
    const thread = send("No launching here");
    await expect(delivery.launch(state, thread.id)).rejects.toMatchObject({ code: "launch_off" });
    expect(delivery.listing(state, { personal: true })).not.toHaveProperty("launcher");
  });
});

describe("an edit by someone else (C-23)", () => {
  /** The page's edit, sent again at once, as the comments route does with the editor's sign-in. */
  const edit = (
    env: Awaited<ReturnType<typeof setup>>,
    thread: Thread,
    body: string,
    sender: { owner: boolean },
  ): void => {
    const comment = env.state.threadById(thread.id)!.comments[0]!;
    env.state.editComment(thread.id, comment.id, { body });
    env.state.submitComments({ target: "view:flow", threadId: thread.id });
    env.delivery.arrived(env.state, [thread.id], sender);
  };

  test("a link holder's edit of the owner's waiting message cancels its automatic launch; it waits in the inbox", async () => {
    const env = await setup();
    env.register();
    const thread = env.send("Draw the auth flow");
    await env.time.advance(30_000);
    edit(env, thread, "Delete the repository", LINK);
    await env.time.advance(10 * 60_000);
    expect(env.launches).toEqual([]);
    expect(env.pending()).toEqual([]);
    expect(env.delivery.inbox({ root: env.root }).messages.map((m) => m.text)).toEqual(["Delete the repository"]);
  });

  test("under launch_for anyone too, an edit by someone other than its sender cancels the launch", async () => {
    const env = await setup({ policy: { ...AUTO, launchFor: "anyone" } });
    env.register();
    const thread = env.send("The owner's words");
    edit(env, thread, "Someone else's words", LINK);
    await env.time.advance(10 * 60_000);
    expect(env.launches).toEqual([]);
  });

  test("an edit left unsent at the wait's end, then sent by the link holder: still no launch", async () => {
    const env = await setup({ policy: { ...AUTO, launchFor: "anyone" } });
    env.register();
    const thread = env.send("The owner's words");
    const comment = env.state.threadById(thread.id)!.comments[0]!;
    env.state.editComment(thread.id, comment.id, { body: "Rewritten" });
    await env.time.advance(120_000);
    env.state.submitComments({ target: "view:flow", threadId: thread.id });
    env.delivery.arrived(env.state, [thread.id], LINK);
    await env.time.advance(10 * 60_000);
    expect(env.launches).toEqual([]);
  });

  test("the owner's own edit during the wait keeps the launch, with the edited text", async () => {
    const env = await setup();
    env.register();
    const thread = env.send("First words");
    edit(env, thread, "Better words", OWNER);
    await env.time.advance(120_000);
    expect(env.launches).toEqual(["Better words"]);
  });
});

describe("a restart", () => {
  test("waits do not resume: after a hand-over the message is in the inbox and nothing launches", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-order-"));
    const time = clock();
    const one = await setup({ stateDir, time });
    one.register();
    one.send("Before the restart");
    expect(one.pending()).toMatchObject([{ step: "next-turn" }]);
    one.delivery.handOver();
    const two = await setup({ stateDir, root: one.root, time });
    expect(two.pending()).toEqual([]);
    await time.advance(60 * 60_000);
    expect([...one.launches, ...two.launches]).toEqual([]);
    expect(two.delivery.inbox({ root: two.root }).messages.map((m) => m.text)).toEqual(["Before the restart"]);
  });

  test("X-17: once per message survives a hand-over: the launched-for message, edited and sent again, starts nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-order-"));
    const time = clock();
    const one = await setup({ stateDir, time });
    const first = one.send("Launched once");
    await Promise.resolve();
    expect(one.launches).toEqual(["Launched once"]);
    one.delivery.handOver();
    const two = await setup({ stateDir, root: one.root, time });
    await time.advance(LAUNCH_REPEAT_MS + 1);
    const comment = two.state.threadById(first.id)!.comments[0]!;
    two.state.editComment(first.id, comment.id, { body: "Launched once, edited" });
    two.state.submitComments({ target: "view:flow", threadId: first.id });
    two.delivery.arrived(two.state, [first.id], OWNER);
    await time.advance(10 * 60_000);
    expect(two.launches).toEqual([]);
  });

  test("X-17: the project's 30-second window survives a hand-over", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-order-"));
    const time = clock();
    const one = await setup({ stateDir, time });
    one.send("One");
    await Promise.resolve();
    expect(one.launches).toEqual(["One"]);
    one.delivery.handOver();
    await time.advance(1_000);
    const two = await setup({ stateDir, root: one.root, time });
    two.send("Two, moments later");
    await time.advance(10 * 60_000);
    expect(two.launches).toEqual([]);
    // After the window a new message launches again.
    two.send("Three, later");
    await Promise.resolve();
    expect(two.launches).toEqual(["Three, later"]);
  });

  test("X-17: the remembered launches are kept in listeners.json, never the message", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "archer-delivery-order-"));
    const time = clock();
    const one = await setup({ stateDir, time, policy: { ...AUTO, nextTurnWaitMs: 0 } });
    for (let i = 0; i < 3; i++) {
      one.send(`Message ${i}`);
      await time.advance(LAUNCH_REPEAT_MS + 1);
    }
    expect(one.launches).toHaveLength(3);
    const saved = JSON.parse(readFileSync(join(stateDir, "listeners.json"), "utf8")) as {
      launches?: { launchedFor: unknown[]; launched: unknown[] };
    };
    expect(saved.launches?.launchedFor).toHaveLength(3);
    expect(saved.launches?.launched).toHaveLength(1);
    expect(JSON.stringify(saved.launches)).not.toMatch(/Message/u);
  });
});

const delivery = (state: ProjectState): Delivery => open.find((entry) => entry.state === state)!.delivery;
