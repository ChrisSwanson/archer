// The listener's commands (ADR 0035 §7–8): `projects`, `listen --claim`, `wait` and `inbox`, against
// a fake service on a real socket that answers the contract's methods (agents/contract.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { briefLine, claimText, type AgentInfo, type InboxMessage } from "../../src/agents/contract.ts";
import { connectService } from "../../src/service/service-client.ts";
import { defaultDeps, runInbox, runListen, runWait, type AgentDeps } from "../../src/bin/agents.ts";
import {
  detectHost,
  detectOnce,
  hostOf,
  hostOfArgs,
  psProcess,
  readProcess,
  recogniseAgent,
  rememberAgent,
  type ProcessFacts,
  type RunPs,
} from "../../src/bin/agent-id.ts";
import { callerAgentId, reportIn } from "../../src/bin/agents.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { closeFakes, fakeService, Refusal, type FakeService } from "./fake-agent-service.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(async () => {
  await closeFakes();
  removeTempDirs();
});

const HOST = { host: "claude-code", hostPid: 4242 } as const;

function setup(fake: FakeService, files: Record<string, string> = { "archer.toml": 'version = 1\nname = "demo"\n' }) {
  const root = tempDir(files);
  const env = {
    ARCHER_SOCKET: fake.socketPath,
    ARCHER_STATE_DIR: join(fake.dir, "state"),
    ARCHER_HOME: join(fake.dir, "home"),
    HOME: fake.dir,
    ARCHER_AUTO_START: "false",
  };
  mkdirSync(env.ARCHER_STATE_DIR, { recursive: true, mode: 0o700 });
  let out = "",
    err = "";
  const io: Io = {
    cwd: root,
    env,
    isTTY: false,
    columns: undefined,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  };
  // The host process (4242) is alive unless a test says otherwise; no timer watches it.
  const deps: AgentDeps = {
    ...defaultDeps,
    detect: () => HOST,
    sleep: async () => undefined,
    hostAlive: () => true,
    watchHost: () => () => undefined,
  };
  return {
    root,
    env,
    io,
    deps,
    output: () => ({ out, err }),
    reset: () => {
      out = "";
      err = "";
    },
  };
}

const agent = (root: string, agentId = "agt_1"): AgentInfo => ({
  agentId,
  root,
  cwd: root,
  host: "claude-code",
  label: "Claude Code · ~/demo",
  lastActive: "2026-10-26T12:00:00.000Z",
});

function claiming(fake: FakeService, pinnedBy?: AgentInfo): void {
  let next = 0;
  const known = new Set<string>();
  fake.handlers["registerAgent"] = (params) => {
    if (params["agentId"] === "held") throw new Refusal("agent_id_taken", "a live agent holds it");
    if (typeof params["agentId"] === "string") known.add(params["agentId"]);
    return { agentId: typeof params["agentId"] === "string" ? params["agentId"] : `agt_${++next}` };
  };
  fake.handlers["claimListener"] = (params) => {
    const listener = agent(String(params["root"]), String(params["agentId"]));
    if (!/^agt_\d+$/.test(String(params["agentId"])) && !known.has(String(params["agentId"])))
      throw new Refusal("agent_unknown", "no such agent");
    const claimedRoot = String(params["root"]);
    return pinnedBy === undefined
      ? { claimed: true, claimedRoot, listener, text: claimText("demo", "main", "~/demo") }
      : {
          claimed: false,
          claimedRoot,
          listener: pinnedBy,
          pinnedBy,
          text: `The person picked ${pinnedBy.label} to listen in demo`,
        };
  };
  // Nobody holds the claim unless a test says so: a revival claims again.
  fake.handlers["listListeners"] = (params) => ({
    current: { root: params["root"], state: "none", listener: null, pinnedByPerson: false, agents: [] },
    otherCheckouts: [],
  });
}

test("listen --claim registers, then claims, and prints exactly what it claimed and the agent id", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { root, io, deps, output, env } = setup(fake);
  expect(await runListen(["--claim"], io, deps), output().err).toBe(0);
  expect(output().out).toBe(
    `${claimText("demo", "main", "~/demo")}\nAgent id: agt_1\nTell the person that line, then keep listening: run  archer wait  in the background, and again after each message.\n`,
  );
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "registerAgent", "claimListener"]);
  expect(fake.requests[1]!.params).toEqual({
    root,
    cwd: root,
    host: "claude-code",
    label: expect.stringMatching(/^Claude Code · /),
    hostPid: 4242,
  });
  expect(fake.requests[2]!.params).toEqual({ root, agentId: "agt_1" });
  // The session's environment file: later calls under the same host process find the id there.
  const file = join(env.ARCHER_STATE_DIR, "agents", "claude-code-4242.env");
  expect(readFileSync(file, "utf8")).toBe(
    `ARCHER_AGENT_ID=agt_1\nARCHER_AGENT_ROOT=${root}\nARCHER_AGENT_CWD=${root}\n`,
  );
  expect(recogniseAgent({ env, cwd: join(root, "src"), detected: HOST })).toEqual({
    agentId: "agt_1",
    root,
    cwd: root,
  });
  expect(recogniseAgent({ env, cwd: "/elsewhere", detected: HOST })).toBeNull();
  expect(recogniseAgent({ env, cwd: root, detected: { host: "claude-code", hostPid: 7 } })).toBeNull();
});

test("listen --claim from a shell with no host process says why --as is needed on later calls", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output } = setup(fake);
  expect(await runListen(["--claim"], io, { ...deps, detect: () => ({ host: "other" }) }), output().err).toBe(0);
  expect(output().out).toMatch(/Pass --as agt_1 to archer wait and archer inbox/);
  expect(output().out).toMatch(/cannot tell later calls come from this session without it/);
});

