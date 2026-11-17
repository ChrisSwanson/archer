// Message delivery in the service (ADR 0035 §7–8): the listener registry wired to attached projects,
// `waitMessage` held on the project's comment events, the inbox, the listing the page's bubble shows,
// and the person's Launch. Delivery is acknowledged (review decision 3): an answer carries every person
// comment of a thread its agent has not received, oldest first, and they count as received only once that
// answer was written to a live connection. What a thread's agent received is its record (decision 55): each
// person comment handed over, with the hash of the whole comment as it was then. A sent person comment
// whose current hash is not the recorded one (an edit, a context changed outside Archer) or that has none
// goes (again), oldest first; agent comments, drafts and status changes never count, so a re-send is
// possible but a lost comment is not. A thread shows as read once none of its person comments is left. A
// thread in an answer not yet written is handed to nobody else until that answer settles, or for at most
// WRITE_DEADLINE_MS (decision 49), after which it counts as not written. The records are saved with the
// registry in listeners.json (decision 16), so a restart does not deliver a comment again. A thread goes
// to the listener the person pinned; else to the agent that last answered it while that agent is live;
// else to the checkout's listener (decisions 5, 18). A held wait never counts
// toward the hot-swap drain (ADR 0032): a hand-over answers every open wait `{reconnect: true}` at once,
// a stop refuses them.
//
// The delivery order (ADR 0035, amended 2026-10-31): a message the person sends from the page `arrived` with
// their sign-in. With `launch = "auto"` and a sender launch_for admits, it is offered to the steps in order: an
// agent with a wait open takes it at once; else a session between turns (the thread's live recipient, or with
// none any live agent registered here) gets next_turn_wait, extended until the checkout's listener is away;
// else the launcher runs, with every safeguard of the person's Launch (#start). A message is launched for at
// most once. Waits are in memory: a restart or hand-over ends them, and the message stays in the inbox.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import {
  LISTENER_EXPIRY_MS,
  MAX_WAIT_MS,
  type PendingDelivery,
  type AgentRequestParams,
  type AgentResults,
  type AgentInfo,
  type InboxMessage,
  type ListenerListing,
  type ListenerStatus,
} from "../agents/contract.ts";
import { homeRelative, pageText } from "./project-facts.ts";
import { ListenerRefusal, ListenerRegistry, type CheckoutFacts } from "../agents/listeners.ts";
import {
  FileListenerStore,
  MemoryListenerStore,
  threadKey,
  MAX_LAUNCHED_FOR,
  MAX_RECORDS,
  type Delivered,
  type DeliveryRecord,
  type ListenerStore,
} from "../agents/pins.ts";
import { inventory } from "../application/diagrams.ts";
import { wherePhrase } from "../comments/agent.ts";
import type { Comment, Thread } from "../comments/contract.ts";
import { diskReferenceSources, ReferenceReads, referencesFor, type ThreadReferences } from "../comments/references.ts";
import { findProject } from "../project/index.ts";
import type { ProjectState } from "./project-state.ts";
import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicy } from "../config/agents.ts";
import { assertWriteAllowed } from "../config/write-policy.ts";

/** How often expiries are looked for and announced, and open waits look again (an owner gone away). */
export const LISTENER_SWEEP_MS = 5_000;
/** One Launch per project in this window: a double press, or presses on two threads, start one agent. */
export const LAUNCH_REPEAT_MS = 30_000;
/** The most threads with a delivery record, in memory and on disk (decision 55; pins.ts). */
export { MAX_RECORDS };
/** After a launch, how long the bubble says an agent is starting unless one takes the message first (the page's LAUNCH_WAIT_MS). */
export const LAUNCHING_SHOWN_MS = 60_000;
/** The most messages remembered as launched for (once per message), kept in listeners.json; the oldest go first. */
export { MAX_LAUNCHED_FOR };

/** The timers the delivery order runs on; a test runs them on its own clock. */
export interface DeliveryTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const REAL_TIMERS: DeliveryTimers = {
  set: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Who sent a message from the page: `owner` is the Launch button's test (the owner's own sign-in from this computer). */
export interface Sender {
  readonly owner: boolean;
}

/** How long an answer's threads stay reserved for its write; unsettled by then, it counts as not written (decision 49). */
export const WRITE_DEADLINE_MS = 30_000;

/**
 * Called once the answer carrying some messages was written (`true`) or could not be (`false`): only a
 * written answer records them as delivered. The socket passes it per request (socket.ts `afterWrite`).
 */
export type AfterWrite = (callback: (written: boolean) => void) => void;
const writtenAtOnce: AfterWrite = (callback) => callback(true);

export interface DeliveryOptions {
  /** Where the person's pins are kept; in memory when absent. */
  readonly stateDir?: string;
  readonly now?: () => number;
  /** The attached projects, as the service holds them. */
  readonly projects: () => readonly ProjectState[];
  /** The home directory roots are shown under as `~`. */
  readonly home?: string;
  readonly log?: (line: string) => void;
  /** WRITE_DEADLINE_MS unless a test shortens it. */
  readonly writeDeadlineMs?: number;
  /** Runs the person's launcher for a message (launcher.ts); without it Launch is refused. */
  /** Whether the person set a launcher now (read per listing, so setting one needs no restart); default: `launch` given. */
  readonly launcherSet?: (state: ProjectState) => boolean;
  /** The project's delivery policy, read fresh at each decision (config/agents.ts); a throw starts nothing. Default: DEFAULT_DELIVERY_POLICY. */
  readonly policy?: (state: ProjectState) => DeliveryPolicy;
  readonly timers?: DeliveryTimers;
  readonly launch?: (
    project: ProjectState,
    message: { readonly threadId: string; readonly target: string; readonly text: string },
  ) => Promise<{ readonly pid?: number }>;
}

