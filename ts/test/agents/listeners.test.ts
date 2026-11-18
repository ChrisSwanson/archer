// The listener registry (ADR 0035 §7): one listener per checkout, claimed with scoping checks,
// expiring after LISTENER_EXPIRY_MS of silence, never taking over a person's pin.
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LISTENER_EXPIRY_MS, LISTENER_FORGET_MS, type AgentInfo } from "../../src/agents/contract.ts";
import { CLOCK_SAVE_MS, ListenerRefusal, ListenerRegistry, type CheckoutFacts } from "../../src/agents/listeners.ts";
import {
  FileListenerStore,
  MAX_LAUNCHED_FOR,
  MAX_LISTENERS_BYTES,
  MemoryListenerStore,
  parse,
  serialize,
  threadKey,
  type ListenerStore,
} from "../../src/agents/pins.ts";

const MAIN: CheckoutFacts = {
  root: "/code/archer",
  name: "archer",
  checkout: "main",
  displayRoot: "~/code/archer",
  commonDir: "/code/archer/.git",
};
const TREE: CheckoutFacts = {
  root: "/code/archer-wt",
  name: "archer",
  checkout: { worktree: "archer-wt" },
  displayRoot: "~/code/archer-wt",
  commonDir: "/code/archer/.git",
};
const OTHER: CheckoutFacts = {
  root: "/code/other",
  name: "other",
  checkout: "main",
  displayRoot: "~/code/other",
  commonDir: "/code/other/.git",
};

function setup(start = 1_000_000, store: ListenerStore = new MemoryListenerStore()) {
  let now = start;
  const changes: string[] = [];
  const projects = [MAIN, TREE, OTHER];
  const registry = new ListenerRegistry({
    now: () => now,
    store,
    attached: (root) => projects.find((p) => p.root === root) ?? null,
    onChange: (root) => changes.push(root),
  });
  return {
    registry,
    changes,
    advance: (ms: number) => {
      now += ms;
    },
    store,
  };
}

const agent = (registry: ListenerRegistry, cwd = "/code/archer/ts", root = "/code/archer") =>
  registry.registerAgent({ root, cwd, host: "claude-code", label: `Claude Code · ${cwd}` }).agentId;

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ListenerRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("claimListener", () => {
  test("claims the checkout the agent works in and returns the exact text", () => {
    const { registry } = setup();
    const id = agent(registry);
    const claim = registry.claimListener({ root: MAIN.root, agentId: id });
    expect(claim).toMatchObject({
      claimed: true,
      listener: { agentId: id, root: MAIN.root, cwd: "/code/archer/ts", host: "claude-code" },
    });
    expect(claim.text).toBe("Listening for archer (main checkout, ~/code/archer)");
    expect(registry.status(MAIN.root)).toMatchObject({
      state: "next-turn",
      listener: { agentId: id },
      pinnedByPerson: false,
    });
  });

  test("a worktree claim names the worktree", () => {
    const { registry } = setup();
    const id = agent(registry, "/code/archer-wt", TREE.root);
    expect(registry.claimListener({ root: TREE.root, agentId: id }).text).toBe(
      "Listening for archer (worktree archer-wt, ~/code/archer-wt)",
    );
  });

  test.each([
    ["the project is not attached", { root: "/code/nowhere", cwd: "/code/nowhere" }, {}, "project_not_attached"],
    ["the agent works outside the checkout", { root: MAIN.root, cwd: "/code/other" }, {}, "cwd_outside_checkout"],
    ["a sibling prefix is not inside", { root: MAIN.root, cwd: "/code/archer-wt/ts" }, {}, "cwd_outside_checkout"],
    [
      "another checkout's root",
      { root: MAIN.root, cwd: "/code/archer" },
      { claimRoot: TREE.root },
      "cwd_outside_checkout",
    ],
  ] as const)("refused when %s", (_, where, extra, code) => {
    const { registry } = setup();
    const id = agent(registry, where.cwd, where.root);
    const { claimRoot } = extra as { claimRoot?: string };
    expect(refusal(() => registry.claimListener({ root: claimRoot ?? where.root, agentId: id }))).toBe(code);
    expect(registry.status(MAIN.root).state).toBe("none");
  });

  test("an unknown agent is refused", () => {
    const { registry } = setup();
    expect(refusal(() => registry.claimListener({ root: MAIN.root, agentId: "ag-000000000000" }))).toBe(
      "agent_unknown",
    );
  });

  test("using Archer claims it: a second agent takes over an unpinned listener", () => {
    const { registry } = setup();
    const first = agent(registry),
      second = agent(registry, "/code/archer/ui");
    registry.claimListener({ root: MAIN.root, agentId: first });
    expect(registry.claimListener({ root: MAIN.root, agentId: second }).claimed).toBe(true);
    expect(registry.status(MAIN.root).listener?.agentId).toBe(second);
  });

  test("a person's pin is not taken over: claimed false, pinnedBy and the text", () => {
    const { registry } = setup();
    const pinned = agent(registry),
      other = agent(registry, "/code/archer/ui");
    registry.pinListener({ root: MAIN.root, agentId: pinned });
    const claim = registry.claimListener({ root: MAIN.root, agentId: other });
    expect(claim).toMatchObject({ claimed: false, pinnedBy: { agentId: pinned }, listener: { agentId: other } });
    expect(claim.text).toMatch(
      /^The person chose another listener for archer \(main checkout, ~\/code\/archer\): Claude Code · \/code\/archer\/ts\./,
    );
    expect(registry.status(MAIN.root)).toMatchObject({ listener: { agentId: pinned }, pinnedByPerson: true });
    // The pinned agent itself may claim again.
    expect(registry.claimListener({ root: MAIN.root, agentId: pinned }).claimed).toBe(true);
  });

  test("a stale pin is always overridden, and the pin goes with it", () => {
    const { registry, advance } = setup();
    const pinned = agent(registry),
      other = agent(registry, "/code/archer/ui");
    registry.pinListener({ root: MAIN.root, agentId: pinned });
    advance(LISTENER_EXPIRY_MS + 1);
    registry.heartbeat({ agentId: other, via: "cli" });
    expect(registry.claimListener({ root: MAIN.root, agentId: other }).claimed).toBe(true);
    expect(registry.status(MAIN.root)).toMatchObject({
      listener: { agentId: other },
      pinnedByPerson: false,
      state: "next-turn",
    });
  });
});

