// Agents, listeners and delivery (ADR 0035 §6–8): the shared contract for the 0.7.0 builders.
// Written before the service (B1), the CLI and relay (B2) and the installer and page (B3) so they
// can be built in parallel; change it only with all three sides' tests. Additive to the management
// protocol: PROTOCOL_VERSION stays 1, so a relay of the previous public release keeps working.

/** A listener that has not reported in for this long shows as away; the next claim takes over. */
export const LISTENER_EXPIRY_MS = 120_000;
/** The longest one `waitMessage` call is held open; the CLI's `archer wait` loops over it. */
export const MAX_WAIT_MS = 600_000;

/**
 * What the chat bubble says about delivery. `listening`: a listener's `archer wait` is connected now.
 * `next-turn`: a listener holds the claim but is not waiting (it sees messages on its next turn, via the
 * turn-start hook or a pull). `none`: nobody claimed this checkout, or the claim expired.
 */
export type ListenerState = "listening" | "next-turn" | "none";

/** The agent host, from the relay's or CLI's own detection; `other` when unknown. */
export type AgentHost = "claude-code" | "codex" | "other";

/** How a listener last reported in. */
export type HeartbeatVia = "wait" | "hook" | "cli";

/** One registered agent session (not an ADR 0006 "session", which is a project attachment). */
export interface AgentInfo {
  readonly agentId: string;
  /** The canonical project root it registered against. */
  readonly root: string;
  /** Its working directory, inside `root`. */
  readonly cwd: string;
  readonly host: AgentHost;
  /** Shown in the picker: "Claude Code · ~/code/archer". At most 80 code points. */
  readonly label: string;
  /** ISO time of its last report. */
  readonly lastActive: string;
}

/** Everything about one checkout's listener that the page and `archer listen` show. */
export interface ListenerStatus {
  readonly root: string;
  readonly state: ListenerState;
  readonly listener: AgentInfo | null;
  /** True when the person picked this listener in the bubble; an agent's claim then does not take over. */
  readonly pinnedByPerson: boolean;
  /**
   * The listener holds the claim but has not reported in for LISTENER_EXPIRY_MS: the bubble tags it
   * "away", another claim may take over, and Launch may be offered. `state` is then `next-turn`
   * until LISTENER_FORGET_MS, after which the claim is dropped (`none`).
   */
  readonly away?: boolean;
}

/** After this long without a report an away listener's claim is dropped. */
export const LISTENER_FORGET_MS = 30 * 60_000;

/**
 * The checkout and its linked worktrees (same `RepositoryStatus.commonDir`); other projects never appear.
 * `otherCheckouts` is for information only ("listening in worktree X"): an agent listens only to the
 * checkout it works in, and a sibling's agent cannot be picked here (`cross_checkout_deferred`, review
 * round 2 decision 15).
 */
export interface ListenerListing {
  readonly current: ListenerStatus & { readonly agents: readonly AgentInfo[] };
  readonly otherCheckouts: readonly (ListenerStatus & {
    readonly name: string;
    readonly agents: readonly AgentInfo[];
  })[];
  /**
   * Additive (round 2, decision 23): the request carries the owner's own sign-in from this computer, the
   * one that may pin and Launch. Only on the page's GET; absent for access links, paired devices, and in
   * the LISTENER_EVENT payload (the page keeps it from its GET).
   */
  readonly personal?: boolean;
  /**
   * Additive (ADR 0035, amended 2026-10-31): the messages on their way through the delivery order, so the bubble
   * says which step each is on. Present only when one is, and only to the owner's own sign-in from this computer
   * (D10, on the GET and on that viewer's `listeners` event): it says a launcher exists. No paths and no config.
   */
  readonly pending?: readonly PendingDelivery[];
  /** The person set a launcher (ADR 0035 §8): the bubble may offer Launch when nobody listens. On the page's GET only with `personal`, never in the event; the socket's listing carries it as before. */
  readonly launcher?: boolean;
}

/**
 * A thread's message on its way (ADR 0035, amended 2026-10-31). `next-turn`: a session between turns has until
 * `until` (ISO) to take it (`waitMs` as configured), then the person's launcher runs. `launching`: the launcher was
 * started for it; shown until `until`, or until an agent takes the message.
 */
export type PendingDelivery =
  | {
      readonly threadId: string;
      readonly step: "next-turn";
      readonly host: AgentHost;
      readonly waitMs: number;
      readonly until: string;
    }
  | { readonly threadId: string; readonly step: "launching"; readonly until: string };

/** One message waiting for the listener: a thread's newest person entry, with what it points at. */
/** One person comment the listener has not fetched yet; a thread with several gives several, oldest first. */
export interface InboxMessage {
  readonly threadId: string;
  /** The comment itself: "read" is recorded per comment, once its delivery was written. */
  readonly commentId: string;
  /** `project:` for the project conversation, else the document the thread is on (ADR 0034 §9–10). */
  readonly target: string;
  readonly text: string;
  readonly at: string;
  /** File, address, elements, lines and page, as the comment's references carry them. */
  readonly where?: string;
}

/** The exact claim confirmation the agent repeats to the person. */
export function claimText(
  projectName: string,
  checkout: "main" | { readonly worktree: string },
  displayRoot: string,
): string {
  const which = checkout === "main" ? "main checkout" : `worktree ${checkout.worktree}`;
  return `Listening for ${projectName} (${which}, ${displayRoot})`;
}

// ---- Management-protocol methods (protocol.ts unions import these) ----

