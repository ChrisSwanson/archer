// `archer mcp` (ADR 0035 §6): a thin relay from the host's stdio to the one running Archer service.
// It carries no Archer logic and imports neither the MCP SDK nor the compiler: it dials the service's
// socket, says `hello`, registers its session as an agent (`registerAgent`, so the service knows the
// listener on `get_comments`), says `mcpRelay {cwd, host, relayVersion, agentId}`, and from then on
// forwards MCP lines both ways. What it does to them is one small state machine (`relay` below):
//
// - Request ids are the relay's own both ways. Every request toward the service (the client's and the
//   relay's own) goes under the next relay number and its answer goes back under the client's id, so
//   no client id collides with the relay's. Server-to-client ids are rewritten per connection
//   generation, so a late answer to the old copy's request (an approval) never reaches the
//   replacement, whose ids start again at 0; the client is told the old request was cancelled.
// - When the service hands over (ADR 0032) the socket closes; the relay dials the replacement without
//   starting anything. After a stop, or when nothing answers, only a client request that needs Archer
//   (`initialize`, `tools/call`, `resources/read`, `prompts/get`) starts it; a `ping` is answered by
//   the relay itself, so an open session never brings back a stopped Archer.
// - On a replacement the client's handshake is replayed (its answer swallowed) before other traffic;
//   an initialize still unanswered is sent once more as the client's own. A call written to a copy
//   that went away is answered "outcome unknown: check before retrying" and forgotten (a write may be
//   done); a call still waiting was never sent, so it goes to the next copy. A call the client
//   cancelled is forgotten too. A planned hand-over says what it never ran: a call refused
//   `handover_not_run`, and after the service's hand-over notice every call it left unanswered, go to
//   the next copy once, and nothing more is written to the old one (O56).
// - `notifications/tools/list_changed` goes to the client only when the replacement's tool list
//   differs from the one the client last listed.
// - Lines are bounded per line, in bytes, both ways; waiting lines are bounded too.
//
// Fallback (chosen): when the service refuses `mcpRelay` or cannot be reached or started at launch,
// the relay runs the in-process server instead, so MCP keeps working; ARCHER_MCP_IN_PROCESS=1 forces that.
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { Readable } from "node:stream";
import type { AgentHost } from "../agents/contract.ts";
import { PROTOCOL_VERSION } from "../service/protocol.ts";
import { serviceDirs, socketProblem, type Env } from "../service/paths.ts";
import { version } from "../version.ts";
import { agentLabel, detectHost, hasSessionFile, recogniseAgent, rememberAgent } from "../bin/agent-id.ts";
import { hookProjectRoot } from "../bin/hook.ts";
import { RELAY_HANDOVER_NOTICE } from "./host-contract.ts";

/** Lines longer than this from either side are refused (the service bounds its own the same way). */
/** The service allows the same (service/socket.ts MAX_RELAY_LINE_BYTES). */
export const MAX_RELAY_LINE_BYTES = 16 * 1024 * 1024;
/** Lines from the client waiting for a connection: at most this many, and this many bytes. */
export const MAX_QUEUED_LINES = 256;
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
/** How long the relay keeps dialing after the service went away, or after a request found none. */
export const RECONNECT_WINDOW_MS = 30_000;

/** What a call cut by a restart is answered: it may have been done, so the agent checks first. */
export const OUTCOME_UNKNOWN =
  "Archer's service restarted while this call ran, so its outcome is unknown: check before retrying (a write may already be done; read the current state first).";

export interface RelayLaunchFacts {
  readonly cwd: string;
  readonly host: AgentHost;
  readonly relayVersion: string;
}

/**
 * How the relay registers its MCP session as an agent (decision 10). `agentId` starts as the id this
 * session already has (its session file, ARCHER_AGENT_ID) and is kept across reconnects; `remember`
 * is told the id the service gave, so `archer listen --claim` in the same session claims as it.
 */