test("a second claim from the same session reuses its id; a forgotten id registers again under the same id", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output } = setup(fake);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  fake.requests.length = 0;
  expect(await runListen(["--claim"], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "claimListener"]);
  fake.requests.length = 0;
  expect(await runListen(["--claim", "--as", "gone"], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "claimListener", "registerAgent", "claimListener"]);
  expect(fake.requests[2]!.params).toMatchObject({ agentId: "gone" });
  expect(output().out).toContain("Agent id: gone");
  // An id a live agent elsewhere holds gives way to a new one.
  fake.requests.length = 0;
  expect(await runListen(["--claim", "--as", "held"], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toEqual([
    "hello",
    "claimListener",
    "registerAgent",
    "registerAgent",
    "claimListener",
  ]);
  expect(fake.requests[3]!.params["agentId"]).toBeUndefined();
});

test("when the person pinned another listener, the claim says so instead of taking over", async () => {
  const fake = await fakeService();
  const pinned = { ...agent("/x", "agt_9"), label: "Codex · ~/demo" };
  claiming(fake, pinned);
  const { io, deps, output } = setup(fake);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  expect(output().out).toContain(
    "The person picked another listener (Codex · ~/demo): say so in the thread rather than taking over.",
  );
});

// Decision 15: no cross-checkout listening in 0.7.0; an agent listens to the checkout it works in.
test("listen --claim of another project is refused as deferred, naming the fix: run it from inside that checkout", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output } = setup(fake);
  for (const args of [
    ["--claim", "--project", "other", "--person-requested"],
    ["--claim", "--project", "other"],
    ["--claim", "--person-requested"],
  ]) {
    await expect(runListen(args, io, deps)).rejects.toThrow(
      /claiming another checkout is deferred.*run {2}archer listen --claim {2}from inside that checkout/,
    );
  }
  expect(fake.requests).toEqual([]);
  // Through main, a usage error with the same words.
  expect(await main(["listen", "--claim", "--project", "other", "--person-requested"], io)).toBe(2);
  expect(output().err).toMatch(/deferred/);
});

// A session file an older CLI wrote after `--project`: its claim of another checkout is no longer followed.
test("wait and inbox address the checkout the agent registered in, even when an older session file names another", async () => {
  const fake = await fakeService({
    waitMessage: () => ({ messages: [MESSAGE] }),
    inbox: () => ({ count: 0, messages: [] }),
  });
  const { root, env, io, deps, output } = setup(fake);
  mkdirSync(join(env.ARCHER_STATE_DIR, "agents"), { recursive: true });
  writeFileSync(
    join(env.ARCHER_STATE_DIR, "agents", "claude-code-4242.env"),
    `ARCHER_AGENT_ID=agt_1\nARCHER_AGENT_ROOT=${root}\nARCHER_AGENT_CWD=${root}\nARCHER_AGENT_CLAIMED_ROOT=/code/other\nARCHER_AGENT_PROJECT=other\n`,
  );
  expect(await runWait([], io, deps), output().err).toBe(0);
  expect(fake.requests.find((r) => r.method === "waitMessage")!.params).toMatchObject({ root, agentId: "agt_1" });
  expect(await runInbox([], io, deps), output().err).toBe(0);
  expect(fake.requests.at(-1)).toEqual({ method: "inbox", params: { root, agentId: "agt_1" } });
});

// Decision 13: a label never carries an absolute path; outside the home folder only the folder's name.
test("agent labels name the folder under ~ or by its name, never by an absolute path", async () => {
  const { agentLabel } = await import("../../src/bin/agent-id.ts");
  expect(agentLabel("claude-code", "/home/u/code/archer", "/home/u")).toBe("Claude Code · ~/code/archer");
  expect(agentLabel("codex", "/home/u", "/home/u")).toBe("Codex · ~");
  expect(agentLabel("other", "/srv/work/archer", "/home/u")).toBe("Agent · archer");
  expect(agentLabel("other", "/", "/home/u")).toBe("Agent · /");
  // One length rule with the registry: 80 code points, never half an emoji (decision 26).
  const long = agentLabel("other", `/home/u/${"😀".repeat(100)}`, "/home/u");
  expect([...long]).toHaveLength(80);
  expect(long).toBe(`Agent · ~/${"😀".repeat(69)}…`);
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output } = setup(fake);
  expect(await runListen(["--claim"], io, deps), output().err).toBe(0);
  // The temp project is outside this test's HOME, so only its folder name is sent.
  const label = String(fake.requests[1]!.params["label"]);
  expect(label).toMatch(/^Claude Code · archer-project-[^/]+$/);
});

test("listen without --claim shows this checkout's listener and the other checkouts", async () => {
  const fake = await fakeService();
  const { root, io, deps, output } = setup(fake);
  fake.handlers["listListeners"] = () => ({
    current: { root, state: "listening", listener: agent(root), pinnedByPerson: false, agents: [] },
    otherCheckouts: [
      { root: "/w", name: "demo (wt)", state: "none", listener: null, pinnedByPerson: false, agents: [] },
    ],
  });
  expect(await runListen([], io, deps), output().err).toBe(0);
  expect(output().out).toBe(
    "Listening (Claude Code · ~/demo, last active 2026-10-26T12:00:00.000Z)\n  demo (wt): No agent is listening in this checkout\n",
  );
});