describe("state and expiry", () => {
  test("listening while a wait is connected, next-turn after, none once expired", () => {
    const { registry, advance } = setup();
    const id = agent(registry);
    registry.claimListener({ root: MAIN.root, agentId: id });
    const end = registry.beginWait(MAIN.root, id);
    expect(registry.status(MAIN.root).state).toBe("listening");
    // A connected wait is the heartbeat: it does not expire however long it is held.
    advance(LISTENER_EXPIRY_MS * 3);
    expect(registry.status(MAIN.root).state).toBe("listening");
    end();
    expect(registry.status(MAIN.root).state).toBe("next-turn");
    advance(LISTENER_EXPIRY_MS);
    expect(registry.status(MAIN.root)).toMatchObject({ state: "next-turn", away: false });
    // Away, not gone (decision 4): the claim holds, tagged away, until LISTENER_FORGET_MS.
    advance(1);
    expect(registry.status(MAIN.root)).toMatchObject({ state: "next-turn", away: true, listener: { agentId: id } });
    expect(registry.isListener(MAIN.root, id)).toBe(true);
    advance(LISTENER_FORGET_MS - LISTENER_EXPIRY_MS);
    registry.sweep();
    expect(registry.status(MAIN.root)).toMatchObject({ state: "none", listener: null });
    expect(registry.isListener(MAIN.root, id)).toBe(false);
  });

  test("an away listener is taken over by the next claim, and reporting in brings it back", () => {
    const { registry, advance } = setup();
    const first = agent(registry),
      second = agent(registry, "/code/archer/ui");
    registry.claimListener({ root: MAIN.root, agentId: first });
    advance(LISTENER_EXPIRY_MS + 1);
    expect(registry.heartbeat({ agentId: first, via: "cli" })).toMatchObject({
      state: "next-turn",
      claimedRoot: MAIN.root,
    });
    expect(registry.status(MAIN.root).away).toBe(false);
    advance(LISTENER_EXPIRY_MS + 1);
    registry.heartbeat({ agentId: second, via: "cli" });
    expect(registry.claimListener({ root: MAIN.root, agentId: second }).claimed).toBe(true);
  });

  test("a heartbeat keeps the claim and answers the state", () => {
    const { registry, advance } = setup();
    const id = agent(registry);
    expect(registry.heartbeat({ agentId: id, via: "hook" }).state).toBe("none");
    registry.claimListener({ root: MAIN.root, agentId: id });
    advance(LISTENER_EXPIRY_MS - 1);
    expect(registry.heartbeat({ agentId: id, via: "hook" }).state).toBe("next-turn");
    advance(LISTENER_EXPIRY_MS - 1);
    expect(registry.status(MAIN.root).state).toBe("next-turn");
  });

  test("only the claimed listener may wait", () => {
    const { registry } = setup();
    const listener = agent(registry),
      other = agent(registry, "/code/archer/ui");
    expect(refusal(() => registry.beginWait(MAIN.root, listener))).toBe("not_listener");
    registry.claimListener({ root: MAIN.root, agentId: listener });
    expect(refusal(() => registry.beginWait(MAIN.root, other))).toBe("not_listener");
    expect(refusal(() => registry.beginWait(MAIN.root, "ag-ffffffffffff"))).toBe("agent_unknown");
  });

  test("changes are announced by root, heartbeats that change nothing are not, expiry is announced on sweep", () => {
    const { registry, changes, advance } = setup();
    const id = agent(registry);
    expect(changes).toEqual([MAIN.root]);
    registry.claimListener({ root: MAIN.root, agentId: id });
    expect(changes).toEqual([MAIN.root, MAIN.root]);
    registry.heartbeat({ agentId: id, via: "cli" });
    expect(changes).toHaveLength(2);
    advance(LISTENER_EXPIRY_MS + 1);
    registry.sweep();
    expect(changes).toHaveLength(3);
    registry.sweep();
    expect(changes).toHaveLength(3);
    advance(LISTENER_FORGET_MS);
    registry.sweep();
    expect(changes).toHaveLength(4);
  });
});

