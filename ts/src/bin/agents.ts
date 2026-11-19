// `archer projects`, `archer listen [--claim]`, `archer wait` and `archer inbox` (ADR 0035 §7–8): the
// listener's side of delivery. Each talks to the service over the management socket
// (agents/contract.ts); the hook form of inbox lives in hook.ts, which loads far less.
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { briefLine, MAX_WAIT_MS, type AgentInfo, type InboxMessage, type ListenerStatus } from "../agents/contract.ts";
import type { ServiceClient } from "../service/service-client.ts";
import { ServiceCallError, ServiceUnavailableError } from "../service/service-client.ts";
import {
  agentLabel,
  commandHost,
  displayPath,
  HOST_NAMES,
  isAgentId,
  recogniseAgent,
  rememberAgent,
  type DetectedHost,
  type Recognised,
} from "./agent-id.ts";
import { safe, UsageError, usage, type Io } from "./main.ts";

/** Seconds `archer wait` listens by default: under the 30-minute cap unattended hosts put on a background command. */
export const DEFAULT_WAIT_SECONDS = 1500;
/** How long `wait` keeps trying to reach a replacement after the service went away mid-wait. */
const RECONNECT_WINDOW_MS = 30_000;

/** How the agent commands reach the service; injected by tests. */
export interface AgentDeps {
  /** A connected client, starting the service when allowed (`ensureService`). */
  readonly ensure: (io: Io) => Promise<ServiceClient>;
  /** A connected client, or null when no service runs; never starts one. */
  readonly find: (io: Io) => Promise<ServiceClient | null>;
  readonly detect: (io: Io) => DetectedHost;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Whether the host process (claude, codex) still runs. */
  readonly hostAlive: (pid: number) => boolean;
  /** Calls `gone` once the host process has ended; returns what stops watching (decision 21). */
  readonly watchHost: (pid: number, gone: () => void) => () => void;
}

/** How often `archer wait` checks that its host process still runs. */
export const HOST_CHECK_MS = 10_000;