const MESSAGE: InboxMessage = {
  threadId: "thr_1",
  commentId: "c_1",
  target: "project:",
  text: "Can you draw the login flow?\nWith the token.",
  at: "2026-10-26T12:01:00.000Z",
  where: "notes/login.md, lines 3–5",
};

test("wait re-dials on {reconnect}, then prints the message with where it points and exits 0", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output, reset } = setup(fake);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  reset();
  let calls = 0;
  fake.handlers["waitMessage"] = () => (++calls === 1 ? { reconnect: true } : { messages: [MESSAGE] });
  fake.requests.length = 0;
  expect(await runWait([], io, deps), output().err).toBe(0);
  expect(output().out).toBe(
    "Message from the person in Archer (the project conversation, thread thr_1, 2026-10-26T12:01:00.000Z):\n> Can you draw the login flow?\n> With the token.\nWhere: notes/login.md, lines 3–5\n\nAnswer the person (a thread: archer call reply_comment), then run  archer wait  again in the background to keep listening.\n",
  );
  // Two connections: the reconnect closed the first.
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "waitMessage", "hello", "waitMessage"]);
  expect(fake.requests[1]!.params).toMatchObject({ agentId: "agt_1", timeoutMs: 600_000 });
});

test("wait survives the service going away mid-wait (a hot swap) and listens on the replacement", async () => {
  const old = await fakeService();
  claiming(old);
  const { io, deps, output, env } = setup(old);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  let replacement: FakeService | null = null;
  old.handlers["waitMessage"] = async () => {
    // The old copy closes without answering; the replacement listens on the same socket.
    await old.close();
    replacement = await fakeService(
      { waitMessage: () => ({ messages: [MESSAGE] }) },
      { socketPath: env.ARCHER_SOCKET },
    );
    return new Promise(() => undefined);
  };
  expect(await runWait(["--timeout", "60"], io, deps), output().err).toBe(0);
  expect(output().out).toContain("> Can you draw the login flow?");
  expect(replacement!.requests.map((r) => r.method)).toEqual(["hello", "waitMessage"]);
  expect(replacement!.requests[1]!.params["timeoutMs"]).toBeLessThanOrEqual(60_000);
});

test("wait and inbox re-register a forgotten id under the same id, re-claim, and retry", async () => {
  const fake = await fakeService();
  claiming(fake);
  let forgotten = true;
  fake.handlers["waitMessage"] = () => {
    if (forgotten) {
      forgotten = false;
      throw new Refusal("agent_unknown", "no such agent");
    }
    return { messages: [MESSAGE] };
  };
  const { io, deps, output } = setup(fake);
  expect(await runWait(["--as", "kept"], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toEqual([
    "hello",
    "waitMessage",
    "registerAgent",
    "listListeners",
    "claimListener",
    "waitMessage",
  ]);
  expect(fake.requests[2]!.params).toMatchObject({ agentId: "kept" });
  let once = true;
  fake.handlers["inbox"] = () => {
    if (once) {
      once = false;
      throw new Refusal("agent_unknown", "no such agent");
    }
    return { count: 0, messages: [] };
  };
  fake.requests.length = 0;
  expect(await runInbox(["--as", "kept"], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toEqual([
    "hello",
    "inbox",
    "registerAgent",
    "listListeners",
    "claimListener",
    "inbox",
  ]);
});

// G1 keeps agents and claims across a restart (decision 16), so `agent_unknown` means a genuinely
// forgotten agent; its revival registers again but never takes a claim another live agent holds.
test("a revival never fights for the claim: another live listener, or the person's pick, ends the wait with why", async () => {
  const fake = await fakeService();
  claiming(fake);
  const other = { ...agent("/x", "agt_9"), label: "Codex · ~/demo" };
  let pinned = false;
  fake.handlers["listListeners"] = (params) => ({
    current: { root: params["root"], state: "listening", listener: other, pinnedByPerson: pinned, agents: [other] },
    otherCheckouts: [],
  });
  fake.handlers["waitMessage"] = () => {
    throw new Refusal("agent_unknown", "no such agent");
  };
  const { io, deps, output, reset } = setup(fake);
  expect(await runWait(["--as", "kept"], io, deps)).toBe(1);
  expect(output().err).toBe(
    "archer wait: another agent (Codex · ~/demo) listens in this checkout now; not taking over. Say so in the thread if the person asks you to listen.\n",
  );
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "waitMessage", "registerAgent", "listListeners"]);
  reset();
  pinned = true;
  fake.handlers["inbox"] = () => {
    throw new Refusal("agent_unknown", "no such agent");
  };
  expect(await runInbox(["--as", "kept"], io, deps)).toBe(1);
  expect(output().err).toMatch(/the person picked another listener \(Codex · ~\/demo\)/);
  // An away listener is not a live one: the revival claims.
  fake.handlers["listListeners"] = (params) => ({
    current: {
      root: params["root"],
      state: "next-turn",
      listener: other,
      pinnedByPerson: false,
      away: true,
      agents: [other],
    },
    otherCheckouts: [],
  });
  let forgotten = true;
  fake.handlers["waitMessage"] = () => {
    if (forgotten) {
      forgotten = false;
      throw new Refusal("agent_unknown", "no such agent");
    }
    return { messages: [MESSAGE] };
  };
  fake.requests.length = 0;
  expect(await runWait(["--as", "kept"], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toContain("claimListener");
});

// Decision 21 (Claude L8): an orphaned wait must not take messages or keep "Listening".
test("wait ends, exit 0 with one line, when the host process it runs under is gone: at the start or mid-wait", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output, reset } = setup(fake);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  reset();
  fake.requests.length = 0;
  expect(await runWait([], io, { ...deps, hostAlive: () => false })).toBe(0);
  expect(output().out).toBe(
    "The agent session this wait ran under (Claude Code, process 4242) has ended: stopped listening.\n",
  );
  expect(fake.requests).toEqual([]);
  reset();
  let gone: (() => void) | undefined;
  let watched: number | undefined;
  let unwatched = false;
  fake.handlers["waitMessage"] = () => {
    gone!();
    return new Promise(() => undefined);
  };
  const code = await runWait([], io, {
    ...deps,
    watchHost: (pid, onGone) => {
      watched = pid;
      gone = onGone;
      return () => {
        unwatched = true;
      };
    },
  });
  expect(code, output().err).toBe(0);
  expect(watched).toBe(4242);
  expect(unwatched).toBe(true);
  expect(output().out).toBe(
    "The agent session this wait ran under (Claude Code, process 4242) has ended: stopped listening.\n",
  );
  // Without a host process (--as from a plain shell) nothing is watched.
  reset();
  fake.handlers["waitMessage"] = () => ({ timedOut: true });
  let asked = false;
  expect(
    await runWait(["--as", "agt_1", "--timeout", "0"], io, {
      ...deps,
      detect: () => ({ host: "other" }),
      hostAlive: () => {
        asked = true;
        return false;
      },
      watchHost: () => {
        asked = true;
        return () => undefined;
      },
    }),
  ).toBe(0);
  expect(asked).toBe(false);
});

// Decision 29: the host can end while the service is still being reached; the wait then takes nothing.
test("a host that ends during a slow connect stops the wait before it asks for a message", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { io, deps, output, reset } = setup(fake);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  fake.handlers["waitMessage"] = () => ({ messages: [MESSAGE] });
  const GONE = "The agent session this wait ran under (Claude Code, process 4242) has ended: stopped listening.\n";
  // The watcher fires while ensure() is pending.
  for (const how of ["watcher", "silent"] as const) {
    reset();
    fake.requests.length = 0;
    let alive = true;
    let onGone: (() => void) | undefined;
    const slow: AgentDeps = {
      ...deps,
      hostAlive: () => alive,
      watchHost: (_, gone) => {
        onGone = gone;
        return () => undefined;
      },
      // The host dies while the connect is slow; with "silent" the 10 s watcher has not looked yet.
      ensure: async (ioArg) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        alive = false;
        if (how === "watcher") onGone!();
        return deps.ensure(ioArg);
      },
    };
    expect(await runWait([], io, slow), output().err).toBe(0);
    expect(output().out, how).toBe(GONE);
    expect(
      fake.requests.map((r) => r.method),
      how,
    ).not.toContain("waitMessage");
  }
});