describe("registerAgent", () => {
  test("ids are fresh, labels bounded to 80 characters and control characters refused", () => {
    const { registry } = setup();
    const a = agent(registry),
      b = agent(registry);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ag-[0-9a-f]{12}$/);
    const long = registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "codex", label: "x".repeat(200) });
    expect(registry.agent(long.agentId)?.label).toHaveLength(80);
    expect(
      refusal(() => registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "codex", label: "a\u0007b" })),
    ).toBe("invalid_params");
    expect(
      refusal(() => registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "nope" as never, label: "x" })),
    ).toBe("invalid_params");
    expect(refusal(() => registry.registerAgent({ root: MAIN.root, cwd: "relative", host: "codex", label: "x" }))).toBe(
      "invalid_params",
    );
  });

  test("an agent id the service did not hand out is refused in words a caller can act on", () => {
    const { registry } = setup();
    let message = "";
    try {
      registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "codex", label: "x", agentId: "claude-review" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("registerAgent");
    expect(message).toContain("--as");
    expect(message).toMatch(/leave --as off/);
  });

  test("a label the registry accepts always reads back: one length rule, by code points (decision 26)", () => {
    // Emoji (astral, two UTF-16 units), a ZWJ family, CJK, combining marks and ASCII, seeded so a failure repeats.
    const pool = ["😀", "👩‍👩‍👧", "🇫🇷", "漢", "字", "한", "e\u0301", "\u0308", "a", " ", "·", "𝔸"];
    let seed = 26;
    const next = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const store = new MemoryListenerStore();
      const { registry } = setup(1_000_000, store);
      const label = `x${Array.from({ length: 1 + next(160) }, () => pool[next(pool.length)]).join("")}`;
      const id = registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "other", label }).agentId;
      registry.pinListener({ root: MAIN.root, agentId: id });
      const kept = registry.agent(id)!.label;
      expect([...kept].length).toBeLessThanOrEqual(80);
      expect(label.startsWith(kept)).toBe(true);
      // Never half a surrogate pair.
      expect(kept).toBe(Buffer.from(kept, "utf8").toString("utf8"));
      const back = parse(JSON.parse(serialize(store.load())) as unknown);
      expect(back, label).not.toBeNull();
      expect(back!.agents.find((agent) => agent.agentId === id)?.label).toBe(kept);
      expect(back!.pins.get(MAIN.root)).toBe(id);
    }
  });

  test("41 emoji register, save and load back through the file (decision 26)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    const first = setup(1_000_000, new FileListenerStore(dir));
    const id = first.registry.registerAgent({
      root: MAIN.root,
      cwd: MAIN.root,
      host: "other",
      label: "😀".repeat(100),
    }).agentId;
    first.registry.pinListener({ root: MAIN.root, agentId: id });
    const logged: string[] = [];
    const back = new FileListenerStore(dir, (line) => logged.push(line)).load();
    expect(logged).toEqual([]);
    expect(back.agents[0]?.label).toBe("😀".repeat(80));
    expect(back.pins.get(MAIN.root)).toBe(id);
  });

  test("supplied ids count toward the bound (C9)", () => {
    const { registry } = setup();
    for (let i = 0; i < 512; i++)
      registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "codex", label: "x" });
    expect(
      refusal(() =>
        registry.registerAgent({
          agentId: "ag-0123456789ab",
          root: MAIN.root,
          cwd: MAIN.root,
          host: "codex",
          label: "x",
        }),
      ),
    ).toBe("too_many_agents");
  });

  test("registering again from another checkout drops the old claim and pin (L M4)", () => {
    const { registry, advance } = setup();
    const id = agent(registry);
    registry.pinListener({ root: MAIN.root, agentId: id });
    advance(LISTENER_EXPIRY_MS + 1);
    registry.registerAgent({ agentId: id, root: OTHER.root, cwd: OTHER.root, host: "claude-code", label: "x" });
    expect(registry.isListener(MAIN.root, id)).toBe(false);
    expect(registry.status(MAIN.root)).toMatchObject({ state: "none", pinnedByPerson: false });
    expect(refusal(() => registry.beginWait(MAIN.root, id))).toBe("not_listener");
  });

  test("the relay and the CLI of one session share its id from different folders of one checkout (N1)", () => {
    const { registry } = setup();
    const id = agent(registry, "/code/archer/ts");
    registry.claimListener({ root: MAIN.root, agentId: id });
    expect(
      registry.registerAgent({ agentId: id, root: MAIN.root, cwd: "/code/archer", host: "claude-code", label: "relay" })
        .agentId,
    ).toBe(id);
    expect(registry.isListener(MAIN.root, id)).toBe(true);
  });

  test("an agent registers again under its id after a restart, and keeps a live id from being taken", () => {
    const { registry } = setup();
    const again = registry.registerAgent({
      agentId: "ag-0123456789ab",
      root: MAIN.root,
      cwd: MAIN.root,
      host: "codex",
      label: "Codex",
    });
    expect(again.agentId).toBe("ag-0123456789ab");
    // The same agent refreshing itself is fine; another directory taking a live id is not.
    expect(
      registry.registerAgent({
        agentId: "ag-0123456789ab",
        root: MAIN.root,
        cwd: MAIN.root,
        host: "codex",
        label: "Codex",
      }).agentId,
    ).toBe("ag-0123456789ab");
    expect(
      refusal(() =>
        registry.registerAgent({
          agentId: "ag-0123456789ab",
          root: OTHER.root,
          cwd: OTHER.root,
          host: "codex",
          label: "Codex",
        }),
      ),
    ).toBe("agent_id_taken");
    expect(
      refusal(() =>
        registry.registerAgent({
          agentId: "not an id",
          root: MAIN.root,
          cwd: MAIN.root,
          host: "codex",
          label: "Codex",
        }),
      ),
    ).toBe("invalid_params");
  });
});