export interface RelayIdentity {
  readonly root: string;
  readonly cwd: string;
  readonly host: AgentHost;
  readonly label: string;
  readonly hostPid?: number;
  agentId?: string;
  readonly remember?: (agentId: string) => void;
}

/** The service refused this relay (its hello or mcpRelay). */
export class RelayRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayRefused";
  }
}

/**
 * The socket failed the management admission (R4, X-12): not the user's, not a socket, or in a directory
 * others can reach. Nothing was sent to it and nothing is started or served around it.
 */
export class UnsafeSocket extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSocket";
  }
}

/** A socket that answered `mcpRelay`, any relay bytes that arrived with the answer, and the service's facts. */
export interface RelaySocket {
  readonly socket: Socket;
  readonly leftover: Buffer | string;
  readonly serviceVersion?: string;
  readonly agentId?: string;
}

export interface RelayOptions {
  readonly launch: RelayLaunchFacts;
  readonly input: Readable;
  readonly write: (text: string) => void;
  /**
   * A connected, upgraded relay socket. `start` false: only a service already running (or a hand-over's
   * replacement) is dialed, never started; true: the service is started when needed.
   */
  readonly dial: (start: boolean) => Promise<RelaySocket>;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Bounds, for tests; the exported constants by default. */
  readonly maxLineBytes?: number;
  readonly maxQueuedLines?: number;
  readonly maxQueuedBytes?: number;
}

/**
 * Splits a byte stream into lines, checking every line in bytes before it is decoded: a complete line
 * over `max` is refused as surely as an unfinished one. `onLine` gets the line without its newline.
 */
export class LineReader {
  private parts: Buffer[] = [];
  private size = 0;
  private failed = false;
  constructor(
    private readonly max: number,
    private readonly onLine: (line: string) => void,
    private readonly onTooLong: () => void,
  ) {}

  /** False once a line was too long: nothing more is read. */
  push(chunk: Buffer | string): boolean {
    if (this.failed) return false;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    let start = 0;
    for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
      const piece = bytes.subarray(start, end);
      start = end + 1;
      if (this.size + piece.length > this.max) return this.tooLong();
      const whole = this.parts.length === 0 ? piece : Buffer.concat([...this.parts, piece]);
      this.parts = [];
      this.size = 0;
      this.onLine(whole.toString("utf8").replace(/\r$/, ""));
      if (this.failed) return false;
    }
    const rest = bytes.subarray(start);
    if (this.size + rest.length > this.max) return this.tooLong();
    if (rest.length > 0) {
      this.parts.push(rest);
      this.size += rest.length;
    }
    return true;
  }

  private tooLong(): false {
    this.failed = true;
    this.parts = [];
    this.size = 0;
    this.onTooLong();
    return false;
  }
}

interface Answer {
  id?: unknown;
  ok?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
}

/**
 * Sends hello, registerAgent (with `identity`) and mcpRelay on `socket`; resolves once the service
 * answered mcpRelay `{ok:true}`. A refused registration does not stop the relay: it relays without one.
 */