// Claude 1 / Codex N3: the MCP relay and `archer listen --claim` in one session share one agent id. With
// the registry kept across a restart (decision 16, G1) the relay re-registers that id, the claim is still
// there and the wait carries on; the relay never rewrites the session file the CLI's claim wrote.
test("after a swap the relay re-registers the shared id and the wait carries on; the relay never rewrites the session file", async () => {
  const fake = await fakeService();
  claiming(fake);
  const { root, env, io, deps, output } = setup(fake);
  expect(await runListen(["--claim"], io, deps)).toBe(0);
  const file = join(env.ARCHER_STATE_DIR, "agents", "claude-code-4242.env");
  const written = readFileSync(file, "utf8");
  // The replacement knows agt_1 and its claim: registering it again (any cwd in the checkout) is accepted.
  const { relayIdentity, serviceDial } = await import("../../src/mcp/relay.ts");
  fake.handlers["mcpRelay"] = () => ({ relaying: true });
  const identity = relayIdentity(env, join(root), HOST);
  expect(identity.agentId).toBe("agt_1");
  const relayed = await serviceDial(env, { cwd: root, host: "claude-code", relayVersion: "t" }, { identity })(false);
  relayed.socket.destroy();
  expect(relayed.agentId).toBe("agt_1");
  fake.handlers["waitMessage"] = (params) =>
    params["agentId"] === "agt_1" ? { messages: [MESSAGE] } : { timedOut: true };
  fake.requests.length = 0;
  expect(await runWait([], io, deps), output().err).toBe(0);
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "waitMessage"]);
  expect(readFileSync(file, "utf8")).toBe(written);
  // A service that refuses the id anyway (agent_id_taken): the relay goes on under a new id of its own,
  // and the session file, and so the CLI's claim, stay as they were.
  fake.handlers["registerAgent"] = (params) => {
    if (params["agentId"] !== undefined) throw new Refusal("agent_id_taken", "held");
    return { agentId: "agt_77" };
  };
  const fresh = relayIdentity(env, root, HOST);
  const other = await serviceDial(
    env,
    { cwd: root, host: "claude-code", relayVersion: "t" },
    { identity: fresh },
  )(false);
  other.socket.destroy();
  expect(other.agentId).toBe("agt_77");
  expect(readFileSync(file, "utf8")).toBe(written);
  // With no session file yet, the relay writes one, so `listen --claim` here claims as the relay's id.
  const { rmSync } = await import("node:fs");
  rmSync(file);
  const first = await serviceDial(
    env,
    { cwd: root, host: "claude-code", relayVersion: "t" },
    { identity: relayIdentity(env, root, HOST) },
  )(false);
  first.socket.destroy();
  expect(readFileSync(file, "utf8")).toBe(
    `ARCHER_AGENT_ID=agt_77\nARCHER_AGENT_ROOT=${root}\nARCHER_AGENT_CWD=${root}\n`,
  );
});