/** A process this user may not signal (EPERM) still runs; only one that is not there (ESRCH) is gone. */
const hostAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const defaultDeps: AgentDeps = {
  ensure: async (io) => (await import("../service/client.ts")).ensureService({ env: io.env }),
  find: async (io) => (await import("../service/client.ts")).connectIfRunning({ env: io.env }),
  detect: (io) => commandHost(io.env),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hostAlive,
  watchHost: (pid, gone) => {
    const timer = setInterval(() => {
      if (!hostAlive(pid)) {
        clearInterval(timer);
        gone();
      }
    }, HOST_CHECK_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
};

const cwdOf = (io: Io): string => {
  const cwd = io.cwd ?? process.cwd();
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
};

async function projectRoot(io: Io): Promise<string> {
  const { openProject } = await import("../application/diagrams.ts");
  return openProject(cwdOf(io)).root;
}

export { displayPath };

/** What a refused or failed listener call tells the agent. */
export function agentFailure(error: unknown): string {
  if (error instanceof ServiceCallError) return error.error.message;
  return error instanceof Error ? error.message : String(error);
}

function fail(io: Io, command: string, error: unknown): number {
  if (error instanceof UsageError) throw error;
  // A refusal from the application layer (no project, an unreadable archer.toml) carries its own message.
  io.stderr(`archer ${command}: ${safe(agentFailure(error))}\n`);
  return 1;
}

export async function runProjects(args: readonly string[], io: Io): Promise<number> {
  const { values } = usage(() =>
    parseArgs({ args: [...args], strict: true, allowPositionals: false, options: { json: { type: "boolean" } } }),
  );
  const { executeOperation } = await import("./operations.ts");
  return executeOperation("list_projects", {}, io, values.json === true);
}

/** The service forgot this agent id (it restarted or handed over, the entry expired). */
export const isAgentUnknown = (error: unknown): boolean =>
  error instanceof ServiceCallError && error.error.code === "agent_unknown";

/** A service that forgets the same id again right after it was registered again: give up rather than loop. */
const MAX_REVIVALS_IN_A_ROW = 3;

/**
 * After `agent_unknown`, which (the service keeping agents and claims across a restart, decision 16)
 * means the service genuinely forgot this agent: registers it again under the same id and claims its
 * checkout again, unless another live agent holds that claim or the person picked another listener.
 * Never fights for a claim.
 */
async function revive(
  client: ServiceClient,
  facts: { root: string; cwd: string; detected: DetectedHost; known: Recognised },
): Promise<void> {
  const { agentId } = facts.known;
  await client.call("registerAgent", {
    root: facts.root,
    cwd: facts.cwd,
    host: facts.detected.host,
    label: label(facts.detected, facts.cwd),
    ...(facts.detected.hostPid === undefined ? {} : { hostPid: facts.detected.hostPid }),
    agentId,
  });
  const { current } = await client.call("listListeners", { root: facts.root });
  const holder = current.listener;
  if (holder !== null && holder.agentId !== agentId && (current.pinnedByPerson || current.away !== true)) {
    throw new Error(
      current.pinnedByPerson
        ? `the person picked another listener (${holder.label}) for this checkout; not taking over. Say so in the thread if the person asks you to listen.`
        : `another agent (${holder.label}) listens in this checkout now; not taking over. Say so in the thread if the person asks you to listen.`,
    );
  }
  const claimed = await client.call("claimListener", { root: facts.root, agentId });
  if (!claimed.claimed) throw new Error(`${claimed.text}; not taking over.`);
}

const label = (detected: DetectedHost, cwd: string): string => agentLabel(detected.host, cwd);

/**
 * Any CLI call from a recognised listener reports in (decision 4), so a listener busy answering — drawing,
 * writing, presenting between waits — is not shown as away. Never starts the service; never fails the call.
 */
export async function reportIn(io: Io, deps: Pick<AgentDeps, "find" | "detect"> = defaultDeps): Promise<void> {
  let client: ServiceClient | null = null;
  try {
    const known = recogniseAgent({ env: io.env, cwd: cwdOf(io), detected: deps.detect(io) });
    if (known === null) return;
    client = await deps.find(io);
    await client?.call("heartbeat", { agentId: known.agentId, via: "cli" });
  } catch {
    /* a forgotten id, no service: the call itself goes ahead */
  } finally {
    client?.close();
  }
}

/** The recognised listener's id, for operations that say who asks (get_comments marks read for the listener). */
export function callerAgentId(io: Io, deps: Pick<AgentDeps, "detect"> = defaultDeps): string | undefined {
  try {
    return recogniseAgent({ env: io.env, cwd: cwdOf(io), detected: deps.detect(io) })?.agentId;
  } catch {
    return undefined;
  }
}

function statusLine(status: ListenerStatus): string {
  const who = status.listener === null ? "" : ` (${status.listener.label}, last active ${status.listener.lastActive})`;
  const state =
    status.state === "listening"
      ? "Listening"
      : status.state === "next-turn"
        ? "Waiting for the agent's next turn"
        : "No agent is listening in this checkout";
  return `${state}${who}${status.pinnedByPerson ? "; the person picked this listener" : ""}`;
}

export async function runListen(args: readonly string[], io: Io, deps: AgentDeps = defaultDeps): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        claim: { type: "boolean" },
        project: { type: "string" },
        "person-requested": { type: "boolean" },
        as: { type: "string" },
        json: { type: "boolean" },
      },
    }),
  );
  if (values.as !== undefined && !isAgentId(values.as))
    throw new UsageError("--as takes the agent id archer listen --claim printed");
  // Decision 15: an agent listens only to the checkout it works in; the old flags get the fix, not a parse error.
  if (values.project !== undefined || values["person-requested"] === true)
    throw new UsageError(
      "claiming another checkout is deferred (not in this release): run  archer listen --claim  from inside that checkout",
    );
  let client: ServiceClient | null = null;
  try {
    const cwd = cwdOf(io);
    const root = await projectRoot(io);
    client = await deps.ensure(io);
    if (values.claim !== true) {
      const listing = await client.call("listListeners", { root });
      io.stdout(
        values.json === true
          ? `${JSON.stringify(listing)}\n`
          : `${safe(statusLine(listing.current))}\n${listing.otherCheckouts.map((other) => `  ${safe(other.name)}: ${safe(statusLine(other))}\n`).join("")}`,
      );
      return 0;
    }
    const detected = deps.detect(io);
    const claimOnce = async (agentId: string) => client!.call("claimListener", { root, agentId });
    const known = recogniseAgent({ as: values.as, env: io.env, cwd, detected });
    let agentId = known?.agentId;
    let claimed: Awaited<ReturnType<typeof claimOnce>> | undefined;
    const register = async (id?: string): Promise<string> =>
      (
        await client!.call("registerAgent", {
          root,
          cwd,
          host: detected.host,
          label: label(detected, cwd),
          ...(detected.hostPid === undefined ? {} : { hostPid: detected.hostPid }),
          ...(id === undefined ? {} : { agentId: id }),
        })
      ).agentId;
    if (agentId !== undefined) {
      // A remembered id the service forgot registers again under the same id, so `--as` keeps working;
      // one a live agent elsewhere holds gives way to a new id.
      try {
        claimed = await claimOnce(agentId);
      } catch (error) {
        if (!isAgentUnknown(error)) throw error;
        try {
          agentId = await register(agentId);
        } catch (taken) {
          if (!(taken instanceof ServiceCallError) || taken.error.code !== "agent_id_taken") throw taken;
          agentId = await register();
        }
        claimed = await claimOnce(agentId);
      }
    }
    if (claimed === undefined) {
      agentId = await register();
      claimed = await claimOnce(agentId);
    }
    const file = rememberAgent(io.env, detected, { agentId: agentId!, root, cwd });
    if (values.json === true) {
      io.stdout(`${JSON.stringify({ ...claimed, agentId, sessionFile: file })}\n`);
      return 0;
    }
    const lines = [claimed.text, `Agent id: ${agentId}`];
    if (!claimed.claimed && claimed.pinnedBy !== undefined)
      lines.push(
        `The person picked another listener (${claimed.pinnedBy.label}): say so in the thread rather than taking over.`,
      );
    else
      lines.push(
        "Tell the person that line, then keep listening: run  archer wait  in the background, and again after each message.",
      );
    if (file === null)
      lines.push(
        `Pass --as ${agentId} to archer wait and archer inbox: this session's host process was not found, so Archer cannot tell later calls come from this session without it.`,
      );
    io.stdout(`${lines.map(safe).join("\n")}\n`);
    return 0;
  } catch (error) {
    return fail(io, "listen", error);
  } finally {
    client?.close();
  }
}