export interface AgentRequestParams {
  /**
   * `agentId` (additive, B1): register again under the id this agent had before the service restarted or
   * handed over, so `--as <id>` keeps working; refused (`agent_id_taken`) while a live agent elsewhere holds it.
   */
  readonly registerAgent: {
    readonly root: string;
    readonly cwd: string;
    readonly host: AgentHost;
    readonly label: string;
    readonly hostPid?: number;
    readonly agentId?: string;
  };
  /** An agent claims the checkout it works in: listening across checkouts is deferred (round 2, decision 15). */
  readonly claimListener: { readonly root: string; readonly agentId: string };
  readonly heartbeat: { readonly agentId: string; readonly via: HeartbeatVia };
  /** Held until a message waits for this listener, `timeoutMs` passes, or the service hands over. */
  readonly waitMessage: { readonly root: string; readonly agentId: string; readonly timeoutMs: number };
  /** Without `agentId`: what waits in the checkout, without marking anything read. */
  readonly inbox: { readonly root: string; readonly agentId?: string; readonly brief?: boolean };
  readonly listListeners: { readonly root: string };
  /**
   * Additive (F1): what an agent did through the comment operations, sent by the CLI and hostMcp after
   * get_comments (`fetched`, each thread at the revision it read) and after reply_comment or
   * create_comment (`answered`). A fetch by the thread's recipient (the checkout's listener, or the agent
   * that last answered the thread) records it read; an answer keeps the conversation with that agent.
   * Reports the agent in; `agent_unknown` for an id the service does not know.
   */
  readonly reportActivity: {
    readonly root: string;
    readonly agentId: string;
    readonly fetched?: readonly { readonly threadId: string; readonly revision: number }[];
    readonly answered?: readonly string[];
  };
  /** The person's pick in the bubble, of an agent working in that checkout. Page route only: the management socket refuses it (an agent must not replace the person's pick). */
  readonly pinListener: { readonly root: string; readonly agentId: string | null };
  /**
   * Turns this connection into an MCP relay: after the `{ok:true}` answer the socket carries raw MCP
   * JSON-RPC lines both ways, served by `hostMcp` (mcp/host-contract.ts) with this cwd. The relay
   * process sends only its own launch facts, never Archer logic.
   */
  readonly mcpRelay: {
    readonly cwd: string;
    readonly host: AgentHost;
    readonly relayVersion: string /** Additive: the agent id the relay registered its session under, with `registerAgent` on this same connection; any other id is ignored (round 2, Claude 14). */;
    readonly agentId?: string;
  };
}

export interface AgentResults {
  readonly registerAgent: { readonly agentId: string };
  /** `claimed: false` with `pinnedBy`: the person pinned another listener; say so in the thread. */
  /** `claimedRoot`: the checkout now listened to; since round 2 (decision 15) always the agent's own `listener.root`. */
  readonly claimListener: {
    readonly claimed: boolean;
    readonly claimedRoot: string;
    readonly listener: AgentInfo;
    readonly pinnedBy?: AgentInfo;
    readonly text: string;
  };
  /** `claimedRoot` (additive, F1): the checkout this agent listens to now, if any (its own). */
  readonly heartbeat: { readonly state: ListenerState; readonly claimedRoot?: string };
  /** `reconnect`: the service is handing over (ADR 0032); call again on the replacement. */
  readonly waitMessage:
    | { readonly messages: readonly InboxMessage[] }
    | { readonly timedOut: true }
    | { readonly reconnect: true };
  readonly inbox: { readonly count: number; readonly messages: readonly InboxMessage[] };
  readonly listListeners: ListenerListing;
  /** The threads this call recorded as read for the person. */
  readonly reportActivity: { readonly read: readonly string[] };
  readonly pinListener: ListenerStatus;
  readonly mcpRelay: { readonly relaying: true };
}

export type AgentMethod = keyof AgentRequestParams;
/** The methods the management socket accepts (pinListener is the page's alone). */
export const AGENT_METHODS: readonly AgentMethod[] = [
  "registerAgent",
  "claimListener",
  "heartbeat",
  "waitMessage",
  "inbox",
  "listListeners",
  "reportActivity",
  "mcpRelay",
];

// ---- Installed hook (B3 writes it; B2 implements the command) ----

/**
 * The one Archer-owned turn-start hook. It always exits 0 (exit 2 blocks the person's prompt in
 * Claude Code), prints nothing when nothing waits or no service runs, never starts the service and
 * never loads the compiler.
 */
export const HOOK_COMMAND = {
  "claude-code": "archer inbox --brief --hook claude-code",
  codex: "archer inbox --brief --hook codex",
} as const;
/** The brief line: "2 messages from the person in Archer: run `archer inbox`". */
export function briefLine(count: number): string {
  return count === 0
    ? ""
    : `${count} ${count === 1 ? "message" : "messages"} from the person in Archer: run \`archer inbox\``;
}

// ---- Launcher fallback (config owned by the person; ADR 0028) ----

/** The message reaches the launched command only through these variables, never its argv or a shell. */
export const LAUNCHER_ENV = {
  message: "ARCHER_MESSAGE",
  threadId: "ARCHER_THREAD_ID",
  project: "ARCHER_PROJECT_ROOT",
  target: "ARCHER_TARGET",
} as const;

// ---- Browser (data plane, ADR 0015: one additive capability and event) ----

export const LISTENER_CAPABILITY = "listeners";
/** Project-scoped routes under `/p/<slug>/`. GET answers ListenerListing; pin takes {agentId|null}; launch takes {threadId}. */
export const LISTENER_ROUTES = {
  list: "api/listeners",
  pin: "api/listeners/pin",
  launch: "api/listeners/launch",
} as const;
/** Server-sent event carrying a ListenerListing whenever a claim, heartbeat state, pin or expiry changes it. */
export const LISTENER_EVENT = "listeners";
