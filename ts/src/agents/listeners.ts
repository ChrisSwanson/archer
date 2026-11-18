// Agents and listeners per checkout (ADR 0035 §7), kept by the service in memory. Pure: the clock, the
// attached projects and the store are injected. One listener per checkout, and one checkout per
// listener: an agent listens only to the checkout it works in (review decision 15; listening across
// checkouts is deferred, `cross_checkout_deferred`). `archer listen --claim` claims it, with scoping
// checks. A claim not heard from for LISTENER_EXPIRY_MS is away (the next claim takes over) and is
// dropped after LISTENER_FORGET_MS. A person's pin is never taken over by a live agent's claim. A thread
// stays with the agent that last answered it while that agent is live (conversation affinity), unless the
// person pinned a listener: the pin wins (decision 18). Agents, claims, pins and owners are saved
// (decision 16) with each agent's last activity, and load with that clock (decision 28): a restart neither
// revives a dead listener nor leaves a live one's pin open to a claim, and an agent carries on under its id.
import { randomBytes } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import {
  LISTENER_EXPIRY_MS,
  LISTENER_FORGET_MS,
  claimText,
  type AgentHost,
  type AgentInfo,
  type AgentRequestParams,
  type AgentResults,
  type ListenerState,
  type ListenerStatus,
} from "./contract.ts";
import { AGENT_ID, MAX_OWNERS, boundLabel, type ListenerStore, type StoredAgent } from "./pins.ts";

/** A refusal with a stable code, passed on as the management socket's error. */
export class ListenerRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ListenerRefusal";
  }
}

/** What the registry needs to know about an attached checkout. */
export interface CheckoutFacts {
  /** The canonical project root. */
  readonly root: string;
  /** The project's name, as `archer projects` lists it. */
  readonly name: string;
  readonly checkout: "main" | { readonly worktree: string };
  /** The root as the person reads it: `~/code/archer`. */
  readonly displayRoot: string;
  /** The repository's shared git directory (`RepositoryStatus.commonDir`); null outside a repository. */
  readonly commonDir: string | null;
}

export interface RegistryOptions {
  readonly now: () => number;
  readonly store: ListenerStore;
  /** The attached checkout at exactly this canonical root, or null. */
  readonly attached: (root: string) => CheckoutFacts | null;
  /** Called with a checkout's root whenever what `status` or `agentsOf` answer for it changes. */
  readonly onChange?: (root: string) => void;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
}

/** Agents not heard from for this long, and holding no claim, are forgotten. */
export const AGENT_FORGET_MS = 60 * 60_000;
/** A clock this much newer than the saved one is saved on the next sweep, so a restart restores it nearly as it was. */
export const CLOCK_SAVE_MS = LISTENER_EXPIRY_MS / 4;
/** After a failed save, the sweep's clock flush waits this long to try again (decisions 36, 44). */
export const SAVE_RETRY_MS = 5 * 60_000;
const MAX_AGENTS = 512;
const HOSTS: readonly AgentHost[] = ["claude-code", "codex", "other"];
const CONTROL = /[\u0000-\u001f\u007f]/u;

interface AgentRecord {
  readonly agentId: string;
  root: string;
  cwd: string;
  host: AgentHost;
  label: string;
  hostPid: number | undefined;
  lastActive: number;
  /** Open `waitMessage` calls, by checkout root. */
  readonly waits: Map<string, number>;
}

export class ListenerRegistry {
  readonly #options: RegistryOptions;
  readonly #agents = new Map<string, AgentRecord>();
  /** Checkout root -> the agent holding its listener role; an agent holds at most one. */
  readonly #claims = new Map<string, string>();
  /** Checkout root -> the agent the person pinned there. */
  readonly #pins = new Map<string, string>();
  /** Checkout root -> thread id -> the agent that last answered it. */
  readonly #owners = new Map<string, Map<string, string>>();
  /** What each root's status last looked like when announced. */
  readonly #announced = new Map<string, string>();
  /** Agent id -> the last-active time the file holds for it. */
  readonly #savedActive = new Map<string, number>();
  /** Something the file does not hold yet: a clamped clock, or a change whose save failed. */
  #dirty = false;
  /** When the last save failed; null while saves succeed. */
  #failedAt: number | null = null;