/** One message as `wait` and `inbox` print it: the person's words quoted, never as instructions. */
export function messageText(message: InboxMessage): string {
  const on = message.target === "project:" ? "the project conversation" : message.target;
  return [
    `Message from the person in Archer (${on}, thread ${message.threadId}, ${message.at}):`,
    ...message.text.split("\n").map((line) => `> ${line}`),
    ...(message.where === undefined ? [] : [`Where: ${message.where}`]),
  ]
    .map(safe)
    .join("\n");
}

function parseWaitArgs(args: readonly string[]): { as?: string; seconds: number; json: boolean } {
  const { values } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { as: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } },
    }),
  );
  if (values.as !== undefined && !isAgentId(values.as))
    throw new UsageError("--as takes the agent id archer listen --claim printed");
  const seconds = values.timeout === undefined ? DEFAULT_WAIT_SECONDS : Number(values.timeout);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400)
    throw new UsageError("--timeout takes whole seconds, 0 to 86400");
  return { ...(values.as === undefined ? {} : { as: values.as }), seconds, json: values.json === true };
}

const NOT_RECOGNISED =
  "no listener is recognised for this session. Run  archer listen --claim  in this checkout first (it prints the agent id), or pass --as <agent id>.";

/**
 * `archer wait`: held until a message from the person arrives, then prints it and exits 0. Loops over
 * `waitMessage` (at most MAX_WAIT_MS each); a handover answers `{reconnect}` and the loop dials the
 * replacement. While it runs it is the listener's heartbeat. At the deadline it exits 0 with one line.
 */