type WaitResult = AgentResults["waitMessage"];
/** A thread's message on its way through the order (in memory only: a restart ends it). */
interface Step {
  readonly root: string;
  readonly threadId: string;
  readonly shown: PendingDelivery;
  readonly timer: unknown;
}

interface OpenWait {
  readonly root: string;
  readonly agentId: string;
  finish(result: WaitResult | Error): void;
  /** Looks again for messages (a comment event, or a sweep: the thread's owner may have gone away). */
  check(): void;
}

/** One thread's comments to hand over, and their hashes as handed over, recorded once written. */
interface Parcel {
  readonly thread: Thread;
  readonly comments: readonly Comment[];
  readonly hashes: ReadonlyMap<string, string>;
}

export class Delivery {
  readonly registry: ListenerRegistry;
  readonly #options: DeliveryOptions;
  readonly #now: () => number;
  readonly #home: string;
  readonly #writeDeadlineMs: number;
  readonly #waits = new Set<OpenWait>();
  /** Project root -> when Launch last started an agent there. */
  readonly #launched = new Map<string, number>();
  /** Thread (threadKey) -> its record (comment id -> hash as delivered), the least recently written first. */
  readonly #records = new Map<string, DeliveryRecord>();
  /** The last hand-over sequence number given out (decision 57): an answer or a pull takes the next. */
  #seq = 0;
  /** Threads in an answer not yet written: handed to nobody else until it is (or fails). */
  readonly #reserved = new Set<string>();
  readonly #store: ListenerStore;
  readonly #timers: DeliveryTimers;
  /** Thread (threadKey) -> the step its message is on. */
  readonly #steps = new Map<string, Step>();
  /** `threadKey\0commentId` of every comment a launch carried, oldest first: none starts another automatic launch. */
  readonly #launchedFor = new Set<string>();
  /**
   * `threadKey\0commentId` of comments waiting when a qualifying sender's message arrived: only these may start one.
   * Each keeps whether that sender was the owner (X-16), never a credential, so a launch_for narrowed to "owner"
   * meanwhile is judged again before anything starts.
   */
  readonly #qualified = new Map<string, Qualified>();
  #sweep: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: DeliveryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#home = options.home ?? homedir();
    this.#writeDeadlineMs = options.writeDeadlineMs ?? WRITE_DEADLINE_MS;
    this.#timers = options.timers ?? REAL_TIMERS;
    const log = options.log ?? (() => {});
    this.#store =
      options.stateDir === undefined ? new MemoryListenerStore() : new FileListenerStore(options.stateDir, log);
    this.registry = new ListenerRegistry({
      now: this.#now,
      store: this.#store,
      log,
      attached: (root) => {
        const state = this.#state(root);
        return state === undefined ? null : this.#facts(state);
      },
      onChange: (root) => this.#changed(root),
    });
    // The reader keeps at most MAX_RECORDS threads (pins.ts), so the bound holds from the start.
    const loaded = this.#store.load();
    for (const [key, record] of loaded.records) this.#records.set(key, record);
    this.#seq = loaded.deliverySeq;
    // The launch safeguards outlive the service (X-17): once per message, and a window that started before the
    // restart (a time in the future, from a clock set back, is not taken). Waits and qualifications never do.
    for (const id of loaded.launches?.launchedFor ?? []) this.#launchedFor.add(id);
    const started = this.#now();
    for (const [root, at] of loaded.launches?.launched ?? [])
      if (at <= started && started - at <= LAUNCH_REPEAT_MS) this.#launched.set(root, at);
    this.#sweep = setInterval(() => {
      this.registry.sweep();
      for (const wait of [...this.#waits]) wait.check();
      this.#prune();
    }, LISTENER_SWEEP_MS);
    this.#sweep.unref();
  }

  // ------------------------------------------------------------ socket methods

  registerAgent(params: AgentRequestParams["registerAgent"]): AgentResults["registerAgent"] {
    const result = this.registry.registerAgent({ ...params, root: canonicalRoot(params.root), cwd: real(params.cwd) });
    this.#endStrayWaits("this agent registered in another checkout; this wait has ended");
    return result;
  }

  claimListener(params: AgentRequestParams["claimListener"]): AgentResults["claimListener"] {
    const result = this.registry.claimListener({ ...params, root: canonicalRoot(params.root) });
    // A wait still open for the role's former holder ends: it no longer listens there.
    if (result.claimed) this.#endStrayWaits("another agent claimed this checkout's listener role; this wait has ended");
    return result;
  }

  heartbeat(params: AgentRequestParams["heartbeat"]): AgentResults["heartbeat"] {
    return this.registry.heartbeat(params);
  }

  pinListener(params: AgentRequestParams["pinListener"]): AgentResults["pinListener"] {
    const status = this.registry.pinListener({ ...params, root: canonicalRoot(params.root) });
    this.#endStrayWaits("the person picked another listener for this checkout; this wait has ended");
    return status;
  }

  listListeners(params: AgentRequestParams["listListeners"]): AgentResults["listListeners"] {
    return this.#rawListing(this.#attached(params.root));
  }

  /**
   * What waits. With an agent's id: the messages addressed to it (as the checkout's listener, or as the
   * thread's last answerer), taken once the answer is written, and messages nobody is listening for,
   * listed and left; an unknown id is refused. Without one: everything waiting, left as it is. `brief`
   * counts the same messages and takes nothing (the turn-start hook).
   */
  inbox(params: AgentRequestParams["inbox"], afterWrite: AfterWrite = writtenAtOnce): AgentResults["inbox"] {
    const agentId = params.agentId;
    if (agentId !== undefined) this.registry.heartbeat({ agentId, via: "cli" });
    const state = this.#attached(params.root);
    const parcels = this.#parcels(
      state,
      agentId === undefined ? { kind: "all" } : { kind: "for", agentId, others: true },
    );
    if (params.brief === true)
      return { count: parcels.reduce((sum, parcel) => sum + parcel.comments.length, 0), messages: [] };
    const taken =
      agentId === undefined
        ? []
        : parcels.filter((parcel) => this.registry.recipient(state.root, parcel.thread.id) === agentId);
    const messages = this.#messages(state, parcels);
    this.#hand(state, taken, afterWrite);
    return { count: messages.length, messages };
  }

  /**
   * Answers at once when messages wait for this listener (oldest first), else on the first comment event
   * that leaves one waiting, else `{timedOut}` at `timeoutMs` (at most MAX_WAIT_MS). `signal`: the caller's
   * connection closed; nothing is handed to it. What it is handed counts as delivered once written.
   */
  async waitMessage(
    params: AgentRequestParams["waitMessage"],
    signal?: AbortSignal,
    afterWrite: AfterWrite = writtenAtOnce,
  ): Promise<WaitResult> {
    if (this.#closed) throw new ListenerRefusal("service_stopping", "the service is stopping");
    this.registry.known(params.agentId);
    const state = this.#attached(params.root);
    const end = this.registry.beginWait(state.root, params.agentId);
    let unsubscribe = (): void => {};
    let timer: NodeJS.Timeout | undefined;
    let wait: OpenWait | undefined;
    const ready = (): WaitResult | null => {
      if (signal?.aborted === true) return null;
      const parcels = this.#parcels(state, { kind: "for", agentId: params.agentId, others: false });
      if (parcels.length === 0) return null;
      const messages = this.#messages(state, parcels);
      this.#hand(state, parcels, afterWrite);
      return { messages };
    };
    try {
      const now = ready();
      if (now !== null) return now;
      return await new Promise<WaitResult>((done, fail) => {
        let settled = false;
        let checking = false;
        const finish = (result: WaitResult | Error): void => {
          if (settled) return;
          settled = true;
          if (result instanceof Error) fail(result);
          else done(result);
        };
        // A comment event arrives inside the write that caused it; the look happens on a turn of its own.
        const check = (): void => {
          if (checking || settled) return;
          checking = true;
          setImmediate(() => {
            checking = false;
            if (settled) return;
            try {
              const found = ready();
              if (found !== null) finish(found);
            } catch (failure) {
              finish(failure instanceof Error ? failure : new Error(String(failure)));
            }
          });
        };
        wait = { root: state.root, agentId: params.agentId, finish, check };
        this.#waits.add(wait);
        timer = setTimeout(() => finish({ timedOut: true }), Math.min(params.timeoutMs, MAX_WAIT_MS));
        if (signal?.aborted === true) return finish({ timedOut: true });
        signal?.addEventListener("abort", () => finish({ timedOut: true }), { once: true });
        unsubscribe = state.subscribe((event) => {
          if (event === "comments") check();
        });
      });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      if (wait !== undefined) this.#waits.delete(wait);
      end();
    }
  }

  /**
   * What an agent did through the comment operations (get_comments, reply_comment, create_comment): a
   * fetch by the thread's recipient (the checkout's listener, or its last answerer) records it read; a
   * reply keeps the conversation with that agent. Reports the agent in; refuses an unknown id.
   *
   * A pull is read when handed out (review decision 19, ADR 0035 §7): get_comments reports its fetch after
   * reading the threads and before its own answer reaches the agent, so a thread it returned at that
   * revision gets every person comment recorded here. If that answer is lost on the way (the agent's
   * connection drops), the comments stay read: fetching them again is the agent's to do, as with any
   * tool result it did not see. Waits and the inbox, which Archer pushes, are acknowledged on write instead.
   */
  reportActivity(params: AgentRequestParams["reportActivity"]): AgentResults["reportActivity"] {
    this.registry.heartbeat({ agentId: params.agentId, via: "cli" });
    const state = this.#attached(params.root);
    const read: string[] = [];
    const threads: Thread[] = [];
    for (const fetched of params.fetched ?? []) {
      if (this.registry.recipient(state.root, fetched.threadId) !== params.agentId) continue;
      const thread = state.threadById(fetched.threadId);
      if (thread !== null && thread.status === "sent" && thread.revision === fetched.revision) threads.push(thread);
    }
    // A refused call changes no delivery state (PD-1): the rule is checked before anything is recorded,
    // and a thread is recorded as handed over only once its read mark is written.
    if (threads.length > 0) assertWriteAllowed(state.root, "comments");
    let recorded = false;
    try {
      for (const thread of threads) {
        if (state.markThreadRead(thread.id, thread.revision)) read.push(thread.id);
        this.#record(
          thread,
          new Map(personComments(thread).map((comment) => [comment.id, hashOf(thread, comment)])),
          ++this.#seq,
          state.root,
        );
        recorded = true;
      }
    } finally {
      if (recorded) {
        this.#bound();
        this.#saveRecords();
      }
    }
    for (const threadId of params.answered ?? []) this.registry.answered(state.root, threadId, params.agentId);
    this.#prune(state.root);
    return { read };
  }

  // ------------------------------------------------------------ the page

  /**
   * What the page and its event see: the same listing with every path written as the project
   * catalog writes it (`~/…`, or only the folder name outside home), since any access-link holder
   * reads it and an absolute path names the account (S13).
   */
  listing(state: ProjectState, view: { readonly personal?: boolean; readonly steps?: boolean } = {}): ListenerListing {
    const home = this.#home;
    const shown = <
      T extends { readonly root: string; readonly listener: AgentInfo | null; readonly agents: readonly AgentInfo[] },
    >(
      status: T,
    ): T => ({
      ...status,
      root: homeRelative(status.root, home),
      listener: status.listener === null ? null : this.#shownAgent(status.listener, home),
      agents: status.agents.map((agent) => this.#shownAgent(agent, home)),
    });
    const raw = this.#rawListing(state);
    // `personal` and `launcher` are for the person's own sign-in on this computer only (review decision
    // 23): an access-link holder or paired device reads the listing without them, and the SSE event,
    // which every stream on the project receives, never carries them (the page keeps them from its GET).
    const personal = view.personal === true;
    return {
      current: shown(raw.current),
      otherCheckouts: raw.otherCheckouts.map(shown),
      // The delivery steps are the owner's alone (D10): they say a launcher exists. The event carries them
      // (`steps`) and the page route strips them from every stream but the owner's (http.ts `events`).
      ...(raw.pending === undefined || !(personal || view.steps === true) ? {} : { pending: raw.pending }),
      ...(personal ? { personal: true } : {}),
      ...(personal && raw.launcher === true ? { launcher: true } : {}),
    };
  }

  #shownAgent(agent: AgentInfo, home: string): AgentInfo {
    return {
      ...agent,
      root: homeRelative(agent.root, home),
      cwd: homeRelative(agent.cwd, home),
      label: pageText(agent.label, home),
    };
  }

  /** The checkout and the other attached checkouts of its repository; never another project. */
  #rawListing(state: ProjectState): ListenerListing {
    const pending = [...this.#steps.values()].filter((step) => step.root === state.root).map((step) => step.shown);
    const commonDir = state.repository?.commonDir;
    const others =
      commonDir === undefined
        ? []
        : this.#options
            .projects()
            .filter((other) => other.root !== state.root && other.repository?.commonDir === commonDir);
    return {
      current: { ...this.registry.status(state.root), agents: this.registry.agentsOf(state.root) },
      otherCheckouts: others.map((other) => ({
        ...this.registry.status(other.root),
        name: other.slug,
        agents: this.registry.agentsOf(other.root),
      })),
      ...(pending.length === 0 ? {} : { pending }),
      ...(this.#launcherSet(state) && this.#policy(state)?.launch !== "off" ? { launcher: true } : {}),
    };
  }

  /** The person's pick from the page; answered with paths written as the page shows them. */
  pin(state: ProjectState, agentId: string | null): ListenerStatus {
    const status = this.pinListener({ root: state.root, agentId });
    return {
      ...status,
      root: homeRelative(status.root, this.#home),
      listener: status.listener === null ? null : this.#shownAgent(status.listener, this.#home),
    };
  }

  /**
   * The person pressed Launch on a thread (decision 1): only while no listener is live in the checkout,
   * only for a thread with person comments no agent has received, and once per project in
   * LAUNCH_REPEAT_MS. Their launcher runs with those comments (launcher.ts). Who may press it is the
   * page route's check (http.ts).
   */
  async launch(state: ProjectState, threadId: string): Promise<{ readonly launched: true; readonly pid?: number }> {
    if (this.#options.launch === undefined) throw new ListenerRefusal("launcher_not_configured", "no launcher is set");
    // Read fresh; a config that cannot be read refuses with its reason (manifest_error).
    if ((this.#options.policy?.(state) ?? DEFAULT_DELIVERY_POLICY).launch === "off")
      throw new ListenerRefusal(
        "launch_off",
        'Launch is turned off for this project (launch = "off", or launch left out of delivery, in archer.toml)',
      );
    return this.#start(state, threadId, "pressed");
  }

  /**
   * Every safeguard of a launch, pressed or automatic: only while no listener is live in the checkout, only for a
   * thread with person comments no agent has received, once per project in LAUNCH_REPEAT_MS. The comments it
   * carries are remembered so none starts another automatic launch, and the bubble says an agent is starting.
   */
  async #start(
    state: ProjectState,
    threadId: string,
    how: "pressed" | "automatic",
  ): Promise<{ readonly launched: true; readonly pid?: number }> {
    const launch = this.#options.launch;
    if (launch === undefined) throw new ListenerRefusal("launcher_not_configured", "no launcher is set");
    if (this.registry.listenerLive(state.root))
      throw new ListenerRefusal(
        "listener_live",
        "an agent is listening in this checkout; it gets the message without a launch",
      );
    const thread = state.threadById(threadId);
    if (thread === null) throw new ListenerRefusal("thread_not_found", "no thread has that id");
    const parcel = thread.status === "sent" ? this.#parcel(state.root, thread, false) : null;
    if (parcel === null)
      throw new ListenerRefusal(
        "thread_not_waiting",
        "that thread has no message from the person that an agent has not received",
      );
    // An automatic launch is judged once more right before it starts, on the whole policy read fresh (X-16).
    if (how === "automatic") {
      const policy = this.#policy(state);
      if (policy === null || !this.#mayStart(state, policy, parcel))
        throw new ListenerRefusal("launch_off", "the delivery settings no longer start an agent for this message");
    }
    const now = this.#now();
    const last = this.#launched.get(state.root);
    if (last !== undefined && now - last <= LAUNCH_REPEAT_MS)
      throw new ListenerRefusal(
        "launch_busy",
        "an agent was launched for this project moments ago; give it a moment to start listening",
      );
    this.#launched.set(state.root, now);
    const key = threadKey(state.root, threadId);
    remember(
      this.#launchedFor,
      parcel.comments.map((comment) => `${key}\0${comment.id}`),
    );
    this.#saveLaunches();
    try {
      const started = await launch(state, {
        threadId,
        target: thread.target,
        text: parcel.comments.map((comment) => comment.body).join("\n\n"),
      });
      this.#options.log?.(
        `[archer] launcher: started (${how}) for thread ${threadId} in ${state.root}${started.pid === undefined ? "" : ` (process ${started.pid})`}`,
      );
      // Shown until an agent takes the message; then a message that arrived meanwhile may start one more.
      if (!this.#closed)
        this.#setStep(
          state,
          threadId,
          { threadId, step: "launching", until: new Date(this.#now() + LAUNCHING_SHOWN_MS).toISOString() },
          LAUNCHING_SHOWN_MS,
          () => this.#offer(state, threadId, "waited"),
        );
      return { launched: true, ...(started.pid === undefined ? {} : { pid: started.pid }) };
    } catch (failure) {
      if (this.#launched.get(state.root) === now) {
        this.#launched.delete(state.root);
        this.#saveLaunches();
      }
      throw failure;
    }
  }

  // ------------------------------------------------------------ the delivery order

  /**
   * The person sent these threads' messages from the page, signed in as `sender` (http.ts). Judged now: only with
   * `launch = "auto"`, a launcher set and a sender launch_for admits does Archer act; otherwise the message waits
   * as before (a listener, the inbox, the owner's Launch). The thread's comments waiting now are marked as
   * qualified; a thread already on its way keeps its step and is looked at again when that step ends.
   */
  arrived(state: ProjectState, threadIds: readonly string[], sender: Sender): void {
    if (this.#closed || threadIds.length === 0) return;
    const policy = this.#policy(state);
    if (
      policy === null ||
      policy.launch !== "auto" ||
      !(policy.launchFor === "anyone" || sender.owner) ||
      !this.#launcherSet(state)
    )
      return;
    for (const threadId of new Set(threadIds)) {
      const key = threadKey(state.root, threadId);
      let thread: Thread | null;
      try {
        thread = state.threadById(threadId);
      } catch {
        thread = null;
      }
      const parcel = thread !== null && thread.status === "sent" ? this.#parcel(state.root, thread, false) : null;
      if (parcel === null) continue;
      // A comment changed since it qualified is taken again only from the owner (C-23): anyone else's edit leaves
      // its old hash, and a qualified comment whose hash is not its current one starts no launch (#mayStart).
      rememberAs(
        this.#qualified,
        parcel.comments.flatMap((comment) => {
          const id = `${key}\0${comment.id}`,
            hash = parcel.hashes.get(comment.id)!,
            held = this.#qualified.get(id);
          if (held === undefined || sender.owner) return [[id, { owner: sender.owner, hash }] as const];
          return held.hash === hash ? [[id, held] as const] : [];
        }),
      );
      if (!this.#steps.has(key)) this.#offer(state, threadId, "arrived");
    }
  }

  /** The next step for a thread's message: `arrived` starts at the listener; `waited` comes back after next_turn. */
  #offer(state: ProjectState, threadId: string, from: "arrived" | "waited"): void {
    const root = state.root,
      key = threadKey(root, threadId);
    if (this.#closed) return;
    // Read fresh: a narrower config at the end of a wait wins, launch_for included (X-16).
    const policy = this.#policy(state);
    let thread: Thread | null;
    try {
      thread = state.threadById(threadId);
    } catch {
      thread = null;
    }
    const parcel = thread !== null && thread.status === "sent" ? this.#parcel(root, thread, false) : null;
    // Once per message, and only for a message a qualifying sender sent: otherwise no step promises a launch.
    if (policy === null || parcel === null || !this.#mayStart(state, policy, parcel)) return this.#clearStep(key);
    // 1. An agent with a wait open takes it now.
    const recipient = this.registry.recipient(root, threadId);
    if (recipient !== null && this.registry.waiting(recipient)) return this.#clearStep(key);
    // 2. A session between turns gets next_turn_wait.
    if (from === "arrived" && policy.order.includes("next_turn") && policy.nextTurnWaitMs > 0) {
      const session = this.#betweenTurns(root, recipient);
      if (session !== undefined) {
        const wait = policy.nextTurnWaitMs;
        return this.#setStep(
          state,
          threadId,
          {
            threadId,
            step: "next-turn",
            host: session.host,
            waitMs: wait,
            until: new Date(this.#now() + wait).toISOString(),
          },
          wait,
          () => this.#offer(state, threadId, "waited"),
        );
      }
    }
    // 3. The launcher, never while the checkout's listener is live.
    const listener = this.registry.status(root);
    if (listener.state === "next-turn" && listener.away !== true && listener.listener !== null && from === "waited") {
      // Still live after the wait: the launch waits until it is away (the safeguard holds).
      const awayAt = Date.parse(listener.listener.lastActive) + LISTENER_EXPIRY_MS + 1;
      const held = this.#steps.get(key);
      const shown: PendingDelivery =
        held?.shown.step === "next-turn"
          ? { ...held.shown, until: new Date(awayAt).toISOString() }
          : {
              threadId,
              step: "next-turn",
              host: listener.listener.host,
              waitMs: policy.nextTurnWaitMs,
              until: new Date(awayAt).toISOString(),
            };
      return this.#setStep(state, threadId, shown, Math.max(1, awayAt - this.#now()), () =>
        this.#offer(state, threadId, "waited"),
      );
    }
    if (listener.state !== "none" && listener.away !== true) return this.#clearStep(key);
    this.#clearStep(key);
    this.#start(state, threadId, "automatic").catch((failure: unknown) => {
      const code = (failure as { code?: unknown }).code;
      this.#options.log?.(
        `[archer] launcher: no automatic launch for thread ${threadId} in ${root}: ${typeof code === "string" ? code : failure instanceof Error ? failure.message : String(failure)}`,
      );
    });
  }

  /** The session a message waits for: the thread's recipient while live; with none, the most recent live agent registered here. */
  #betweenTurns(root: string, recipient: string | null): AgentInfo | undefined {
    if (recipient !== null) return this.registry.isLive(recipient) ? this.registry.agent(recipient) : undefined;
    return this.registry.agentsOf(root).find((agent) => this.registry.isLive(agent.agentId));
  }

  #setStep(state: ProjectState, threadId: string, shown: PendingDelivery, ms: number, then: () => void): void {
    const key = threadKey(state.root, threadId);
    const held = this.#steps.get(key);
    if (held !== undefined) this.#timers.clear(held.timer);
    const timer = this.#timers.set(() => {
      if (this.#steps.get(key)?.timer === timer) then();
    }, ms);
    this.#steps.set(key, { root: state.root, threadId, shown, timer });
    this.#changed(state.root);
  }

  #clearStep(key: string): void {
    const held = this.#steps.get(key);
    if (held === undefined) return;
    this.#timers.clear(held.timer);
    this.#steps.delete(key);
    this.#changed(held.root);
  }

  /** Steps whose message an agent took (or that is no longer sent) end, and the page is told. */
  #prune(root?: string): void {
    for (const [key, step] of [...this.#steps]) {
      if (root !== undefined && step.root !== root) continue;
      const state = this.#state(step.root);
      let thread: Thread | null = null;
      try {
        thread = state?.threadById(step.threadId) ?? null;
      } catch {
        thread = null;
      }
      if (thread === null || thread.status !== "sent" || this.#parcel(step.root, thread, false) === null)
        this.#clearStep(key);
    }
  }

  /**
   * Whether this parcel may start an automatic launch under `policy`: launch = "auto" with a launcher set, and one of
   * its comments not yet launched for that a sender launch_for admits now (the owner flag kept on arrival) sent.
   */
  #mayStart(state: ProjectState, policy: DeliveryPolicy, parcel: Parcel): boolean {
    if (policy.launch !== "auto" || !policy.order.includes("launch") || !this.#launcherSet(state)) return false;
    const key = threadKey(state.root, parcel.thread.id);
    const held = parcel.comments.map((comment) => ({
      id: `${key}\0${comment.id}`,
      hash: parcel.hashes.get(comment.id),
      qualified: this.#qualified.get(`${key}\0${comment.id}`),
    }));
    // Someone other than its qualifying sender edited a comment that qualified (C-23): the message falls back to
    // the inbox and the Launch button, whose press is the owner's look at what it carries.
    if (held.some(({ hash, qualified }) => qualified !== undefined && qualified.hash !== hash)) return false;
    return held.some(
      ({ id, qualified }) =>
        qualified !== undefined && (qualified.owner || policy.launchFor === "anyone") && !this.#launchedFor.has(id),
    );
  }

  #policy(state: ProjectState): DeliveryPolicy | null {
    try {
      return this.#options.policy?.(state) ?? DEFAULT_DELIVERY_POLICY;
    } catch (failure) {
      this.#options.log?.(
        `[archer] listeners: the delivery settings for ${state.root} cannot be read: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      return null;
    }
  }

  #launcherSet(state: ProjectState): boolean {
    if (this.#options.launch === undefined) return false;
    try {
      return this.#options.launcherSet?.(state) ?? true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ lifecycle

  /** A hand-over: every open wait answers `{reconnect: true}`, so the agent calls the replacement. */
  handOver(): void {
    this.#end({ reconnect: true });
  }

  /** A stop: open waits are refused, so a stopped Archer is not restarted by an agent's wait loop. */
  stop(): void {
    this.#end(new ListenerRefusal("service_stopping", "Archer stopped"));
  }

  /** How many waits are open now. */
  get openWaits(): number {
    return this.#waits.size;
  }

  /** How many threads' records are kept now. */
  get trackedThreads(): number {
    return this.#records.size;
  }

  #end(result: WaitResult | Error): void {
    this.#closed = true;
    clearInterval(this.#sweep);
    // Waits do not outlive the service (ADR 0035, amended 2026-10-31): the messages stay in the inbox.
    for (const step of this.#steps.values()) this.#timers.clear(step.timer);
    this.#steps.clear();
    // The clocks as they are now, so the next copy restores who was live (decision 28).
    this.registry.flush();
    for (const wait of [...this.#waits]) wait.finish(result);
  }

  // ------------------------------------------------------------ internals

  /** Open waits whose agent no longer listens where they wait end with `not_listener`. */
  #endStrayWaits(message: string): void {
    for (const wait of [...this.#waits])
      if (!this.registry.isListener(wait.root, wait.agentId)) wait.finish(new ListenerRefusal("not_listener", message));
  }

  /**
   * The sent threads' comments to hand over, oldest first: `all` (nobody asked: everything waiting), or
   * `for` an agent (the threads it is the recipient of, and with `others` the ones nobody listens for).
   * A thread of the agent's with no person comment left to hand over (an earlier recording failed or
   * raced, or the person sent a change the agent does not see, such as a draft written and removed) is
   * recorded read.
   */
  #parcels(
    state: ProjectState,
    who: { readonly kind: "all" } | { readonly kind: "for"; readonly agentId: string; readonly others: boolean },
  ): Parcel[] {
    const taking = who.kind === "for";
    return state.waitingThreads().flatMap((thread) => {
      let mine = false;
      if (who.kind === "for") {
        const recipient = this.registry.recipient(state.root, thread.id);
        if (recipient !== who.agentId && !(who.others && recipient === null)) return [];
        mine = recipient === who.agentId;
      }
      const parcel = this.#parcel(state.root, thread, taking);
      if (parcel === null && mine && !this.#reserved.has(threadKey(state.root, thread.id)))
        this.#markRead(state, thread);
      return parcel === null ? [] : [parcel];
    });
  }

  /**
   * A sent thread's person comments its recipient has not received as they are now, oldest first, with
   * their hashes; null when none is left. A thread in an unwritten answer is left out when `taking`.
   */
  #parcel(root: string, thread: Thread, taking: boolean): Parcel | null {
    if (taking && this.#reserved.has(threadKey(root, thread.id))) return null;
    const record = this.#records.get(threadKey(root, thread.id));
    const hashes = new Map<string, string>();
    const comments = personComments(thread).filter((comment) => {
      const hash = hashOf(thread, comment);
      if (record?.get(comment.id)?.hash === hash) return false;
      hashes.set(comment.id, hash);
      return true;
    });
    return comments.length === 0 ? null : { thread, comments, hashes };
  }

  #markRead(state: ProjectState, thread: Thread): void {
    try {
      state.markThreadRead(thread.id, thread.revision);
    } catch (failure) {
      this.#options.log?.(
        `[archer] listeners: could not record thread ${thread.id} as read: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  /**
   * Reserves the parcels' threads until the answer carrying them is written: then their comments are
   * recorded as handed over and a thread with none left is read; else they are free again. An answer unsettled at
   * the write deadline counts as not written and its parcels are let go; a later settling is ignored
   * (decision 49). Either way open waits look again (comments may have arrived meanwhile).
   */
  #hand(state: ProjectState, parcels: readonly Parcel[], afterWrite: AfterWrite): void {
    if (parcels.length === 0) return;
    const keys = parcels.map((parcel) => threadKey(state.root, parcel.thread.id));
    for (const key of keys) this.#reserved.add(key);
    let carried: readonly Parcel[] | null = parcels;
    // This hand-over's place in order: its records never overwrite a newer one's (decision 57).
    const seq = ++this.#seq;
    const settle = (written: boolean): void => {
      const handed = carried;
      if (handed === null) return;
      carried = null;
      clearTimeout(deadline);
      for (const key of keys) this.#reserved.delete(key);
      if (written) {
        // The threads as they are now, read once: one may have changed while the answer was on its way.
        let waiting: Map<string, Thread>;
        try {
          waiting = new Map(state.waitingThreads().map((thread) => [thread.id, thread]));
        } catch {
          waiting = new Map();
        }
        for (const parcel of handed) {
          let current: Thread | null | undefined = waiting.get(parcel.thread.id);
          if (current === undefined) {
            try {
              current = state.threadById(parcel.thread.id);
            } catch {
              current = null;
            }
          }
          if (current !== null) this.#record(current, parcel.hashes, seq, state.root);
        }
        for (const parcel of handed) {
          const current = waiting.get(parcel.thread.id);
          if (current !== undefined && this.#allReceived(state.root, current)) this.#markRead(state, current);
        }
        // Bounded once the threads that are now read are read, so they are the ones that go first.
        this.#bound();
        this.#saveRecords();
        this.#prune(state.root);
      }
      for (const wait of [...this.#waits]) if (wait.root === state.root) wait.check();
    };
    const deadline = setTimeout(() => {
      if (carried === null) return;
      this.#options.log?.(
        `[archer] listeners: an answer to ${state.root} was not written within ${this.#writeDeadlineMs} ms; its messages wait for the next one`,
      );
      settle(false);
    }, this.#writeDeadlineMs);
    deadline.unref();
    afterWrite(settle);
  }

  /** No person comment of the thread is left to hand over. */
  #allReceived(root: string, thread: Thread): boolean {
    return this.#parcel(root, thread, false) === null;
  }

  /**
   * Records comments as received by hand-over `seq`, with the hashes they were handed over with, on the
   * thread's record as the thread is now: an entry is written only when `seq` is newer than the one there
   * (records only move forward, decision 57), other comments' entries are kept, and only ids the thread no
   * longer has are dropped. The record goes newest last. Every caller then calls #bound before saving.
   */
  #record(thread: Thread, hashes: ReadonlyMap<string, string>, seq: number, root: string): void {
    const key = threadKey(root, thread.id);
    const present = new Set(thread.comments.map((comment) => comment.id));
    const record = new Map<string, Delivered>(
      [...(this.#records.get(key) ?? new Map<string, Delivered>())].filter(([id]) => present.has(id)),
    );
    for (const [id, hash] of hashes) {
      const held = record.get(id);
      if (present.has(id) && (held === undefined || held.seq < seq)) record.set(id, { hash, seq });
    }
    this.#records.delete(key);
    this.#records.set(key, record);
  }

  /**
   * Past MAX_RECORDS threads, whole records go, down to nine tenths of it: those of threads that are read,
   * gone or no longer sent first, then any, the least recently written first. A dropped record can only
   * cost a re-send of its thread's person comments, never a lost one.
   */
  #bound(): void {
    if (this.#records.size <= MAX_RECORDS) return;
    const target = MAX_RECORDS - MAX_RECORDS / 10;
    // One look per root at what is waiting: a thread not among it is read, answered, resolved or gone.
    const waiting = new Map<string, Set<string>>();
    const sent = (key: string): boolean => {
      const [root, threadId] = key.split("\0", 2) as [string, string];
      let ids = waiting.get(root);
      if (ids === undefined) {
        try {
          ids = new Set(
            this.#state(root)
              ?.waitingThreads()
              .map((thread) => thread.id) ?? [],
          );
        } catch {
          ids = new Set();
        }
        waiting.set(root, ids);
      }
      return ids.has(threadId);
    };
    for (const key of [...this.#records.keys()]) {
      if (this.#records.size <= target) break;
      if (!sent(key)) this.#records.delete(key);
    }
    for (const key of [...this.#records.keys()]) {
      if (this.#records.size <= target) break;
      this.#records.delete(key);
    }
  }

  /** The records outlive the service (decision 16); a failed save is logged, and delivery goes on. */
  #saveRecords(): void {
    try {
      this.#store.save({ records: this.#records, deliverySeq: this.#seq });
    } catch (failure) {
      this.#options.log?.(
        `[archer] listeners: could not save delivery records: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  /** Once per message and the project window outlive the service (X-17); a failed save is logged, and the launch goes on. */
  #saveLaunches(): void {
    try {
      this.#store.save({ launches: { launchedFor: [...this.#launchedFor], launched: this.#launched } });
    } catch (failure) {
      this.#options.log?.(
        `[archer] listeners: could not save the launch markers: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  #messages(state: ProjectState, parcels: readonly Parcel[]): InboxMessage[] {
    let views: ReturnType<typeof inventory>["views"] | undefined;
    const reads = new ReferenceReads(
      diskReferenceSources(state.project, () => (views ??= inventory(state.project).views)),
    );
    return parcels
      .flatMap(({ thread, comments }) => {
        let refs: ThreadReferences | undefined;
        try {
          refs = referencesFor(state.project, thread, reads);
        } catch {
          /* the messages still arrive without it */
        }
        return comments.map((comment) => {
          // Each comment says where it was sent from itself (Codex F3); the thread's file, address and lines are shared.
          let where = "";
          if (refs !== undefined) {
            const { page: _page, document: _document, ...shared } = refs;
            const context = comment.context;
            where = wherePhrase(
              context === undefined
                ? shared
                : {
                    ...shared,
                    page: context.page,
                    ...(context.document === undefined ? {} : { document: context.document }),
                  },
            );
          }
          return {
            threadId: thread.id,
            commentId: comment.id,
            target: thread.target,
            text: comment.body,
            at: comment.createdAt,
            ...(where === "" ? {} : { where }),
          };
        });
      })
      .sort((a, b) => a.at.localeCompare(b.at) || a.threadId.localeCompare(b.threadId));
  }

  #state(root: string): ProjectState | undefined {
    return this.#options.projects().find((state) => state.root === root);
  }

  #attached(root: string): ProjectState {
    const state = this.#state(canonicalRoot(root));
    if (state === undefined)
      throw new ListenerRefusal(
        "project_not_attached",
        `no project is attached at ${root.slice(0, 300)}; attach it first`,
      );
    return state;
  }

  #facts(state: ProjectState): CheckoutFacts {
    const worktree = state.repository?.worktree;
    return {
      root: state.root,
      name: state.name,
      checkout: worktree === undefined ? "main" : { worktree: worktree.folder },
      displayRoot:
        state.root === this.#home
          ? "~"
          : state.root.startsWith(`${this.#home}${sep}`)
            ? `~${state.root.slice(this.#home.length)}`
            : state.root,
      commonDir: state.repository?.commonDir ?? null,
    };
  }

  /** A checkout's listener changed: its page, and the pages of its repository's other checkouts, are told. */
  #changed(root: string): void {
    const states = this.#options.projects();
    const changed = states.find((state) => state.root === root);
    const commonDir = changed?.repository?.commonDir;
    for (const state of states) {
      if (state.root !== root && (commonDir === undefined || state.repository?.commonDir !== commonDir)) continue;
      try {
        state.announceListeners(this.listing(state, { personal: false, steps: true }));
      } catch (failure) {
        this.#options.log?.(
          `[archer] listeners: could not tell ${state.root}'s page: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
  }
}

/** Who sent a qualifying comment, as far as launch_for asks (the owner's own sign-in from this computer or not), and what it said then. */
interface Qualified {
  readonly owner: boolean;
  /** The comment's hash (hashOf) when it qualified: an edit by anyone else leaves it behind. */
  readonly hash: string;
}

/** Sets entries as the newest of an insertion-ordered map kept to MAX_LAUNCHED_FOR, the oldest dropped first. */
function rememberAs<T>(map: Map<string, T>, entries: readonly (readonly [string, T])[]): void {
  for (const [id, value] of entries) {
    map.delete(id);
    map.set(id, value);
  }
  for (const id of map.keys()) {
    if (map.size <= MAX_LAUNCHED_FOR) break;
    map.delete(id);
  }
}

/** Adds ids as the newest of an insertion-ordered set kept to MAX_LAUNCHED_FOR, the oldest dropped first. */
function remember(set: Set<string>, ids: readonly string[]): void {
  for (const id of ids) {
    set.delete(id);
    set.add(id);
  }
  for (const id of set) {
    if (set.size <= MAX_LAUNCHED_FOR) break;
    set.delete(id);
  }
}

/** The thread's person comments, in thread order (a sent thread's are all sent). */
const personComments = (thread: Thread): Comment[] => thread.comments.filter((comment) => comment.author === "person");

/** JSON with every object's keys in order, so equal values serialise equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 12 hex digits of a sha256 over what the agent is told of a comment, canonically (decisions 53, 56): the
 * thread's target and anchor (re-anchoring or retargeting changes its meaning) and the whole comment (id,
 * author, text, times, context). Not the thread's status, which delivery itself changes.
 */
const hashOf = (thread: Thread, comment: Comment): string =>
  createHash("sha256")
    .update(canonical([thread.target, thread.anchor, comment]))
    .digest("hex")
    .slice(0, 12);

/** The root of the project a path is in, else the path itself, made real. */
function canonicalRoot(root: string): string {
  try {
    return findProject(root).root;
  } catch {
    return real(root);
  }
}

function real(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}