  constructor(options: RegistryOptions) {
    this.#options = options;
    const now = options.now();
    const saved = options.store.load();
    // Every saved agent keeps its saved clock (decision 28), a future one clamped to now: one live just
    // before the restart is live (its pin holds), one silent since is away, and a dead listener's claim is
    // dropped LISTENER_FORGET_MS after its real last activity, however often the service restarts.
    for (const agent of saved.agents.slice(0, MAX_AGENTS)) {
      const lastActive = Math.min(Date.parse(agent.lastActive), now);
      // A clamped clock is written on the next flush (decision 36), or every restart would clamp it afresh.
      if (lastActive !== Date.parse(agent.lastActive)) this.#dirty = true;
      this.#agents.set(agent.agentId, {
        agentId: agent.agentId,
        root: agent.root,
        cwd: agent.cwd,
        host: agent.host,
        label: agent.label,
        hostPid: agent.hostPid,
        lastActive,
        waits: new Map(),
      });
      this.#savedActive.set(agent.agentId, lastActive);
    }
    // A claim holds only in the checkout its agent works in (decision 15), one per agent.
    for (const [root, id] of saved.claims) {
      const record = this.#agents.get(id);
      if (
        record === undefined ||
        record.root !== root ||
        !inside(record.cwd, root) ||
        [...this.#claims.values()].includes(id)
      )
        continue;
      this.#claims.set(root, id);
    }
    for (const [root, id] of saved.pins) if (this.#claims.get(root) === id) this.#pins.set(root, id);
    for (const [root, threads] of saved.owners) this.#owners.set(root, new Map(threads));
    for (const root of this.#roots()) this.#announced.set(root, this.#signature(root));
  }

  registerAgent(params: AgentRequestParams["registerAgent"]): AgentResults["registerAgent"] {
    const { root, cwd, host } = params;
    if (!absolute(root) || !absolute(cwd))
      throw new ListenerRefusal("invalid_params", "registerAgent needs `root` and `cwd` as absolute paths");
    if (!HOSTS.includes(host))
      throw new ListenerRefusal("invalid_params", `registerAgent's host is one of ${HOSTS.join(", ")}`);
    if (typeof params.label !== "string" || CONTROL.test(params.label) || params.label.trim() === "")
      throw new ListenerRefusal("invalid_params", "registerAgent needs a label without control characters");
    const label = boundLabel(params.label);
    const now = this.#options.now();
    let agentId = params.agentId;
    if (agentId !== undefined) {
      if (typeof agentId !== "string" || !AGENT_ID.test(agentId))
        throw new ListenerRefusal(
          "invalid_params",
          "--as takes an agent id this service handed out (ag- and 12 hex digits); leave --as off to be given one",
        );
      // The relay and the CLI of one session share its id from different folders of one checkout: only
      // another checkout counts as elsewhere (review N1).
      const held = this.#agents.get(agentId);
      if (held !== undefined && this.#live(held) && held.root !== root)
        throw new ListenerRefusal(
          "agent_id_taken",
          `agent ${agentId} is registered and active in another checkout; register without an id for a new one`,
        );
    }
    this.#forget(now);
    // Supplied ids count toward the bound as fresh ones do (review C9).
    if ((agentId === undefined || !this.#agents.has(agentId)) && this.#agents.size >= MAX_AGENTS)
      throw new ListenerRefusal(
        "too_many_agents",
        `the service keeps at most ${MAX_AGENTS} agents; try again once idle ones are forgotten`,
      );
    if (agentId === undefined)
      do agentId = this.#options.newId?.() ?? `ag-${randomBytes(6).toString("hex")}`;
      while (this.#agents.has(agentId));
    const hostPid = Number.isSafeInteger(params.hostPid) && params.hostPid! > 0 ? params.hostPid : undefined;
    const record = this.#agents.get(agentId);
    let changed = true;
    if (record === undefined)
      this.#agents.set(agentId, { agentId, root, cwd, host, label, hostPid, lastActive: now, waits: new Map() });
    else {
      changed =
        record.root !== root ||
        record.cwd !== cwd ||
        record.host !== host ||
        record.label !== label ||
        record.hostPid !== hostPid;
      Object.assign(record, { root, cwd, host, label, hostPid, lastActive: now });
      // Registering from another checkout: a claim (and pin) whose checkout no longer holds the agent's
      // working directory is dropped, so it cannot take that checkout's messages from elsewhere (L M4).
      for (const [claimed, id] of [...this.#claims])
        if (id === agentId && (claimed !== root || !inside(cwd, claimed))) this.#drop(claimed);
    }
    if (changed) this.#save();
    this.#notify();
    return { agentId };
  }

  claimListener(params: AgentRequestParams["claimListener"]): AgentResults["claimListener"] {
    const record = this.#known(params.agentId);
    record.lastActive = this.#options.now();
    const target = this.#options.attached(params.root);
    if (target === null)
      throw new ListenerRefusal(
        "project_not_attached",
        `no project is attached at ${params.root.slice(0, 300)}; attach it first`,
      );
    if (record.root !== target.root || !inside(record.cwd, target.root))
      throw new ListenerRefusal(
        "cwd_outside_checkout",
        `this agent works in ${record.cwd.slice(0, 300)}, outside ${target.displayRoot}; claim only the checkout you work in`,
      );
    const pinned = this.#pinnedLive(target.root);
    if (pinned !== null && pinned.agentId !== record.agentId) {
      this.#notify();
      return {
        claimed: false,
        claimedRoot: target.root,
        listener: info(record),
        pinnedBy: info(pinned),
        text: `The person chose another listener for ${which(target)}: ${pinned.label}. Say so in the thread instead of taking over.`,
      };
    }
    if (pinned === null) this.#unpin(target.root);
    if (this.#claims.get(target.root) !== record.agentId) {
      this.#assign(target.root, record.agentId);
      this.#save();
    }
    this.#notify();
    return {
      claimed: true,
      claimedRoot: target.root,
      listener: info(record),
      text: claimText(target.name, target.checkout, target.displayRoot),
    };
  }

  /** Any call carrying the agent's id reports in (decision 4); `claimedRoot` is the checkout it listens to, if any. */
  heartbeat(params: AgentRequestParams["heartbeat"]): AgentResults["heartbeat"] {
    const record = this.#known(params.agentId);
    record.lastActive = this.#options.now();
    this.#notify();
    const root = this.claimedRoot(record.agentId);
    return root === undefined ? { state: "none" } : { state: this.status(root).state, claimedRoot: root };
  }

  /**
   * The person's pick in the bubble: the agent becomes the checkout's listener and no live agent's claim
   * takes it over. Only an agent working in this checkout: a sibling worktree's agent is shown for
   * information and refused here (`cross_checkout_deferred`, decision 15). Null clears the pin and keeps
   * whoever listens.
   */
  pinListener(params: AgentRequestParams["pinListener"]): AgentResults["pinListener"] {
    const here = this.#options.attached(params.root);
    if (here === null) throw new ListenerRefusal("project_not_attached", "that project is not attached");
    if (params.agentId === null) {
      this.#unpin(params.root);
    } else {
      const record = this.#known(params.agentId);
      if (record.root !== params.root) {
        const sibling = here.commonDir !== null && this.#options.attached(record.root)?.commonDir === here.commonDir;
        if (sibling)
          throw new ListenerRefusal(
            "cross_checkout_deferred",
            "that agent works in another checkout of this repository; picking it to listen here is not available in this version",
          );
        throw new ListenerRefusal("agent_not_in_checkout", "that agent does not work in this checkout");
      }
      this.#assign(params.root, record.agentId);
      this.#pins.set(params.root, record.agentId);
      this.#save();
    }
    this.#notify();
    return this.status(params.root);
  }

  /** Marks a `waitMessage` connected for this checkout's listener; the returned function ends it. */
  beginWait(root: string, agentId: string): () => void {
    const record = this.#known(agentId);
    record.lastActive = this.#options.now();
    if (!this.isListener(root, agentId))
      throw new ListenerRefusal(
        "not_listener",
        "this agent is not the listener for that checkout; claim it first (archer listen --claim)",
      );
    record.waits.set(root, (record.waits.get(root) ?? 0) + 1);
    this.#notify();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (record.waits.get(root) ?? 1) - 1;
      if (left <= 0) record.waits.delete(root);
      else record.waits.set(root, left);
      record.lastActive = this.#options.now();
      this.#notify();
    };
  }

  /** Whether this agent holds the listener role for the checkout now (away included, until it is dropped). */
  isListener(root: string, agentId: string): boolean {
    const record = this.#agents.get(agentId);
    return (
      record !== undefined &&
      this.#claims.get(root) === agentId &&
      !this.#forgotten(record) &&
      (!this.#pins.has(root) || this.#pins.get(root) === agentId)
    );
  }

  /** The checkout this agent listens to, if any. */
  claimedRoot(agentId: string): string | undefined {
    const record = this.#agents.get(agentId);
    if (record === undefined || this.#forgotten(record)) return undefined;
    return [...this.#claims].find(([, id]) => id === agentId)?.[0];
  }

  /**
   * The agent a new person comment on this thread goes to: the listener the person pinned, if any (the pin
   * beats affinity, decision 18); else its last answerer while live; else the listener; null when nobody listens.
   */
  recipient(root: string, threadId: string): string | null {
    const pinned = this.#pins.get(root);
    if (pinned !== undefined && this.isListener(root, pinned)) return pinned;
    const owner = this.#owners.get(root)?.get(threadId);
    const record = owner === undefined ? undefined : this.#agents.get(owner);
    if (record !== undefined && this.#live(record) && record.root === root) return record.agentId;
    const listener = this.#claims.get(root);
    return listener !== undefined && this.isListener(root, listener) ? listener : null;
  }

  /** Whether an agent other than the checkout's listener holds this thread now (its last answerer, live). */
  heldByOther(root: string, threadId: string): boolean {
    const recipient = this.recipient(root, threadId);
    return recipient !== null && recipient !== this.#claims.get(root);
  }

  /** The agent answered (or opened) this thread: the conversation stays with it while it is live (decision 5). */
  answered(root: string, threadId: string, agentId: string): void {
    const record = this.#known(agentId);
    record.lastActive = this.#options.now();
    let threads = this.#owners.get(root);
    if (threads === undefined) this.#owners.set(root, (threads = new Map()));
    if (threads.get(threadId) === agentId) return;
    threads.delete(threadId);
    threads.set(threadId, agentId);
    let total = [...this.#owners.values()].reduce((sum, map) => sum + map.size, 0);
    // The oldest answers go first past the bound.
    for (const map of this.#owners.values())
      for (const key of [...map.keys()]) {
        if (total <= MAX_OWNERS) break;
        map.delete(key);
        total--;
      }
    this.#save();
    this.#notify();
  }

  /** Who holds the checkout's listener role: `away` once it has not reported in for LISTENER_EXPIRY_MS. */
  status(root: string): ListenerStatus {
    const id = this.#claims.get(root);
    const record = id === undefined ? undefined : this.#agents.get(id);
    if (record === undefined || this.#forgotten(record))
      return { root, state: "none", listener: null, pinnedByPerson: false };
    const pinnedByPerson = this.#pins.get(root) === id;
    const away = !this.#live(record);
    const state: ListenerState = (record.waits.get(root) ?? 0) > 0 ? "listening" : "next-turn";
    return { root, state, listener: info(record), pinnedByPerson, away };
  }

  /** Whether this agent has an `archer wait` open now (it takes a message the moment it arrives). */
  waiting(agentId: string): boolean {
    return (this.#agents.get(agentId)?.waits.size ?? 0) > 0;
  }

  /** Whether this agent is live: waiting, or reported in within LISTENER_EXPIRY_MS. */
  isLive(agentId: string): boolean {
    const record = this.#agents.get(agentId);
    return record !== undefined && this.#live(record);
  }

  /** Whether the checkout's listener is live now: waiting, or reported in within LISTENER_EXPIRY_MS. */
  listenerLive(root: string): boolean {
    const status = this.status(root);
    return status.state !== "none" && status.away !== true;
  }

  /** The active agents registered in this checkout, and its listener, most recent first. */
  agentsOf(root: string): AgentInfo[] {
    const listener = this.#claims.get(root);
    return [...this.#agents.values()]
      .filter(
        (record) =>
          (record.root === root && this.#live(record)) || (record.agentId === listener && !this.#forgotten(record)),
      )
      .sort((a, b) => b.lastActive - a.lastActive || a.agentId.localeCompare(b.agentId))
      .map(info);
  }

  agent(agentId: string): AgentInfo | undefined {
    const record = this.#agents.get(agentId);
    return record === undefined ? undefined : info(record);
  }

  /** Refuses an id this service does not know (`agent_unknown`): every method naming an agent checks it (review C8). */
  known(agentId: string): AgentInfo {
    return info(this.#known(agentId));
  }

  /** Announces away and dropped claims, and forgets long-idle agents; the service calls it every few seconds. */
  sweep(): void {
    this.#forget(this.#options.now());
    this.#flush(true);
    this.#notify();
  }

  /**
   * Saves the agents' clocks when one moved CLOCK_SAVE_MS past the saved one (an open wait counts as now),
   * or what a failed save left unsaved. The shutdown flush: it always tries.
   */
  flush(): void {
    this.#flush(false);
  }

  /** Only the sweep's clock flush backs off after a failed save (decision 44): one try per SAVE_RETRY_MS. */
  #flush(backOff: boolean): void {
    if (backOff && this.#failedAt !== null && this.#options.now() - this.#failedAt < SAVE_RETRY_MS) return;
    const behind = [...this.#agents.values()].some(
      (record) => this.#activeAt(record) - (this.#savedActive.get(record.agentId) ?? -Infinity) >= CLOCK_SAVE_MS,
    );
    if (behind || this.#dirty) this.#save();
  }

  /** When the agent was last heard from; now while a wait of its is open. */
  #activeAt(record: AgentRecord): number {
    return record.waits.size > 0 ? this.#options.now() : record.lastActive;
  }

  #known(agentId: string): AgentRecord {
    const record = this.#agents.get(agentId);
    if (record === undefined)
      throw new ListenerRefusal(
        "agent_unknown",
        "this agent is not registered with the running service (it may have restarted); register again, with the same agentId, and claim",
      );
    return record;
  }

  #live(record: AgentRecord): boolean {
    return record.waits.size > 0 || this.#options.now() - record.lastActive <= LISTENER_EXPIRY_MS;
  }

  /** Silent past LISTENER_FORGET_MS: its claim no longer counts, and the next sweep drops it. */
  #forgotten(record: AgentRecord): boolean {
    return record.waits.size === 0 && this.#options.now() - record.lastActive > LISTENER_FORGET_MS;
  }

  #pinnedLive(root: string): AgentRecord | null {
    const id = this.#pins.get(root);
    const record = id === undefined ? undefined : this.#agents.get(id);
    return record !== undefined && this.#live(record) ? record : null;
  }

  /** The agent listens to `root` and to no other checkout: its other claims, and pins on them, go. */
  #assign(root: string, agentId: string): void {
    for (const [claimed, id] of [...this.#claims]) if (id === agentId && claimed !== root) this.#drop(claimed);
    this.#claims.set(root, agentId);
  }

  #drop(root: string): void {
    this.#claims.delete(root);
    this.#unpin(root);
    this.#save();
  }

  #unpin(root: string): void {
    if (this.#pins.delete(root)) this.#save();
  }

  /**
   * Saves what outlives the service (decision 16), at once: a registration, claim, pin or owner change is
   * never held back by an earlier failure (decision 44). A failure is logged once, not thrown.
   */
  #save(): void {
    const now = this.#options.now();
    const active = new Map([...this.#agents.values()].map((record) => [record.agentId, this.#activeAt(record)]));
    const agents: StoredAgent[] = [...this.#agents.values()].map((record) => ({
      ...info(record),
      lastActive: new Date(active.get(record.agentId)!).toISOString(),
      ...(record.hostPid === undefined ? {} : { hostPid: record.hostPid }),
    }));
    try {
      this.#options.store.save({ agents, claims: this.#claims, pins: this.#pins, owners: this.#owners });
      this.#savedActive.clear();
      for (const [id, at] of active) this.#savedActive.set(id, at);
      this.#dirty = false;
      if (this.#failedAt !== null) this.#options.log?.("[archer] listeners: listeners.json saved again");
      this.#failedAt = null;
    } catch (failure) {
      // Logged once; the sweep retries at most every SAVE_RETRY_MS until a save succeeds.
      if (this.#failedAt === null)
        this.#options.log?.(
          `[archer] listeners: could not save listeners.json (retrying every ${SAVE_RETRY_MS / 60_000} minutes): ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      this.#failedAt = now;
      this.#dirty = true;
    }
  }

  #forget(now: number): void {
    let changed = false;
    for (const [root, id] of [...this.#claims]) {
      const record = this.#agents.get(id);
      if (record === undefined || this.#forgotten(record)) {
        this.#drop(root);
        changed = true;
      }
    }
    const held = new Set(this.#claims.values());
    for (const [id, record] of this.#agents)
      if (!held.has(id) && record.waits.size === 0 && now - record.lastActive > AGENT_FORGET_MS) {
        this.#agents.delete(id);
        changed = true;
      }
    if (changed) this.#save();
  }

  #roots(): Set<string> {
    return new Set([
      ...this.#claims.keys(),
      ...[...this.#agents.values()].map((record) => record.root),
      ...this.#announced.keys(),
    ]);
  }

  #signature(root: string): string {
    const status = this.status(root);
    return JSON.stringify([
      status.state,
      status.away === true,
      status.listener?.agentId ?? null,
      status.listener?.label ?? null,
      status.pinnedByPerson,
      this.agentsOf(root).map((agent) => `${agent.agentId} ${agent.label}`),
    ]);
  }

  #notify(): void {
    for (const root of this.#roots()) {
      const signature = this.#signature(root);
      if (this.#announced.get(root) === signature) continue;
      this.#announced.set(root, signature);
      this.#options.onChange?.(root);
    }
  }
}

function info(record: AgentRecord): AgentInfo {
  return {
    agentId: record.agentId,
    root: record.root,
    cwd: record.cwd,
    host: record.host,
    label: record.label,
    lastActive: new Date(record.lastActive).toISOString(),
  };
}

const absolute = (path: unknown): path is string =>
  typeof path === "string" && isAbsolute(path) && !CONTROL.test(path) && path.length <= 4096;

/** Whether `path` is `root` or below it (`/a/bc` is not inside `/a/b`). */
export function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function which(target: CheckoutFacts): string {
  return `${target.name} (${target.checkout === "main" ? "main checkout" : `worktree ${target.checkout.worktree}`}, ${target.displayRoot})`;
}