test("the default host check counts a process this user may not signal as alive, and a missing one as gone", () => {
  expect(defaultDeps.hostAlive(process.pid)).toBe(true);
  expect(defaultDeps.hostAlive(1)).toBe(true);
  expect(defaultDeps.hostAlive(2 ** 22 + 12345)).toBe(false);
});

// L8: a second restart inside one long wait is survived too; a service that keeps forgetting is given up on.
test("wait revives the listener every time the service forgets it, not once per run", async () => {
  const fake = await fakeService();
  claiming(fake);
  const answers: (() => unknown)[] = [
    () => {
      throw new Refusal("agent_unknown", "no such agent");
    },
    () => ({ reconnect: true }),
    () => {
      throw new Refusal("agent_unknown", "no such agent");
    },
    () => ({ messages: [MESSAGE] }),
  ];
  fake.handlers["waitMessage"] = () => answers.shift()!();
  const { io, deps, output } = setup(fake);
  expect(await runWait(["--as", "kept"], io, deps), output().err).toBe(0);
  expect(fake.requests.filter((r) => r.method === "registerAgent")).toHaveLength(2);
  fake.handlers["waitMessage"] = () => {
    throw new Refusal("agent_unknown", "no such agent");
  };
  fake.requests.length = 0;
  expect(await runWait(["--as", "kept"], io, deps)).toBe(1);
  expect(output().err).toMatch(/archer wait: no such agent/);
  expect(fake.requests.filter((r) => r.method === "registerAgent")).toHaveLength(3);
});

test("wait at its deadline prints one line and exits 0; unrecognised it names the claim", async () => {
  const fake = await fakeService({ waitMessage: () => ({ timedOut: true }) });
  claiming(fake);
  const { io, deps, output, reset } = setup(fake);
  expect(await runWait([], io, { ...deps, detect: () => ({ host: "other" }) })).toBe(1);
  expect(output().err).toMatch(/archer listen --claim/);
  reset();
  expect(await runWait(["--as", "agt_5", "--timeout", "0"], io, deps), output().err).toBe(0);
  expect(output().out).toBe(
    "No message from the person in Archer in 0 s. Run  archer wait  again to keep listening.\n",
  );
  expect(fake.requests.at(-1)).toMatchObject({ method: "waitMessage", params: { agentId: "agt_5", timeoutMs: 0 } });
});

test("inbox: brief counts without marking read; the full list is the listener's fetch", async () => {
  const fake = await fakeService({
    inbox: (params) => ({
      count: 2,
      messages: params["brief"] === true ? [] : [MESSAGE, { ...MESSAGE, threadId: "thr_2", where: undefined }],
    }),
  });
  const { root, io, deps, output, reset } = setup(fake);
  expect(await runInbox(["--brief"], io, { ...deps, detect: () => ({ host: "other" }) })).toBe(0);
  expect(output().out).toBe(`${briefLine(2)}\n`);
  expect(fake.requests.at(-1)!.params).toEqual({ root, brief: true });
  reset();
  // Decision 5: a recognised agent's brief count is what would reach it, so the service is told who asks.
  expect(await runInbox(["--brief", "--as", "agt_3"], io, deps)).toBe(0);
  expect(fake.requests.at(-1)!.params).toEqual({ root, agentId: "agt_3", brief: true });
  reset();
  expect(await runInbox(["--as", "agt_3"], io, deps)).toBe(0);
  expect(fake.requests.at(-1)!.params).toEqual({ root, agentId: "agt_3" });
  expect(output().out).toContain("thread thr_2");
  reset();
  expect(await runInbox([], io, { ...deps, detect: () => ({ host: "other" }) })).toBe(0);
  expect(fake.requests.at(-1)!.params).toEqual({ root });
});

test("inbox with no service says nothing waits and starts nothing", async () => {
  const fake = await fakeService();
  const { io, deps, output, env } = setup(fake);
  await fake.close();
  expect(await runInbox([], io, deps)).toBe(0);
  expect(output().out).toBe("Archer is not running: nothing is waiting.\n");
  expect(existsSync(env.ARCHER_SOCKET)).toBe(false);
});

test("projects lists the attached projects through list_projects", async () => {
  const fake = await fakeService({
    listProjects: () => ({ projects: [{ root: "/r", name: "demo", url: "http://127.0.0.1:9/projects/demo/" }] }),
  });
  const { io, output } = setup(fake);
  expect(await main(["projects", "--json"], io), output().err).toBe(0);
  expect(JSON.parse(output().out)).toMatchObject({ projects: [{ name: "demo", root: "/r" }] });
});

test("the host is the nearest claude or codex process above this one", () => {
  const table: Record<number, ProcessFacts> = {
    100: { ppid: 90, argv: ["/bin/bash", "-c", "archer wait"] },
    90: { ppid: 80, argv: ["node", "/home/u/.local/bin/claude", "--resume"] },
    80: { ppid: 1, argv: ["/usr/bin/zsh"] },
    200: { ppid: 190, argv: ["sh"] },
    190: { ppid: 1, argv: ["/opt/codex/bin/codex", "exec"] },
  };
  const read = (pid: number) => table[pid] ?? null;
  const files = new Set(["/home/u/.local/bin/claude", "/x/codex", "/x/server.js"]);
  const isFile = (path: string) => files.has(path);
  expect(detectHost({}, read, 100, isFile)).toEqual({ host: "claude-code", hostPid: 90 });
  expect(detectHost({}, read, 200, isFile)).toEqual({ host: "codex", hostPid: 190 });
  expect(detectHost({}, read, 80, isFile)).toEqual({ host: "other" });
  expect(detectHost({ CLAUDECODE: "1" }, read, 80, isFile)).toEqual({ host: "claude-code" });
  expect(hostOf(["claude"], isFile)).toBe("claude-code");
  expect(hostOf(["/usr/bin/node", "/x/codex"], isFile)).toBe("codex");
  expect(hostOf(["/usr/bin/node", "/x/server.js", "claude"], isFile)).toBeNull();
  // /proc's comm is the executable: a node script titled claude has comm "claude" (Linux sets both).
  expect(hostOf(["claude"], isFile, "claude")).toBe("claude-code");
  // A runtime titled exactly the bare name (npm Claude Code): counts; a path or another word never does.
  expect(hostOf(["claude"], isFile, "node")).toBe("claude-code");
  expect(hostOf(["/x/claude"], isFile, "node")).toBeNull();
});