export function upgrade(socket: Socket, launch: RelayLaunchFacts, identity?: RelayIdentity): Promise<RelaySocket> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let serviceVersion: string | undefined;
    let agentId: string | undefined;
    let step: "hello" | "register" | "register-new" | "mcpRelay" = "hello";
    let nextId = 1;
    let waitingFor = 0;
    const done = (error?: Error): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error !== undefined) {
        socket.destroy();
        reject(error);
      }
    };
    const ask = (method: string, params: object): void => {
      waitingFor = nextId++;
      socket.write(`${JSON.stringify({ id: waitingFor, method, params })}\n`);
    };
    const register = (identity: RelayIdentity, withId: string | undefined): void => {
      ask("registerAgent", {
        root: identity.root,
        cwd: identity.cwd,
        host: identity.host,
        label: identity.label,
        ...(identity.hostPid === undefined ? {} : { hostPid: identity.hostPid }),
        ...(withId === undefined ? {} : { agentId: withId }),
      });
    };
    const relayAsk = (): void => ask("mcpRelay", { ...launch, ...(agentId === undefined ? {} : { agentId }) });
    const onError = (error: Error): void =>
      done(new Error(`cannot reach the Archer service: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    const onClose = (): void => done(new Error("the Archer service closed the connection before relaying"));
    const onData = (chunk: Buffer | string): void => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        let answer: Answer;
        try {
          answer = JSON.parse(line) as Answer;
        } catch {
          return done(new Error("the Archer service answered with something that is not JSON"));
        }
        if (answer.id !== waitingFor) continue;
        const code = String(answer.error?.code ?? "internal");
        if (step === "hello") {
          if (answer.ok !== true)
            return done(
              new RelayRefused(code, `the Archer service refused hello: ${String(answer.error?.message ?? code)}`),
            );
          serviceVersion = typeof answer.result?.["version"] === "string" ? answer.result["version"] : undefined;
          if (identity === undefined) {
            step = "mcpRelay";
            relayAsk();
          } else {
            step = "register";
            register(identity, identity.agentId);
          }
        } else if (step === "register" || step === "register-new") {
          if (answer.ok === true && typeof answer.result?.["agentId"] === "string") {
            agentId = answer.result["agentId"];
            if (identity !== undefined && identity.agentId !== agentId) {
              identity.agentId = agentId;
              identity.remember?.(agentId);
            }
          } else if (step === "register" && code === "agent_id_taken" && identity?.agentId !== undefined) {
            // A live agent elsewhere holds the id this session had: this session gets its own.
            step = "register-new";
            register(identity, undefined);
            continue;
          }
          // The registration was refused: relay without an agent.
          step = "mcpRelay";
          relayAsk();
        } else {
          if (answer.ok !== true)
            return done(
              new RelayRefused(code, `the Archer service refused mcpRelay: ${String(answer.error?.message ?? code)}`),
            );
          done();
          resolve({
            socket,
            leftover: buffer,
            ...(serviceVersion === undefined ? {} : { serviceVersion }),
            ...(agentId === undefined ? {} : { agentId }),
          });
          return;
        }
      }
      if (buffer.length > MAX_RELAY_LINE_BYTES) done(new Error("the Archer service sent an answer too long to read"));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    ask("hello", { protocolVersion: PROTOCOL_VERSION });
  });
}

/**
 * Dials the socket at `path` once it passes the same admission as the regular client (socketProblem:
 * the user's own socket, not a link, in a private directory); rejects with UnsafeSocket when it does
 * not, else with the system's code (ENOENT, ECONNREFUSED, EPERM…).
 */
export function dialSocket(path: string): Promise<Socket> {
  const unsafe = socketProblem(path);
  if (unsafe !== undefined) return Promise.reject(new UnsafeSocket(unsafe));
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export interface DialOptions {
  /** Registers the session as an agent on every connection (production passes it; see runMcp). */
  readonly identity?: RelayIdentity;
  /** Starts the service when nothing answers; the CLI's start path by default (loaded only then). */
  readonly ensure?: (env: Env) => Promise<void>;
}

const defaultEnsure = async (env: Env): Promise<void> => {
  const { ensureService } = await import("../service/client.ts");
  (await ensureService({ env })).close();
};

/**
 * The production dial: the service's socket, or, when nothing answers there and `start` allows it,
 * the CLI's own start path and the socket again. With `start` false nothing is ever started. Every
 * attempt, initial or reconnect, is admitted first (dialSocket); an unsafe socket is never started around.
 */
export function serviceDial(
  env: Env,
  launch: RelayLaunchFacts,
  options: DialOptions = {},
): (start?: boolean) => Promise<RelaySocket> {
  return async (start = true) => {
    const path = serviceDirs(env).socketPath;
    let socket: Socket;
    try {
      socket = await dialSocket(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!start || (code !== "ENOENT" && code !== "ECONNREFUSED")) throw error;
      await (options.ensure ?? defaultEnsure)(env);
      socket = await dialSocket(path);
    }
    return upgrade(socket, launch, options.identity);
  };
}

interface Parsed {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}
type Id = string | number;
const parse = (line: string): Parsed | null => {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Parsed) : null;
  } catch {
    return null;
  }
};
const hasId = (message: Parsed | null): message is Parsed & { id: Id } =>
  message !== null && (typeof message.id === "string" || typeof message.id === "number");
const isRequest = (message: Parsed | null): message is Parsed & { id: Id; method: string } =>
  hasId(message) && typeof message.method === "string";
const isResponse = (message: Parsed | null): message is Parsed & { id: Id } =>
  hasId(message) && message.method === undefined;
const key = (id: Id): string => `${typeof id}:${id}`;
const digest = (tools: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(tools ?? null))
    .digest("hex");

/**
 * The client requests that may start a stopped Archer (decision 20): the ones that need it. A `ping`,
 * a listing or a notification never does; the relay answers a ping itself while no service is up.
 */
export const STARTING_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "tools/call",
  "resources/read",
  "prompts/get",
]);

/** What the relay answers a request that needs no start while Archer is stopped. */
export const NOT_RUNNING = "Archer is not running (it was stopped); the next tool call starts it again.";

/** A client line waiting for a connection; `generation` is the connection a client answer belongs to. */
interface Queued {
  readonly line: string;
  readonly message: Parsed | null;
  readonly generation: number;
}

/** A request the relay sent to the service under its own id: the client's (with the client's id), or its own. */
type Sent =
  | {
      readonly kind: "client";
      readonly id: Id;
      readonly method: string;
      readonly listsAll: boolean;
      readonly line: string;
      readonly generation: number;
    }
  | { readonly kind: "replay" | "tools"; readonly generation: number };

/**
 * Relays until the client closes stdin. `first` is the connection made at launch (its handshake decided
 * relay over fallback). Resolves when the client is gone.
 */
export async function relay(first: RelaySocket, options: RelayOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const maxLine = options.maxLineBytes ?? MAX_RELAY_LINE_BYTES;
  const maxQueuedLines = options.maxQueuedLines ?? MAX_QUEUED_LINES;
  const maxQueuedBytes = options.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const toClient = (message: object): void => options.write(`${JSON.stringify(message)}\n`);
  const fail = (id: Id, message: string): void => toClient({ jsonrpc: "2.0", id, error: { code: -32603, message } });

  // ---- State ----
  let socket: Socket | null = null;
  /** Counts connections; a line or answer of an older one is never taken for the current one's. */
  let generation = 0;
  /** The client's handshake, replayed to every replacement once it was answered. */
  let initialize: { line: string; id: Id } | null = null;
  let initializeAnswered = false;
  let initialized: string | null = null;
  /**
   * Requests sent to the service, by the relay-private id they went under (decision 20): every request
   * toward the service, the client's and the relay's own, gets the next number, so no client id can
   * collide with another request's. The client's id comes back on the answer.
   */
  const sent = new Map<number, Sent>();
  /** The client's id of each sent request, to its relay id (a cancellation names the client's id). */
  const sentByClient = new Map<string, number>();
  let nextId = 0;
  /** Server-to-client requests by the id the client saw: which connection asked, and its own id. */
  const serverPending = new Map<string, { generation: number; id: Id }>();
  const serverIds = new Map<string, string>();
  let nextServerId = 0;
  /** The tool list the client last listed (a digest), to tell whether a replacement changed it. */
  let toolsDigest: string | null = null;
  /** Client lines waiting for a connection, or for the replayed handshake to finish. */
  let queue: Queued[] = [];
  let queuedBytes = 0;
  /** Set while a replacement answers the replayed initialize (its relay id): other client traffic waits. */
  let gate: number | null = null;
  let ended = false;
  let reconnecting: Promise<void> | null = null;
  /** Whether the reconnect loop may start the service: only once the client asked for something that needs it. */
  let startAllowed = false;
  let windowFrom = 0;
  /** The connection whose service announced its hand-over: what it left open was never run (O56). */
  let handedOver = 0;
  /** The connection that is going (it refused a call as not run, or announced its hand-over): nothing more is written to it. */
  let leaving = 0;
  /** Relay ids of calls the service refused as not run (`handover_not_run`): sent again to the next copy. */
  const notRun = new Set<number>();

  const writeService = (line: string): void => {
    const current = socket;
    if (current === null || current.destroyed) return;
    if (!current.write(`${line}\n`)) {
      // Backpressure: read no more from the client until the service has taken what was sent.
      options.input.pause();
      const resume = (): void => {
        current.off("drain", resume);
        current.off("close", resume);
        options.input.resume();
      };
      current.once("drain", resume);
      current.once("close", resume);
    }
  };

  /** Sends a request of the relay's own under the next relay id. */
  const ask = (kind: "replay" | "tools", message: object): number => {
    const id = ++nextId;
    sent.set(id, { kind, generation });
    writeService(JSON.stringify({ ...message, id }));
    return id;
  };

  const enqueue = (entry: Queued, front = false): void => {
    const bytes = Buffer.byteLength(entry.line);
    if (!front && (queue.length >= maxQueuedLines || queuedBytes + bytes > maxQueuedBytes)) {
      if (isRequest(entry.message))
        fail(
          entry.message.id,
          "Too many calls are waiting for Archer's service to come back; this one was not sent. Try it again in a moment.",
        );
      return;
    }
    if (front) queue.unshift(entry);
    else queue.push(entry);
    queuedBytes += bytes;
  };

  const flush = (): void => {
    const waiting = queue;
    queue = [];
    queuedBytes = 0;
    for (const entry of waiting) toService(entry);
  };

  /** Writes one client line to the current connection: requests under a relay id, stale answers dropped. */
  const send = (entry: Queued): void => {
    const message = entry.message;
    if (isRequest(message)) {
      const id = ++nextId;
      const params = message.params as { cursor?: unknown } | undefined;
      sent.set(id, {
        kind: "client",
        id: message.id,
        method: message.method,
        listsAll: params?.cursor === undefined,
        line: entry.line,
        generation,
      });
      sentByClient.set(key(message.id), id);
      writeService(JSON.stringify({ ...(message as object), id }));
      return;
    }
    if (isResponse(message) && entry.generation !== generation) {
      // An answer to a request of a connection that is gone (an old approval): never to the replacement.
      log("[archer] relay: dropped an answer to a request of an earlier service connection");
      return;
    }
    writeService(entry.line);
  };

  // ---- Service to client ----
  const fromService = (line: string, from: number): void => {
    if (from !== generation || line.trim() === "") return;
    const message = parse(line);
    // Every call this copy took is answered: what is still open was never run (lost() sends it on).
    if (message?.method === RELAY_HANDOVER_NOTICE && !hasId(message)) {
      handedOver = from;
      leaving = from;
      return;
    }
    if (isResponse(message)) {
      const request = typeof message.id === "number" ? sent.get(message.id) : undefined;
      // Not a request of this connection's that is still open (cancelled, or never the relay's): dropped.
      if (request === undefined || request.generation !== from) return;
      if (
        request.kind === "client" &&
        (message.error as { data?: { archer?: unknown } } | undefined)?.data?.archer === "handover_not_run"
      ) {
        // Not run, and this copy is going: the call waits for the next one, and so does everything after it.
        // A call it took may still be running (its drain has a deadline), so only the notice clears those.
        notRun.add(message.id as number);
        leaving = from;
        return;
      }
      sent.delete(message.id as number);
      if (request.kind !== "client") return ownAnswer(request.kind, message.id as number, message);
      sentByClient.delete(key(request.id));
      if (request.method === "initialize") initializeAnswered = true;
      if (request.method === "tools/list" && request.listsAll && message.error === undefined)
        toolsDigest = digest((message.result as { tools?: unknown } | undefined)?.tools);
      toClient({ ...(message as object), id: request.id });
      return;
    }
    if (isRequest(message)) {
      // The client sees an id of this connection's own; its answer is mapped back, or dropped if stale.
      const seen = `archer-relay-${generation}-${++nextServerId}`;
      serverPending.set(seen, { generation, id: message.id });
      serverIds.set(`${generation}:${key(message.id)}`, seen);
      toClient({ ...(message as object), id: seen });
      return;
    }
    if (message?.method === "notifications/cancelled") {
      const params = message.params as { requestId?: unknown } | undefined;
      const requestId = params?.requestId;
      const seen =
        typeof requestId === "string" || typeof requestId === "number"
          ? serverIds.get(`${generation}:${key(requestId)}`)
          : undefined;
      if (seen !== undefined) {
        forgetServer(seen);
        toClient({ ...(message as object), params: { ...params, requestId: seen } });
        return;
      }
    }
    options.write(`${line}\n`);
  };

  const forgetServer = (seen: string): void => {
    const entry = serverPending.get(seen);
    if (entry === undefined) return;
    serverPending.delete(seen);
    serverIds.delete(`${entry.generation}:${key(entry.id)}`);
  };

  /** Answers to the relay's own requests: the replayed initialize, and the tool-list check. */
  const ownAnswer = (kind: "replay" | "tools", id: number, message: Parsed): void => {
    if (kind === "replay") {
      if (id !== gate) return;
      gate = null;
      if (message.error !== undefined) log("[archer] relay: the replacement refused the replayed initialize");
      if (initialized !== null) writeService(initialized);
      if (toolsDigest !== null) ask("tools", { jsonrpc: "2.0", method: "tools/list" });
      flush();
      return;
    }
    const fresh =
      message.error === undefined ? digest((message.result as { tools?: unknown } | undefined)?.tools) : null;
    if (fresh === null || fresh !== toolsDigest) {
      toolsDigest = fresh;
      toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  };

  // ---- Client to service ----
  const toService = (entry: Queued): void => {
    if (socket !== null && !socket.destroyed && gate === null && leaving !== generation) {
      send(entry);
      return;
    }
    const message = entry.message;
    // The relay is alive, which is what a ping asks: answered here rather than kept for a service.
    if (isRequest(message) && message.method === "ping") {
      toClient({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    enqueue(entry);
    if (socket === null && isRequest(message)) {
      // Only a request that needs Archer lets the service be started (decision 20); any request dials.
      if (STARTING_METHODS.has(message.method) && !startAllowed) {
        startAllowed = true;
        windowFrom = now();
      }
      void reconnect();
    }
  };

  /** The client cancelled one of its requests: taken out of the queue, or the service told under its relay id. */
  const cancelled = (params: { requestId?: unknown } | undefined): void => {
    const requestId = params?.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const waiting = queue.findIndex((entry) => isRequest(entry.message) && key(entry.message.id) === key(requestId));
    if (waiting >= 0) {
      const [entry] = queue.splice(waiting, 1);
      queuedBytes -= Buffer.byteLength(entry!.line);
      if (initialize !== null && key(initialize.id) === key(requestId) && !initializeAnswered) initialize = null;
      return;
    }
    const id = sentByClient.get(key(requestId));
    if (id === undefined) return;
    sentByClient.delete(key(requestId));
    sent.delete(id);
    notRun.delete(id);
    writeService(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { ...params, requestId: id } }),
    );
  };

  const fromClient = (line: string): void => {
    if (line.trim() === "") return;
    const message = parse(line);
    if (isResponse(message)) {
      const seen = typeof message.id === "string" ? serverPending.get(message.id) : undefined;
      if (seen === undefined || seen.generation !== generation) {
        if (seen !== undefined) forgetServer(String(message.id));
        log("[archer] relay: dropped an answer to a request of an earlier service connection");
        return;
      }
      forgetServer(String(message.id));
      const answer = JSON.stringify({ ...(message as object), id: seen.id });
      toService({ line: answer, message: parse(answer), generation: seen.generation });
      return;
    }
    if (message?.method === "notifications/cancelled") {
      cancelled(message.params as { requestId?: unknown } | undefined);
      return;
    }
    if (isRequest(message) && message.method === "initialize") {
      initialize = { line, id: message.id };
      initializeAnswered = false;
    } else if (message?.method === "notifications/initialized") initialized = line;
    toService({ line, message, generation });
  };

  // ---- Connections ----
  const attach = (connected: RelaySocket): number => {
    const current = connected.socket;
    socket = current;
    const mine = ++generation;
    const reader = new LineReader(
      maxLine,
      (line) => fromService(line, mine),
      () => {
        log("[archer] relay: a line from the service is too long; dropping the connection");
        current.destroy();
      },
    );
    current.on("data", (chunk: Buffer | string) => {
      reader.push(chunk);
    });
    current.on("error", () => undefined);
    current.on("close", () => {
      if (socket !== current) return;
      socket = null;
      gate = null;
      if (ended) return;
      lost(mine);
      log(
        "[archer] relay: the service closed the connection; dialing its replacement (nothing is started until the next call)",
      );
      void reconnect();
    });
    const leftover = connected.leftover;
    if (leftover.length > 0) reader.push(leftover);
    return mine;
  };

  /**
   * What a closed connection leaves: the calls written to it are answered "outcome unknown" and
   * forgotten (never sent again); its requests to the client are cancelled. Lines still queued were
   * never sent, so they wait for the next connection. An initialize not yet answered, and a call the
   * service said it never ran (refused, or open at its hand-over notice), go back to the front of the
   * queue in the order they were sent: the replacement answers each as the client's own, exactly once.
   */
  const lost = (generationLost: number): void => {
    const requeue: Queued[] = [];
    for (const [id, request] of [...sent]) {
      if (request.generation !== generationLost) continue;
      sent.delete(id);
      if (request.kind !== "client") continue;
      sentByClient.delete(key(request.id));
      const neverRun = notRun.delete(id) || handedOver === generationLost;
      if (neverRun || (request.method === "initialize" && !initializeAnswered)) {
        requeue.push({ line: request.line, message: parse(request.line), generation });
        continue;
      }
      fail(request.id, OUTCOME_UNKNOWN);
    }
    for (const entry of requeue.reverse()) enqueue(entry, true);
    for (const [seen, entry] of [...serverPending]) {
      if (entry.generation !== generationLost) continue;
      forgetServer(seen);
      toClient({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: seen, reason: "Archer's service restarted; this request was withdrawn" },
      });
    }
  };

  /** The replacement has never seen this client: its handshake first (replayed if answered), then whatever waited. */
  const handshake = (): void => {
    if (initialize === null || !initializeAnswered) {
      flush();
      return;
    }
    gate = ask("replay", JSON.parse(initialize.line) as Record<string, unknown>);
  };

  /** No service came back: what waited is answered, and the queue emptied. */
  const giveUp = (answer: (message: Parsed & { id: Id; method: string }) => void): void => {
    for (const entry of queue) if (isRequest(entry.message)) answer(entry.message);
    queue = [];
    queuedBytes = 0;
  };

  const reconnect = (): Promise<void> => {
    reconnecting ??= (async () => {
      windowFrom = now();
      for (let delay = 100; ; delay = Math.min(delay * 2, 2000)) {
        if (ended || socket !== null) return;
        const start = startAllowed;
        try {
          const connected = await options.dial(start);
          if (ended) {
            connected.socket.destroy();
            return;
          }
          attach(connected);
          startAllowed = false;
          handshake();
          return;
        } catch (error) {
          if (now() - windowFrom > RECONNECT_WINDOW_MS) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!startAllowed) {
              log(`[archer] relay: no Archer service came back (${reason}); the next call starts it`);
              giveUp((message) => fail(message.id, NOT_RUNNING));
              return;
            }
            log(`[archer] relay: no Archer service answered: ${reason}`);
            // Requests that waited are answered; the next one tries again.
            giveUp((message) => fail(message.id, `Archer's service is not reachable: ${reason}`));
            startAllowed = false;
            return;
          }
          await sleep(delay);
        }
      }
    })().finally(() => {
      reconnecting = null;
    });
    return reconnecting;
  };

  attach(first);
  await new Promise<void>((resolve) => {
    const reader = new LineReader(maxLine, fromClient, () => {
      log("[archer] relay: a line from the client is too long");
      resolve();
    });
    options.input.on("data", (chunk: Buffer | string) => {
      reader.push(chunk);
    });
    options.input.once("end", () => resolve());
    options.input.once("close", () => resolve());
  });
  ended = true;
  // Let what the client sent last reach the service before the socket closes.
  const last = socket as Socket | null;
  if (last !== null) await new Promise<void>((resolve) => last.end(() => resolve()));
}