describe("conversation affinity", () => {
  test("a thread goes to the agent that last answered it while it is live, else to the listener", () => {
    const { registry, advance } = setup();
    const listener = agent(registry),
      answerer = agent(registry, "/code/archer/ui");
    registry.claimListener({ root: MAIN.root, agentId: listener });
    expect(registry.recipient(MAIN.root, "t1")).toBe(listener);
    registry.answered(MAIN.root, "t1", answerer);
    expect(registry.recipient(MAIN.root, "t1")).toBe(answerer);
    expect(registry.recipient(MAIN.root, "t2")).toBe(listener);
    advance(LISTENER_EXPIRY_MS + 1);
    registry.heartbeat({ agentId: listener, via: "cli" });
    expect(registry.recipient(MAIN.root, "t1")).toBe(listener);
  });

  test("nobody claimed: no recipient", () => {
    const { registry } = setup();
    expect(registry.recipient(MAIN.root, "t1")).toBeNull();
  });

  test("the person's pin beats affinity (decision 18)", () => {
    const { registry } = setup();
    const answerer = agent(registry),
      picked = agent(registry, "/code/archer/ui");
    registry.claimListener({ root: MAIN.root, agentId: answerer });
    registry.answered(MAIN.root, "t1", answerer);
    expect(registry.recipient(MAIN.root, "t1")).toBe(answerer);
    registry.pinListener({ root: MAIN.root, agentId: picked });
    expect(registry.recipient(MAIN.root, "t1")).toBe(picked);
    registry.pinListener({ root: MAIN.root, agentId: null });
    expect(registry.recipient(MAIN.root, "t1")).toBe(answerer);
  });

  test("affinity survives a restart through the listeners file", () => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    const first = setup(1_000_000, new FileListenerStore(dir));
    const id = agent(first.registry);
    first.registry.answered(MAIN.root, "t1", id);
    const second = setup(1_000_000 + 10, new FileListenerStore(dir));
    second.registry.registerAgent({
      agentId: id,
      root: MAIN.root,
      cwd: "/code/archer/ts",
      host: "claude-code",
      label: "back",
    });
    expect(second.registry.recipient(MAIN.root, "t1")).toBe(id);
  });
});