// Decision 29: without /proc (macOS) the walk asks ps for each process's parent and program.
test("without /proc the host is found through ps; a failing ps leaves the hosts' variables", () => {
  const table: Record<number, { ppid: number; comm: string; args: string }> = {
    100: { ppid: 90, comm: "/bin/zsh", args: "/bin/zsh -c archer wait" },
    90: { ppid: 80, comm: "node", args: "node /Users/u/.local/bin/claude --resume" },
    80: { ppid: 1, comm: "/usr/bin/login", args: "login -fp u" },
    300: {
      ppid: 1,
      comm: "/Applications/Codex.app/Contents/Resources/codex",
      args: "/Applications/Codex.app/Contents/Resources/codex app-server",
    },
  };
  const calls: string[][] = [];
  const run: RunPs = (args) => {
    calls.push([...args]);
    const pid = Number(args.at(-1));
    const row = table[pid];
    if (row === undefined) return null;
    if (args.includes("args=")) return `${row.args}\n`;
    return `  ${row.ppid} ${row.comm}\n`;
  };
  const ps = psProcess(run, { isFile: (path) => path === "/Users/u/.local/bin/claude" });
  expect(ps(90)).toEqual({ ppid: 80, comm: "node", argv: ["node", "/Users/u/.local/bin/claude", "--resume"] });
  expect(calls[0]).toEqual(["-o", "ppid=", "-o", "comm=", "-p", "90"]);
  const read = readProcess({ proc: () => null, ps, procAvailable: () => false });
  expect(detectHost({}, read, 100)).toEqual({ host: "claude-code", hostPid: 90 });
  expect(detectHost({}, read, 300)).toEqual({ host: "codex", hostPid: 300 });
  // ps missing or refusing: the same as no process found.
  const broken = readProcess({ proc: () => null, ps: psProcess(() => null), procAvailable: () => false });
  expect(detectHost({}, broken, 100)).toEqual({ host: "other" });
  expect(detectHost({ CLAUDECODE: "1" }, broken, 100)).toEqual({ host: "claude-code" });
  expect(psProcess(() => "garbage")(5)).toBeNull();
  // With /proc, ps is never asked.
  let asked = false;
  const linux = readProcess({
    proc: (pid) => (pid === 7 ? { ppid: 1, argv: ["claude"] } : null),
    ps: () => {
      asked = true;
      return null;
    },
    procAvailable: () => true,
  });
  expect(detectHost({}, linux, 7)).toEqual({ host: "claude-code", hostPid: 7 });
  expect(asked).toBe(false);
  // On this Linux machine the default reads /proc and finds this very process.
  expect(readProcess()(process.pid)?.ppid).toBe(process.ppid);
});

// Decision 37: ps output is matched whole, never split on spaces; decision 51: a title counts only as a runtime's bare host name.
test("ps finds the host in a path with spaces, a node script in one, and a node process titled exactly claude", () => {
  const rows: Record<number, { ppid: number; comm: string; args: string }> = {
    // fnm's macOS default: node and the claude script both under "Application Support".
    90: {
      ppid: 1,
      comm: "/Users/u/Library/Application Support/fnm/node-versions/v22/installation/bin/node",
      args: "/Users/u/Library/Application Support/fnm/node-versions/v22/installation/bin/node /Users/u/Library/Application Support/fnm/node-versions/v22/installation/bin/claude --resume",
    },
    91: { ppid: 1, comm: "node", args: "node /Users/First Last/.npm/bin/claude --resume" },
    92: { ppid: 1, comm: "node", args: "claude" },
    97: { ppid: 1, comm: "node", args: "claude --resume" },
    98: { ppid: 1, comm: "python3", args: "claude" },
    99: { ppid: 1, comm: "node", args: "/x/server.js claude" },
    93: { ppid: 1, comm: "codex", args: "codex-renamed" },
    94: { ppid: 1, comm: "/Applications/My Tools/codex", args: "/Applications/My Tools/codex exec --json" },
    95: { ppid: 1, comm: "node", args: "/usr/bin/node /x/server.js claude" },
    96: { ppid: 1, comm: "node", args: "node /x/server.js --out /tmp/claude" },
  };
  const run: RunPs = (args) => {
    const row = rows[Number(args.at(-1))];
    if (row === undefined) return null;
    return args.includes("args=") ? `${row.args}\n` : `  ${row.ppid} ${row.comm}\n`;
  };
  const files = new Set([
    "/Users/u/Library/Application Support/fnm/node-versions/v22/installation/bin/claude",
    "/Users/First Last/.npm/bin/claude",
    "/x/server.js",
  ]);
  const read = readProcess({
    proc: () => null,
    ps: psProcess(run, { isFile: (path) => files.has(path) }),
    procAvailable: () => false,
  });
  expect(detectHost({}, read, 90)).toEqual({ host: "claude-code", hostPid: 90 });
  expect(detectHost({}, read, 91)).toEqual({ host: "claude-code", hostPid: 91 });
  // npm Claude Code on macOS: comm stays node, args are exactly its bare name (decision 51, narrow case).
  expect(detectHost({}, read, 92)).toEqual({ host: "claude-code", hostPid: 92 });
  expect(detectHost({}, read, 97)).toEqual({ host: "claude-code", hostPid: 97 });
  expect(detectHost({}, read, 98)).toEqual({ host: "other" });
  expect(detectHost({}, read, 99)).toEqual({ host: "other" });
  expect(detectHost({}, read, 93)).toEqual({ host: "codex", hostPid: 93 });
  expect(detectHost({}, read, 94)).toEqual({ host: "codex", hostPid: 94 });
  expect(detectHost({}, read, 95)).toEqual({ host: "other" });
  expect(detectHost({}, read, 96)).toEqual({ host: "other" });
});