/** The relay's choice at launch: relay to the service, or why it falls back to the in-process server. */
export async function openRelay(
  dial: (start: boolean) => Promise<RelaySocket>,
  env: Env,
): Promise<{ relay: RelaySocket } | { fallback: string } | { refused: string }> {
  if (env["ARCHER_MCP_IN_PROCESS"] === "1") return { fallback: "ARCHER_MCP_IN_PROCESS=1" };
  try {
    return { relay: await dial(true) };
  } catch (error) {
    // An unsafe socket is not "unreachable": the in-process server would reach the same place (X-12).
    if (error instanceof UnsafeSocket) return { refused: error.message };
    return { fallback: error instanceof Error ? error.message : String(error) };
  }
}

/** This session as an agent: where it works, its host process, and the id it already has, if any. */
export function relayIdentity(env: Env, cwd: string, host = detectHost(env)): RelayIdentity {
  const root = hookProjectRoot(cwd);
  const known = recogniseAgent({ env, cwd, detected: host });
  return {
    root,
    cwd,
    host: host.host,
    label: agentLabel(host.host, cwd),
    ...(host.hostPid === undefined ? {} : { hostPid: host.hostPid }),
    ...(known === null ? {} : { agentId: known.agentId }),
    // The relay's first id goes in the session file, so `archer listen --claim` here claims as this
    // session. It never rewrites one that exists: that file is the CLI's claim (Claude 1), and a relay
    // refused its id goes on under its own without taking the listener's.
    remember: (agentId) => {
      if (!hasSessionFile(env, host)) rememberAgent(env, host, { agentId, root, cwd });
    },
  };
}