export async function runWait(args: readonly string[], io: Io, deps: AgentDeps = defaultDeps): Promise<number> {
  const options = parseWaitArgs(args);
  const cwd = cwdOf(io);
  // Detected once: without /proc each detection is a ps walk (decision 37).
  const detected = deps.detect(io);
  const known = recogniseAgent({ as: options.as, env: io.env, cwd, detected });
  if (known === null) {
    io.stderr(`archer wait: ${NOT_RECOGNISED}\n`);
    return 1;
  }
  // Decision 21: a wait whose host session ended stops, so it neither takes messages nor keeps "Listening".
  const hostGone = (): number => {
    io.stdout(
      `The agent session this wait ran under (${HOST_NAMES[detected.host]}, process ${detected.hostPid}) has ended: stopped listening.\n`,
    );
    return 0;
  };
  if (detected.hostPid !== undefined && !deps.hostAlive(detected.hostPid)) return hostGone();
  let client: ServiceClient | null = null;
  let gone = false;
  const unwatch =
    detected.hostPid === undefined
      ? () => undefined
      : deps.watchHost(detected.hostPid, () => {
          gone = true;
          client?.close();
        });
  try {
    const root = known.root ?? (await projectRoot(io));
    const deadline = deps.now() + options.seconds * 1000;
    let lostSince: number | null = null;
    let connectedOnce = false;
    let revivals = 0;
    for (;;) {
      if (gone) return hostGone();
      const remaining = deadline - deps.now();
      try {
        client ??= await deps.ensure(io);
        // The host may have ended while the service was being reached (a slow start): take nothing then.
        if (gone || (detected.hostPid !== undefined && !deps.hostAlive(detected.hostPid))) return hostGone();
        connectedOnce = true;
        lostSince = null;
        const answer = await client.call("waitMessage", {
          root,
          agentId: known.agentId,
          timeoutMs: Math.max(0, Math.min(remaining, MAX_WAIT_MS)),
        });
        revivals = 0;
        if ("messages" in answer && answer.messages.length > 0) {
          io.stdout(
            options.json
              ? `${JSON.stringify(answer)}\n`
              : `${answer.messages.map(messageText).join("\n\n")}\n\nAnswer the person (a thread: archer call reply_comment), then run  archer wait  again in the background to keep listening.\n`,
          );
          return 0;
        }
        if ("reconnect" in answer) {
          client.close();
          client = null;
          continue;
        }
      } catch (error) {
        if (gone) return hostGone();
        // Each time the service forgot this listener, not once per run; any other refusal ends the wait.
        if (isAgentUnknown(error) && client !== null && revivals < MAX_REVIVALS_IN_A_ROW) {
          revivals += 1;
          await revive(client, { root, cwd: known.cwd ?? cwd, detected, known });
          continue;
        }
        // The service went away mid-wait (a hot swap's old copy closing, a crash): dial again for a while.
        if (!(error instanceof ServiceUnavailableError) || !connectedOnce) throw error;
        client?.close();
        client = null;
        lostSince ??= deps.now();
        if (deps.now() - lostSince > RECONNECT_WINDOW_MS || deps.now() >= deadline) throw error;
        await deps.sleep(250);
        continue;
      }
      if (deps.now() >= deadline) {
        io.stdout(
          options.json
            ? `${JSON.stringify({ timedOut: true })}\n`
            : `No message from the person in Archer in ${options.seconds} s. Run  archer wait  again to keep listening.\n`,
        );
        return 0;
      }
    }
  } catch (error) {
    return gone ? hostGone() : fail(io, "wait", error);
  } finally {
    unwatch();
    client?.close();
  }
}

/** `archer inbox [--brief] [--json] [--as id]`: what waits; a recognised listener's fetch marks it read. */
export async function runInbox(args: readonly string[], io: Io, deps: AgentDeps = defaultDeps): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { brief: { type: "boolean" }, as: { type: "string" }, json: { type: "boolean" } },
    }),
  );
  if (values.as !== undefined && !isAgentId(values.as))
    throw new UsageError("--as takes the agent id archer listen --claim printed");
  let client: ServiceClient | null = null;
  try {
    const cwd = cwdOf(io);
    const detected = deps.detect(io);
    const known = recogniseAgent({ as: values.as, env: io.env, cwd, detected });
    const root = known?.root ?? (await projectRoot(io));
    client = await deps.find(io);
    if (client === null) {
      io.stdout(
        values.json === true
          ? `${JSON.stringify({ running: false, count: 0, messages: [] })}\n`
          : "Archer is not running: nothing is waiting.\n",
      );
      return 0;
    }
    const brief = values.brief === true;
    // A recognised agent always says who asks: the brief count is then only what would reach it (decision 5).
    const ask = () =>
      client!.call("inbox", {
        root,
        ...(known === null ? {} : { agentId: known.agentId }),
        ...(brief ? { brief: true } : {}),
      });
    let inbox: Awaited<ReturnType<typeof ask>> | undefined;
    for (let revivals = 0; inbox === undefined; revivals += 1) {
      try {
        inbox = await ask();
      } catch (error) {
        if (!isAgentUnknown(error) || known === null || revivals >= MAX_REVIVALS_IN_A_ROW) throw error;
        await revive(client, { root, cwd: known.cwd ?? cwd, detected, known });
      }
    }
    if (values.json === true) io.stdout(`${JSON.stringify(inbox)}\n`);
    else if (brief)
      io.stdout(`${inbox.count === 0 ? "No messages from the person in Archer." : briefLine(inbox.count)}\n`);
    else
      io.stdout(
        inbox.count === 0
          ? "No messages from the person in Archer.\n"
          : `${inbox.messages.map(messageText).join("\n\n")}\n`,
      );
    return 0;
  } catch (error) {
    return fail(io, "inbox", error);
  } finally {
    client?.close();
  }
}

export type { AgentInfo };