// Decision 46: the host is the executable (ps's comm), or the script a runtime runs after its options;
// a later argument never counts, and a script path with spaces is the shortest prefix that is a file.
test("the host is the executable or the runtime's script, never a later argument (decision 46, Codex F4)", () => {
  const files = new Set([
    "/x/server.js",
    "/tmp/claude",
    "/tmp/codex",
    "/Users/First Last/bin/claude",
    "/x/hook.js",
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "/opt/lib/node_modules/@openai/codex/bin/codex.js",
  ]);
  const isFile = (path: string) => files.has(path);
  expect(hostOfArgs("node /x/server.js /tmp/claude", "node", isFile)).toBeNull();
  expect(hostOfArgs("node /x/server.js /tmp/codex", "node", isFile)).toBeNull();
  expect(hostOfArgs("node --enable-source-maps /Users/First Last/bin/claude --resume", "node", isFile)).toBe(
    "claude-code",
  );
  expect(hostOfArgs("node --require /x/hook.js /Users/First Last/bin/claude", "node", isFile)).toBe("claude-code");
  expect(
    hostOfArgs(
      "/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume",
      "/usr/local/bin/node",
      isFile,
    ),
  ).toBe("claude-code");
  expect(hostOfArgs("node /opt/lib/node_modules/@openai/codex/bin/codex.js exec", "node", isFile)).toBe("codex");
  expect(hostOfArgs("node -e require('/tmp/claude')", "node", isFile)).toBeNull();
  expect(hostOfArgs("bun /x/server.js claude", "bun", isFile)).toBeNull();
  expect(hostOfArgs("python3 /tmp/claude", "python3", isFile)).toBeNull();
  // /proc's argv, exact, the same way.
  const proc = (path: string) => path === "/u/bin/claude" || files.has(path);
  expect(hostOf(["node", "--enable-source-maps", "/u/bin/claude"], proc)).toBe("claude-code");
  expect(hostOf(["node", "/x/server.js", "/tmp/claude"], proc)).toBeNull();
  expect(hostOf(["node", "-r", "/x/claude", "/x/server.js"], proc)).toBeNull();
});

// Decision 51: the host is the executable (comm), or a runtime's script that exists: options taking a value
// consume it, the script is the longest leading run of words that is a regular file, a title never counts.
test("only an existing script names the host: option values, missing files, longer paths and titles never do (decision 51, Codex F4)", () => {
  const files = new Set(["/x/server.js", "/tmp/claude", "/tmp/claude helper.js", "/u/bin/claude"]);
  const isFile = (path: string) => files.has(path);
  // An option's value is not the script.
  for (const option of [
    "--conditions",
    "-C",
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--input-type",
    "--env-file",
    "--title",
  ]) {
    expect(hostOf(["node", option, "claude", "/x/server.js"], isFile), option).toBeNull();
    expect(hostOf(["node", option, "/tmp/claude", "/x/server.js"], isFile), option).toBeNull();
    expect(hostOfArgs(`node ${option} /tmp/claude /x/server.js`, "node", isFile), option).toBeNull();
  }
  expect(hostOf(["node", "--conditions=claude", "/u/bin/claude"], isFile)).toBe("claude-code");
  expect(hostOf(["node", "--title", "x", "/u/bin/claude"], isFile)).toBe("claude-code");
  // -e and -p run no script.
  for (const option of ["-e", "--eval", "-p", "--print"]) {
    expect(hostOf(["node", option, "1", "/u/bin/claude"], isFile), option).toBeNull();
    expect(hostOfArgs(`node ${option} 1 /u/bin/claude`, "node", isFile), option).toBeNull();
  }
  // Attached eval forms run no script either (decision 54, Codex F3).
  for (const option of ["--eval=1", "--print=1", "-e1", "-p1"]) {
    expect(hostOf(["node", option, "/u/bin/claude"], isFile), option).toBeNull();
    expect(hostOfArgs(`node ${option} /u/bin/claude`, "node", isFile), option).toBeNull();
  }
  // A script that does not exist never matches.
  expect(hostOfArgs("node /nonexistent/claude", "node", isFile)).toBeNull();
  expect(hostOf(["node", "/nonexistent/claude"], isFile)).toBeNull();
  // The longest existing prefix is the script: "/tmp/claude helper.js", not "/tmp/claude".
  expect(hostOfArgs("node /tmp/claude helper.js", "node", isFile)).toBeNull();
  expect(hostOfArgs("node /tmp/claude --resume", "node", isFile)).toBe("claude-code");
  // A retitled process: the args alone never count, whatever the executable.
  expect(hostOfArgs("claude", "/usr/bin/python3", isFile)).toBeNull();
  expect(hostOfArgs("claude /tmp/claude", "/opt/tool", isFile)).toBeNull();
  expect(hostOfArgs("/x/server.js claude", "node", isFile)).toBeNull();
  expect(hostOfArgs("claude-helper", "node", isFile)).toBeNull();
  expect(hostOfArgs("/tmp/claude", "node", isFile)).toBeNull();
  // Only a runtime titled exactly the bare name counts (npm Claude Code on macOS).
  expect(hostOfArgs("claude", "node", isFile)).toBe("claude-code");
  expect(hostOfArgs("claude --resume", "node", isFile)).toBe("claude-code");
  expect(hostOfArgs("codex exec", "bun", isFile)).toBe("codex");
  // The executable itself still decides.
  expect(hostOfArgs("anything at all", "/opt/bin/claude", isFile)).toBe("claude-code");
  expect(hostOfArgs("x", "codex", isFile)).toBe("codex");
});