describe("pins", () => {
  test("pins, claims and agents persist across a restart and load with their saved clocks (decisions 16, 28)", () => {
    const store = new MemoryListenerStore();
    const first = setup(1_000_000, store);
    const pinned = agent(first.registry),
      loose = agent(first.registry, "/code/archer/ui");
    const tree = agent(first.registry, TREE.root, TREE.root);
    first.registry.pinListener({ root: MAIN.root, agentId: pinned });
    first.registry.claimListener({ root: TREE.root, agentId: tree });
    const second = setup(1_000_000 + LISTENER_EXPIRY_MS + 10, store);
    expect(second.registry.status(MAIN.root)).toMatchObject({
      listener: { agentId: pinned },
      pinnedByPerson: true,
      away: true,
    });
    expect(second.registry.status(TREE.root)).toMatchObject({
      listener: { agentId: tree },
      pinnedByPerson: false,
      away: true,
    });
    expect(second.registry.agent(loose)).toMatchObject({ agentId: loose, cwd: "/code/archer/ui" });
    // An agent known from before the restart is not refused as unknown, and a wait needs no new claim.
    expect(second.registry.beginWait(TREE.root, tree)).toBeTypeOf("function");
    // The pinned agent coming back under its id is the listener again.
    second.registry.registerAgent({
      agentId: pinned,
      root: MAIN.root,
      cwd: "/code/archer/ts",
      host: "claude-code",
      label: "back",
    });
    expect(second.registry.beginWait(MAIN.root, pinned)).toBeTypeOf("function");
  });

  test("a pin whose agent was live within the expiry before a restart still holds against a claim (decision 28)", () => {
    const store = new MemoryListenerStore();
    const first = setup(1_000_000, store);
    const pinned = agent(first.registry),
      other = agent(first.registry, "/code/archer/ui");
    first.registry.pinListener({ root: MAIN.root, agentId: pinned });
    const second = setup(1_000_000 + 60_000, store);
    expect(second.registry.status(MAIN.root)).toMatchObject({
      listener: { agentId: pinned },
      pinnedByPerson: true,
      away: false,
    });
    second.registry.registerAgent({
      agentId: other,
      root: MAIN.root,
      cwd: "/code/archer/ui",
      host: "claude-code",
      label: "other",
    });
    expect(second.registry.claimListener({ root: MAIN.root, agentId: other })).toMatchObject({
      claimed: false,
      pinnedBy: { agentId: pinned },
    });
    expect(second.registry.status(MAIN.root)).toMatchObject({ listener: { agentId: pinned }, pinnedByPerson: true });
  });

  test("an unpinned listener restored live is still taken over by an ordinary claim (using Archer claims it)", () => {
    const store = new MemoryListenerStore();
    const first = setup(1_000_000, store);
    const listener = agent(first.registry),
      other = agent(first.registry, "/code/archer/ui");
    first.registry.claimListener({ root: MAIN.root, agentId: listener });
    const second = setup(1_000_000 + 10, store);
    expect(second.registry.claimListener({ root: MAIN.root, agentId: other }).claimed).toBe(true);
  });

  test("a dead listener's claim expires LISTENER_FORGET_MS after its real last activity, however often the service restarts (decision 28)", () => {
    const store = new MemoryListenerStore();
    const start = 1_000_000;
    const first = setup(start, store);
    const id = agent(first.registry);
    first.registry.claimListener({ root: MAIN.root, agentId: id });
    // Restarts every ten minutes (idle stop, autostart) never refresh a silent agent's clock.
    for (let at = start + 10 * 60_000; at < start + LISTENER_FORGET_MS; at += 10 * 60_000) {
      const again = setup(at, store);
      expect(again.registry.status(MAIN.root)).toMatchObject({ listener: { agentId: id }, away: true });
      expect(again.registry.agent(id)?.lastActive).toBe(new Date(start).toISOString());
    }
    const late = setup(start + LISTENER_FORGET_MS + 1, store);
    expect(late.registry.status(MAIN.root).state).toBe("none");
  });

  test("a listener heard from or waiting keeps a fresh saved clock: sweeps save it, so its pin survives a restart", () => {
    const store = new MemoryListenerStore();
    const first = setup(1_000_000, store);
    const waiting = agent(first.registry),
      beating = agent(first.registry, TREE.root, TREE.root);
    first.registry.pinListener({ root: MAIN.root, agentId: waiting });
    first.registry.claimListener({ root: TREE.root, agentId: beating });
    first.registry.beginWait(MAIN.root, waiting);
    for (let i = 0; i < 120; i++) {
      first.advance(5_000);
      first.registry.heartbeat({ agentId: beating, via: "cli" });
      first.registry.sweep();
    }
    const second = setup(1_000_000 + 600_000 + 60_000, store);
    expect(second.registry.status(MAIN.root)).toMatchObject({
      listener: { agentId: waiting },
      pinnedByPerson: true,
      away: false,
    });
    expect(second.registry.listenerLive(TREE.root)).toBe(true);
  });

  test("flush saves a moved clock at once and leaves an unchanged one alone", () => {
    let saves = 0;
    const memory = new MemoryListenerStore();
    const store: ListenerStore = {
      load: () => memory.load(),
      save: (part) => {
        saves++;
        memory.save(part);
      },
    };
    const { registry, advance } = setup(1_000_000, store);
    const id = agent(registry);
    const before = saves;
    registry.flush();
    expect(saves).toBe(before);
    advance(60_000);
    registry.heartbeat({ agentId: id, via: "cli" });
    registry.flush();
    expect(saves).toBe(before + 1);
    expect(memory.load().agents[0]?.lastActive).toBe(new Date(1_060_000).toISOString());
  });

  test("a saved clock in the future is clamped to the restart time", () => {
    const store = new MemoryListenerStore();
    const ahead = setup(5_000_000, store);
    const id = agent(ahead.registry);
    ahead.registry.claimListener({ root: MAIN.root, agentId: id });
    const restart = 1_000_000;
    const back = setup(restart, store);
    expect(back.registry.agent(id)?.lastActive).toBe(new Date(restart).toISOString());
    expect(back.registry.listenerLive(MAIN.root)).toBe(true);
    back.advance(LISTENER_FORGET_MS + 1);
    back.registry.sweep();
    expect(back.registry.status(MAIN.root).state).toBe("none");
  });

  test("a clamped future clock is saved, so the next restart expires the claim from it (decision 36)", () => {
    const store = new MemoryListenerStore();
    const ahead = setup(5_000_000, store);
    const id = agent(ahead.registry);
    ahead.registry.claimListener({ root: MAIN.root, agentId: id });
    const restart = 1_000_000;
    const back = setup(restart, store);
    back.registry.flush();
    expect(store.load().agents[0]?.lastActive).toBe(new Date(restart).toISOString());
    const again = setup(restart + 10 * 60_000, store);
    expect(again.registry.agent(id)?.lastActive).toBe(new Date(restart).toISOString());
    const late = setup(restart + LISTENER_FORGET_MS + 1, store);
    expect(late.registry.status(MAIN.root).state).toBe("none");
  });

  test("a failing save logs once, retries at most every five minutes, and logs its recovery (decision 36)", () => {
    let failing = true,
      attempts = 0;
    const lines: string[] = [];
    const memory = new MemoryListenerStore();
    const store: ListenerStore = {
      load: () => memory.load(),
      save: (part) => {
        attempts++;
        if (failing) throw new Error("EACCES");
        memory.save(part);
      },
    };
    let now = 1_000_000;
    const registry = new ListenerRegistry({
      now: () => now,
      store,
      attached: (root) => [MAIN].find((p) => p.root === root) ?? null,
      log: (line) => lines.push(line),
    });
    const id = registry.registerAgent({
      root: MAIN.root,
      cwd: MAIN.root,
      host: "claude-code",
      label: "Claude",
    }).agentId;
    registry.claimListener({ root: MAIN.root, agentId: id });
    registry.beginWait(MAIN.root, id);
    const first = attempts;
    for (let i = 0; i < 60; i++) {
      now += 5_000;
      registry.sweep();
    }
    expect(lines.filter((line) => line.includes("could not save"))).toHaveLength(1);
    expect(attempts - first).toBeLessThanOrEqual(1);
    failing = false;
    for (let i = 0; i < 60; i++) {
      now += 5_000;
      registry.sweep();
    }
    expect(lines.filter((line) => line.includes("could not save"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("saved again"))).toHaveLength(1);
    expect(memory.load().agents[0]?.agentId).toBe(id);
  });

  test("only the clock flush backs off: a register and pin after a failed flush are saved at once (decision 44, Codex F2)", () => {
    let failing = true;
    const memory = new MemoryListenerStore();
    const store: ListenerStore = {
      load: () => memory.load(),
      save: (part) => {
        if (failing) throw new Error("EACCES");
        memory.save(part);
      },
    };
    let now = 1_000_000;
    const make = () =>
      new ListenerRegistry({ now: () => now, store, attached: (root) => [MAIN].find((p) => p.root === root) ?? null });
    failing = false;
    const registry = make();
    const first = registry.registerAgent({
      root: MAIN.root,
      cwd: MAIN.root,
      host: "claude-code",
      label: "Claude",
    }).agentId;
    registry.claimListener({ root: MAIN.root, agentId: first });
    registry.beginWait(MAIN.root, first);
    failing = true;
    now += CLOCK_SAVE_MS;
    registry.sweep();
    failing = false;
    now += 1_000;
    const second = registry.registerAgent({ root: MAIN.root, cwd: MAIN.root, host: "codex", label: "Codex" }).agentId;
    registry.pinListener({ root: MAIN.root, agentId: second });
    const back = make();
    expect(back.agent(second)?.host).toBe("codex");
    expect(back.status(MAIN.root)).toMatchObject({ pinnedByPerson: true, listener: { agentId: second } });
    // The shutdown flush tries too, whatever the back-off.
    failing = true;
    now += CLOCK_SAVE_MS;
    registry.sweep();
    failing = false;
    now += 1_000;
    registry.heartbeat({ agentId: second, via: "cli" });
    registry.flush();
    expect(memory.load().agents.find((agent) => agent.agentId === second)?.lastActive).toBe(
      new Date(now).toISOString(),
    );
  });

  test("pinning null clears the pin and keeps the listener", () => {
    const { registry } = setup();
    const id = agent(registry);
    registry.pinListener({ root: MAIN.root, agentId: id });
    expect(registry.pinListener({ root: MAIN.root, agentId: null })).toMatchObject({
      pinnedByPerson: false,
      listener: { agentId: id },
    });
  });

  test("a sibling worktree's agent cannot be picked (deferred, decision 15): it keeps listening in its own", () => {
    const { registry } = setup();
    const id = agent(registry, TREE.root, TREE.root);
    registry.claimListener({ root: TREE.root, agentId: id });
    expect(refusal(() => registry.pinListener({ root: MAIN.root, agentId: id }))).toBe("cross_checkout_deferred");
    expect(registry.status(TREE.root).listener?.agentId).toBe(id);
    expect(registry.status(MAIN.root).state).toBe("none");
  });

  test("only an agent of that checkout can be pinned", () => {
    const { registry } = setup();
    const elsewhere = agent(registry, "/code/other", OTHER.root);
    expect(refusal(() => registry.pinListener({ root: MAIN.root, agentId: elsewhere }))).toBe("agent_not_in_checkout");
    expect(refusal(() => registry.pinListener({ root: MAIN.root, agentId: "ag-ffffffffffff" }))).toBe("agent_unknown");
    expect(refusal(() => registry.pinListener({ root: "/code/nowhere", agentId: null }))).toBe("project_not_attached");
  });

  test("the listeners file is private JSON written atomically; a bad one is set aside and logged, not erased", () => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    const logged: string[] = [];
    const store = new FileListenerStore(dir, (line) => logged.push(line));
    expect(store.load().pins.size).toBe(0);
    const info: AgentInfo = {
      agentId: "ag-0123456789ab",
      root: MAIN.root,
      cwd: MAIN.root,
      host: "codex",
      label: "Codex",
      lastActive: new Date(0).toISOString(),
    };
    store.save({
      agents: [{ ...info, hostPid: 42 }],
      pins: new Map([[MAIN.root, info.agentId]]),
      claims: new Map([[MAIN.root, info.agentId]]),
    });
    const path = join(dir, "listeners.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      pins: { [MAIN.root]: { ...info, hostPid: 42 } },
      claims: { [MAIN.root]: info.agentId },
    });
    expect(new FileListenerStore(dir).load()).toMatchObject({
      agents: [{ ...info, hostPid: 42 }],
      pins: new Map([[MAIN.root, info.agentId]]),
    });
    for (const bad of [
      "{not json",
      JSON.stringify({ version: 1, pins: { [MAIN.root]: { ...info, agentId: "../x" } } }),
    ]) {
      writeFileSync(path, bad);
      expect(new FileListenerStore(dir, (line) => logged.push(line)).load().pins.size).toBe(0);
      const aside = readdirSync(dir).filter((name) => name.endsWith(".set-aside"));
      expect(aside.length).toBeGreaterThan(0);
      expect(readdirSync(dir)).not.toContain("listeners.json");
    }
    expect(logged.filter((line) => line.includes("set aside"))).toHaveLength(2);
  });

  test("writer and reader share one bound: 4096 long-id owners and pins round-trip (Codex N6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    const store = new FileListenerStore(dir);
    const info: AgentInfo = {
      agentId: "ag-0123456789ab",
      root: MAIN.root,
      cwd: MAIN.root,
      host: "codex",
      label: "Codex",
      lastActive: new Date(0).toISOString(),
    };
    const threads = new Map(
      Array.from({ length: 4096 }, (_, i) => [`${String(i).padStart(4, "0")}${"t".repeat(60)}`, info.agentId] as const),
    );
    store.save({
      agents: [info],
      pins: new Map([[MAIN.root, info.agentId]]),
      claims: new Map([[MAIN.root, info.agentId]]),
      owners: new Map([[MAIN.root, threads]]),
    });
    const back = new FileListenerStore(dir).load();
    expect(back.pins.get(MAIN.root)).toBe(info.agentId);
    expect(back.owners.get(MAIN.root)?.size).toBe(4096);
  });

  test("past the byte bound the writer drops the oldest records, then the oldest owners; pins stay (decision 55)", () => {
    const info: AgentInfo = {
      agentId: "ag-0123456789ab",
      root: MAIN.root,
      cwd: MAIN.root,
      host: "codex",
      label: "Codex",
      lastActive: new Date(0).toISOString(),
    };
    const record = (i: number) =>
      new Map(
        Array.from({ length: 10 }, (_, c) => [`c${i}-${c}`.padEnd(64, "y"), { hash: "0123456789ab", seq: i }] as const),
      );
    const records = new Map(
      Array.from(
        { length: 5_000 },
        (_, i) => [threadKey(`${MAIN.root}/${i % 7}`, `t${i}`.padEnd(64, "x")), record(i)] as const,
      ),
    );
    const text = serialize({
      agents: [info],
      pins: new Map([[MAIN.root, info.agentId]]),
      claims: new Map([[MAIN.root, info.agentId]]),
      owners: new Map(),
      records,
      deliverySeq: 5_000,
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_LISTENERS_BYTES);
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    writeFileSync(join(dir, "listeners.json"), text, { mode: 0o600 });
    const back = new FileListenerStore(dir).load();
    expect(back.pins.get(MAIN.root)).toBe(info.agentId);
    expect(back.records.size).toBeGreaterThan(0);
    expect(back.records.size).toBeLessThan(5_000);
    // The most recently written are the ones kept, whole.
    expect(back.records.get(threadKey(`${MAIN.root}/${4_999 % 7}`, "t4999".padEnd(64, "x")))).toEqual(record(4_999));
  });

  test("records round-trip; at most 5,000 threads load; bad entries skipped (decision 55, Codex F4)", () => {
    const info: AgentInfo = {
      agentId: "ag-0123456789ab",
      root: MAIN.root,
      cwd: MAIN.root,
      host: "codex",
      label: "Codex",
      lastActive: new Date(0).toISOString(),
    };
    const records = new Map(
      Array.from(
        { length: 5_000 },
        (_, i) =>
          [
            threadKey(MAIN.root, `t-${String(i).padStart(12, "0")}`),
            new Map([[`c-${i}`, { hash: "0123456789ab", seq: i + 1 }]]),
          ] as const,
      ),
    );
    const back = parse(
      JSON.parse(
        serialize({
          agents: [info],
          pins: new Map(),
          claims: new Map(),
          owners: new Map(),
          records,
          deliverySeq: 7_000,
        }),
      ),
    );
    expect(back?.records).toEqual(records);
    expect(back?.deliverySeq).toBe(7_000);
    // A file with 5,001 threads (written by hand, or by an older bound) loads the newest 5,000.
    const over = {
      roots: [MAIN.root],
      threads: Array.from({ length: 5_001 }, (_, i) => [0, `t${i}`, { c: ["0123456789ab", 1] }]),
    };
    const loaded = parse({ version: 1, pins: {}, agents: [], claims: {}, records: over })!.records;
    expect(loaded.size).toBe(5_000);
    expect(loaded.has(threadKey(MAIN.root, "t0"))).toBe(false);
    expect(loaded.has(threadKey(MAIN.root, "t5000"))).toBe(true);
    const bad = parse({
      version: 1,
      pins: {},
      agents: [],
      claims: {},
      records: {
        roots: [MAIN.root, "relative"],
        threads: [
          [0, "t1", { a: ["0123456789ab", 3], "../b": ["0123456789ab", 3], c: ["short", 3], d: "0123456789ab" }],
          [1, "t2", { a: ["0123456789ab", 3] }],
          [0, "../x", {}],
          [5, "t4", {}],
          [0, "t5", "junk"],
          [0, "t6"],
          "junk",
        ],
      },
    });
    // Only a [hash, seq] pair is a record entry: a bare hash is skipped.
    expect(bad?.records).toEqual(
      new Map([[threadKey(MAIN.root, "t1"), new Map([["a", { hash: "0123456789ab", seq: 3 }]])]]),
    );
    const sequenced = parse({
      version: 1,
      pins: {},
      agents: [],
      claims: {},
      records: {
        roots: [MAIN.root],
        threads: [[0, "t1", { a: ["0123456789ab", 9], b: ["0123456789ab", -1], c: ["0123456789ab"] }]],
        seq: 4,
      },
    });
    expect(sequenced?.records.get(threadKey(MAIN.root, "t1"))).toEqual(
      new Map([["a", { hash: "0123456789ab", seq: 9 }]]),
    );
    // The high-water mark is never below a sequence a record holds.
    expect(sequenced?.deliverySeq).toBe(9);
    // A sequence that is not a safe count below 2^48 is not taken: the highest stored one stands (decision 59).
    for (const seq of [Number.MAX_SAFE_INTEGER, 2 ** 48, -1, 1.5, "7"]) {
      const loaded = parse({
        version: 1,
        pins: {},
        agents: [],
        claims: {},
        records: {
          roots: [MAIN.root],
          threads: [[0, "t1", { a: ["0123456789ab", 9], z: ["0123456789ab", 2 ** 48] }]],
          seq,
        },
      });
      expect(loaded?.deliverySeq, String(seq)).toBe(9);
      expect(loaded?.records.get(threadKey(MAIN.root, "t1"))?.has("z"), String(seq)).toBe(false);
    }
  });

  test("launch markers round-trip, bounded, and bad entries are skipped (X-17)", () => {
    const launchedFor = Array.from(
      { length: MAX_LAUNCHED_FOR + 5 },
      (_, i) => `${threadKey(`${MAIN.root}/${i % 3}`, `t${i}`)}\0c${i}`,
    );
    const launched = new Map([
      [MAIN.root, 1_000],
      [`${MAIN.root}/1`, 2_000],
    ]);
    const back = parse(
      JSON.parse(
        serialize({
          agents: [],
          pins: new Map(),
          claims: new Map(),
          owners: new Map(),
          records: new Map(),
          deliverySeq: 0,
          launches: { launchedFor, launched },
        }),
      ),
    );
    expect(back?.launches?.launchedFor).toEqual(launchedFor.slice(-MAX_LAUNCHED_FOR));
    expect(back?.launches?.launched).toEqual(launched);
    const bad = parse({
      version: 1,
      pins: {},
      agents: [],
      claims: {},
      launches: {
        roots: [MAIN.root, "relative"],
        launched: [[0, 5], [1, 6], [0, -1], [0, 1.5], [9, 1], "x"],
        launchedFor: [[0, "t1", "c1"], [1, "t2", "c2"], [0, "../t", "c"], [0, "t3"], "junk"],
      },
    });
    expect(bad?.launches).toEqual({
      launchedFor: [`${threadKey(MAIN.root, "t1")}\0c1`],
      launched: new Map([[MAIN.root, 5]]),
    });
    expect(parse({ version: 1, pins: {}, agents: [], claims: {} })?.launches).toEqual({
      launchedFor: [],
      launched: new Map(),
    });
  });

  test("records keep their order across a save, whatever their roots (decision 50, Codex F6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    const record = new Map([["c", { hash: "0123456789ab", seq: 1 }]]);
    const records = new Map([
      [threadKey("/r1", "old"), record],
      [threadKey("/r2", "middle"), record],
      [threadKey("/r1", "new"), record],
    ]);
    new FileListenerStore(dir).save({ records, deliverySeq: 1 });
    expect([...new FileListenerStore(dir).load().records.keys()]).toEqual([
      threadKey("/r1", "old"),
      threadKey("/r2", "middle"),
      threadKey("/r1", "new"),
    ]);
  });

  test("a file over the bound is set aside, not read and not erased", () => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pins-"));
    writeFileSync(join(dir, "listeners.json"), " ".repeat(MAX_LISTENERS_BYTES + 1), { mode: 0o600 });
    const logged: string[] = [];
    expect(new FileListenerStore(dir, (line) => logged.push(line)).load().pins.size).toBe(0);
    expect(readdirSync(dir).some((name) => name.endsWith(".set-aside"))).toBe(true);
    expect(logged.join("\n")).toMatch(/over 1048576 bytes/);
  });
});