/**
 * `archer mcp`: relays this process's stdio to the service, or, when it refuses or cannot be reached at
 * launch, serves the old in-process MCP server (loaded only then). A socket that fails the management
 * admission ends it with exit code 1 instead: no relay, no fallback, nothing started. Returns the exit code.
 */
export async function runMcp(env: Env, cwd: string): Promise<number> {
  const host = detectHost(env);
  const launch: RelayLaunchFacts = { cwd, host: host.host, relayVersion: version() };
  const dial = serviceDial(env, launch, { identity: relayIdentity(env, cwd, host) });
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const opened = await openRelay(dial, env);
  if ("refused" in opened) {
    log(`[archer] mcp: refused: ${opened.refused}`);
    return 1;
  }
  if ("relay" in opened) {
    await relay(opened.relay, {
      launch,
      input: process.stdin,
      write: (text) => {
        process.stdout.write(text);
      },
      dial,
      log,
    });
    return 0;
  }
  log(`[archer] mcp: serving in this process, not through the service (${opened.fallback})`);
  const [{ runStdio }, { connectIfRunning, ensureService }] = await Promise.all([
    import("./index.ts"),
    import("../service/client.ts"),
  ]);
  await runStdio({
    cwd,
    version: version(),
    env,
    ensureService: () => ensureService({ env }),
    startService: () => ensureService({ env, autoStart: true }),
    findService: () => connectIfRunning({ env }),
  });
  return 0;
}