// Decision 47: one command detects its host once; each detection has its own ps budget.
test("two lookups in one operation both get the caller id, from one ps walk (decision 47, Codex F5)", async () => {
  const fake = await fakeService({ heartbeat: () => ({ state: "next-turn" }) });
  const { io, env, root } = setup(fake);
  // Four ancestors (2 to 5, Claude Code) at 100 ms a ps call: 400 ms of the 1 s budget for a walk.
  let clock = 0,
    calls = 0;
  const run: RunPs = (args) => {
    calls++;
    clock += 100;
    const pid = Number(args.at(-1));
    if (args.includes("args=")) return pid === 5 ? "claude\n" : "sh\n";
    return `  ${pid + 1} ${pid === 5 ? "claude" : "sh"}\n`;
  };
  rememberAgent(env, { host: "claude-code", hostPid: 5 }, { agentId: "agt_5", root, cwd: root });
  const op = { ...io, env };
  const detect = detectOnce((e) =>
    detectHost(
      e,
      readProcess({ proc: () => null, ps: psProcess(run, { clock: () => clock }), procAvailable: () => false }),
      2,
    ),
  );
  const once = {
    find: async () => (await import("../../src/service/service-client.ts")).connectService(fake.socketPath),
    detect: (i: Io) => detect(i.env),
  };
  await reportIn(op, once);
  expect(callerAgentId(op, once)).toBe("agt_5");
  expect(
    fake.requests.filter((request) => request.method === "heartbeat").map((request) => request.params["agentId"]),
  ).toEqual(["agt_5"]);
  // One ps run per ancestor: an executable that is no runtime decides alone (decision 51).
  expect(calls).toBe(4);
  // The command's own detector is memoized too.
  expect(defaultDeps.detect(op)).toBe(defaultDeps.detect(op));
});

test("the ps walk stops within its budget: 16 ancestors at 200 ms a call finish in about a second (decision 37)", () => {
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let calls = 0;
  const run: RunPs = (args, timeoutMs) => {
    calls++;
    sleep(Math.min(200, timeoutMs ?? 200));
    const pid = Number(args.at(-1));
    return args.includes("args=") ? "/bin/zsh -c x\n" : `  ${pid > 100 ? pid - 1 : 1} /bin/zsh\n`;
  };
  const read = readProcess({ proc: () => null, ps: psProcess(run), procAvailable: () => false });
  const started = Date.now();
  expect(detectHost({ CLAUDECODE: "1" }, read, 116)).toEqual({ host: "claude-code" });
  expect(Date.now() - started).toBeLessThan(1_300);
  expect(calls).toBeLessThanOrEqual(6);
  // Fast ps: at most eight ancestors are read.
  let lookups = 0;
  const quick = readProcess({
    proc: () => null,
    ps: psProcess((args) => {
      if (!args.includes("args=")) lookups++;
      return args.includes("args=") ? "sh\n" : `  ${Number(args.at(-1)) - 1} sh\n`;
    }),
    procAvailable: () => false,
  });
  expect(detectHost({}, quick, 116)).toEqual({ host: "other" });
  expect(lookups).toBe(8);
});

test("the fake answers the contract's methods it was not given with not_implemented", async () => {
  const fake = await fakeService();
  const client = await connectService(fake.socketPath);
  try {
    await expect(client.call("inbox", { root: "/r" })).rejects.toMatchObject({ error: { code: "not_implemented" } });
  } finally {
    client.close();
  }
});

// Decision 4 (CLI side): a listener busy answering reports in with every CLI call, so it is not shown as away.
test("any CLI call from a recognised listener reports in; unrecognised, or with no service, nothing is sent or started", async () => {
  const fake = await fakeService({ heartbeat: () => ({ state: "next-turn" }) });
  const { io, deps, env } = setup(fake);
  const { reportIn } = await import("../../src/bin/agents.ts");
  await reportIn({ ...io, env: { ...env, ARCHER_AGENT_ID: "agt_2" } }, deps);
  expect(fake.requests).toEqual([
    { method: "hello", params: expect.anything() },
    { method: "heartbeat", params: { agentId: "agt_2", via: "cli" } },
  ]);
  fake.requests.length = 0;
  await reportIn(io, { ...deps, detect: () => ({ host: "other" }) });
  expect(fake.requests).toEqual([]);
  // Through main: `archer call` reports in as well as doing its work.
  fake.requests.length = 0;
  let out = "";
  const code = await main(["call", "list_diagrams"], {
    ...io,
    env: { ...env, ARCHER_AGENT_ID: "agt_2" },
    stdout: (t) => {
      out += t;
    },
  });
  expect(code, out).toBe(0);
  expect(fake.requests).toContainEqual({ method: "heartbeat", params: { agentId: "agt_2", via: "cli" } });
});
