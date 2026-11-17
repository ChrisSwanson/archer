// The management plane's wire (protocol.ts): newline-delimited JSON over a
// Unix socket, one request per line, one response per line, matched by id.
// The socket's directory permissions are the authorization.
import { isViewId } from "../model/index.ts";
import type { Socket } from "node:net";
import type { Method, Request, Response, Results, ServiceError } from "./protocol.ts";
import { activeTelemetry } from "../telemetry/index.ts";
import { AGENT_METHODS } from "../agents/contract.ts";
import { RELAY_HANDOVER_NOTICE, type RelayEndpoint, type RelayLaunch } from "../mcp/host-contract.ts";

/** A request line longer than this closes the connection. */
export const MAX_REQUEST_LINE_BYTES = 1024 * 1024;
/** A relayed MCP line (ADR 0035 §6) may carry a whole diagram source; the relay allows the same. */
export const MAX_RELAY_LINE_BYTES = 16 * 1024 * 1024;
/** Lines a relay may send before its `mcpRelay` answer is written: more, or more bytes, close the connection. */
export const MAX_HELD_LINES = 256;
export const MAX_HELD_BYTES = MAX_RELAY_LINE_BYTES;
/** Relayed lines queued for the MCP server beyond this many bytes pause reading from the relay. */
export const RELAY_QUEUE_BYTES = 2 * MAX_RELAY_LINE_BYTES;

/** What a handler may know about the connection a request came on. */
export interface ConnectionContext {
  /** Aborted when the connection closes: a held call (`waitMessage`) stops waiting for nobody. */
  readonly signal: AbortSignal;
  /**
   * Runs `callback` once this request's answer was written to the connection (`true`), or could not be
   * (`false`: the connection closed first, or the write failed). Delivery records messages as read only
   * on `true` (ADR 0035, review decision 3).
   */
  readonly afterWrite?: (callback: (written: boolean) => void) => void;
}

export type Handler = (request: Request, connection?: ConnectionContext) => Promise<Results[Method]>;

/**
 * Serves a connection that answered `mcpRelay` (ADR 0035 §6): from then on its lines are raw MCP JSON-RPC
 * both ways. Resolves when the relay is done; the connection is then ended.
 */
export type RelayServer = (endpoint: RelayEndpoint, launch: RelayLaunch) => Promise<void>;

export interface ServeOptions {
  /** Without it no connection becomes a relay: the handler refuses `mcpRelay` first. */
  readonly relay?: RelayServer;
}

/** A refusal to send back as `{ok: false, error}`. */
export class MethodError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "MethodError";
  }

  toWire(): ServiceError {
    return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

const METHODS: ReadonlySet<string> = new Set<string>([
  "hello",
  "attach",
  "detach",
  "listProjects",
  "restartConfiguration",
  "issueAccess",
  "issueAuthoringAccess",
  "listAccess",
  "revokeAccess",
  "issuePairingCode",
  "present",
  "setEmphasis",
  "listEmphases",
  "setSelection",
  "getContext",
  "getModel",
  "getProjectModel",
  "recordWrite",
  "stop",
  "handover",
  "pendingChanges",
  "listChanges",
  "readChange",
  "resolveChange",
  "readReview",
  "clearReview",
  ...AGENT_METHODS,
] satisfies readonly (Method | "pinListener")[]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a line is an `mcpRelay` request: its connection may become a relay, so later lines wait for its answer. */
function asksForRelay(line: string): boolean {
  if (!line.includes("mcpRelay")) return false;
  try {
    const value = JSON.parse(line) as unknown;
    return isObject(value) && value["method"] === "mcpRelay";
  } catch {
    return false;
  }
}

/** Checks a parsed line against the request shapes, or says what is wrong. */
export function parseRequest(value: unknown): Request {
  if (!isObject(value) || typeof value["id"] !== "number" || !Number.isInteger(value["id"]))
    throw new MethodError("invalid_request", "a request is a JSON object with an integer id, a method and params");
  const { method, params } = value;
  if (typeof method !== "string" || !METHODS.has(method))
    throw new MethodError(
      "unknown_method",
      `no method ${JSON.stringify(method)}; the methods are ${[...METHODS].join(", ")}`,
    );
  if (!isObject(params)) throw new MethodError("invalid_params", `${method} needs params as an object`);
  const str = (key: string, optional = false): void => {
    const v = params[key];
    if (optional && v === undefined) return;
    if (typeof v !== "string" || v === "")
      throw new MethodError("invalid_params", `${method} needs \`${key}\` as a non-empty string`);
  };
  if (method === "getContext" || method === "getModel" || method === "getProjectModel") {
    const allowed = method === "getModel" ? ["root", "viewId"] : ["root"];
    if (
      Object.keys(value).some((k) => !["id", "method", "params"].includes(k)) ||
      Object.keys(params).some((k) => !allowed.includes(k))
    )
      throw new MethodError("invalid_params", `${method} has unknown fields`);
  }
  switch (method) {
    case "readReview":
    case "clearReview": {
      str("root");
      const allowed =
        method === "readReview"
          ? ["root", "reviewId", "part"]
          : ["root", "reviewId", "expectedReviewRevision", "summary"];
      if (
        Object.keys(value).some((key) => !["id", "method", "params"].includes(key)) ||
        Object.keys(params).some((key) => !allowed.includes(key)) ||
        Buffer.byteLength(String(params.root)) > 4096 ||
        /[\0-\x1f\x7f]/u.test(String(params.root)) ||
        typeof params.reviewId !== "string" ||
        !/^rev_[a-f0-9]{32}$/u.test(params.reviewId)
      )
        throw new MethodError("invalid_params", "invalid cumulative review identity");
      if (
        method === "readReview" &&
        params.part !== undefined &&
        !["baseline", "latest", "diff"].includes(params.part as string)
      )
        throw new MethodError("invalid_params", "invalid cumulative review part");
      if (
        method === "clearReview" &&
        (!Number.isSafeInteger(params.expectedReviewRevision) ||
          Number(params.expectedReviewRevision) < 1 ||
          typeof params.summary !== "string" ||
          !params.summary.trim() ||
          Buffer.byteLength(params.summary) > 2048 ||
          Buffer.from(params.summary).toString("utf8") !== params.summary)
      )
        throw new MethodError("invalid_params", "clearReview requires a revision and a bounded understanding summary");
      break;
    }
    case "pendingChanges":
    case "listChanges":
    case "readChange":
    case "resolveChange": {
      str("root");
      const allowed =
        method === "pendingChanges"
          ? ["root", "limit"]
          : method === "listChanges"
            ? ["root", "limit", "cursor", "reviewCursor"]
            : method === "readChange"
              ? ["root", "changeId", "part"]
              : ["root", "changeId", "expectedReviewRevision", "disposition"];
      if (
        Object.keys(value).some((key) => !["id", "method", "params"].includes(key)) ||
        Object.keys(params).some((key) => !allowed.includes(key)) ||
        Buffer.byteLength(String(params.root)) > 4096 ||
        /[\0-\x1f\x7f]/u.test(String(params.root))
      )
        throw new MethodError("invalid_params", `${method} contains unexpected or oversized fields`);
      if (method === "pendingChanges" || method === "listChanges") {
        if (
          params.limit !== undefined &&
          (!Number.isSafeInteger(params.limit) ||
            Number(params.limit) < 1 ||
            Number(params.limit) > (method === "pendingChanges" ? 3 : 20))
        )
          throw new MethodError("invalid_params", `${method} limit is outside its bound`);
        if (
          params.reviewCursor !== undefined &&
          (typeof params.reviewCursor !== "string" ||
            params.reviewCursor.length < 1 ||
            params.reviewCursor.length > 8192 ||
            !/^[A-Za-z0-9_-]+$/u.test(params.reviewCursor))
        )
          throw new MethodError("invalid_params", "review cursor must be bounded base64url text");
        if (
          params.cursor !== undefined &&
          (typeof params.cursor !== "string" ||
            params.cursor.length < 1 ||
            params.cursor.length > 8192 ||
            !/^[A-Za-z0-9_-]+$/u.test(params.cursor))
        )
          throw new MethodError("invalid_params", "change cursor must be bounded base64url text");
      } else {
        if (typeof params.changeId !== "string" || !/^chg_[0-9a-f]{32}$/u.test(params.changeId))
          throw new MethodError("invalid_params", `${method} requires a changeId`);
        if (method === "readChange" && params.part !== undefined && params.part !== "before" && params.part !== "after")
          throw new MethodError("invalid_params", "readChange part must be before or after");
        if (
          method === "resolveChange" &&
          (!Number.isSafeInteger(params.expectedReviewRevision) ||
            Number(params.expectedReviewRevision) < 1 ||
            (params.disposition !== "handled" && params.disposition !== "declined"))
        )
          throw new MethodError(
            "invalid_params",
            "resolveChange requires a positive expectedReviewRevision and handled or declined disposition",
          );
      }
      break;
    }
    case "issueAuthoringAccess":
      str("label");
      if (
        Object.keys(value).some((key) => !["id", "method", "params"].includes(key)) ||
        Object.keys(params).some((key) => !["label", "projectRoots"].includes(key)) ||
        String(params["label"]).length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(String(params["label"])) ||
        !Array.isArray(params["projectRoots"]) ||
        params["projectRoots"].length < 1 ||
        params["projectRoots"].length > 16 ||
        !params["projectRoots"].every(
          (root) =>
            typeof root === "string" && root.length > 0 && root.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(root),
        )
      )
        throw new MethodError(
          "invalid_params",
          "issueAuthoringAccess needs only a label of 1–128 characters and 1–16 project roots without controls",
        );
      break;
    case "issueAccess":
      str("label");
      if (
        Object.keys(params).some((k) => k !== "label") ||
        String(params["label"]).length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(String(params["label"]))
      )
        throw new MethodError("invalid_params", "issueAccess needs only a label of 1–128 characters without controls");
      break;
    case "revokeAccess":
      str("grantId");
      if (Object.keys(params).some((k) => k !== "grantId") || !/^[a-f0-9-]{36}$/.test(String(params["grantId"])))
        throw new MethodError("invalid_params", "revokeAccess needs only a grantId returned by listAccess");
      break;
    case "listAccess":
    case "issuePairingCode":
    case "handover":
    case "restartConfiguration":
      if (Object.keys(params).length !== 0) throw new MethodError("invalid_params", `${method} takes no parameters`);
      break;
    case "hello":
      if (typeof params["protocolVersion"] !== "number")
        throw new MethodError("invalid_params", "hello needs `protocolVersion` as a number");
      break;
    case "attach":
    case "detach":
    case "getContext":
      str("root");
      break;
    case "setSelection":
      str("root");
      if (!isObject(params["selection"]) || Object.keys(params).some((key) => !["root", "selection"].includes(key)))
        throw new MethodError("invalid_params", "setSelection needs only root and a selection object");
      break;
    case "getModel":
      str("root");
      str("viewId");
      if (!isViewId(params["viewId"] as string)) throw new MethodError("invalid_params", "getModel needs a view id");
      break;
    case "present":
      if (params["openBrowser"] !== undefined && typeof params["openBrowser"] !== "boolean")
        throw new MethodError("invalid_params", "openBrowser must be boolean");
      str("root");
      str("viewId");
      if (params["annotation"] !== undefined && typeof params["annotation"] !== "string")
        throw new MethodError("invalid_params", "present takes `annotation` as a string");
      if (params["emphases"] !== undefined && !Array.isArray(params["emphases"]))
        throw new MethodError("invalid_params", "present takes `emphases` as a list of set_emphasis payloads");
      if (params["walkthrough"] !== undefined) {
        const w = params["walkthrough"] as Record<string, unknown> | null;
        if (
          typeof w !== "object" ||
          w === null ||
          typeof w["id"] !== "string" ||
          !Number.isSafeInteger(w["step"]) ||
          (w["step"] as number) < 1
        )
          throw new MethodError("invalid_params", "present takes `walkthrough` as {id, step}");
      }
      if (params["expand"] !== undefined) {
        const e = params["expand"];
        const entry = (x: unknown): boolean => {
          const r = x as Record<string, unknown> | null;
          return (
            typeof r === "object" &&
            r !== null &&
            typeof r["element"] === "string" &&
            typeof r["source"] === "string" &&
            (r["neighbour"] === undefined || typeof r["neighbour"] === "string")
          );
        };
        if (!Array.isArray(e) || !e.every(entry))
          throw new MethodError("invalid_params", "present takes `expand` as a list of {element, source, neighbour?}");
      }
      break;
    case "setEmphasis":
      str("root");
      str("viewId");
      if (!Array.isArray(params["emphases"]))
        throw new MethodError("invalid_params", "setEmphasis needs `emphases` as a list of set_emphasis payloads");
      break;
    case "listEmphases":
      str("root");
      str("viewId", true);
      break;
    case "recordWrite":
      str("root");
      str("viewId");
      if (params["summary"] !== undefined && typeof params["summary"] !== "string")
        throw new MethodError("invalid_params", "recordWrite takes `summary` as a string");
      break;
    case "registerAgent":
      str("root");
      str("cwd");
      str("label");
      str("host");
      break;
    case "claimListener":
      str("root");
      str("agentId");
      break;
    case "heartbeat":
      str("agentId");
      str("via");
      break;
    case "waitMessage":
      str("root");
      str("agentId");
      if (!Number.isSafeInteger(params["timeoutMs"]) || Number(params["timeoutMs"]) < 0)
        throw new MethodError("invalid_params", "waitMessage needs `timeoutMs` as a non-negative integer");
      break;
    case "inbox":
      str("root");
      str("agentId", true);
      break;
    case "reportActivity": {
      str("root");
      str("agentId");
      const fetched = params["fetched"],
        answered = params["answered"];
      const threadId = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(v);
      if (
        Object.keys(params).some((key) => !["root", "agentId", "fetched", "answered"].includes(key)) ||
        (fetched !== undefined &&
          (!Array.isArray(fetched) ||
            fetched.length > 1000 ||
            !fetched.every(
              (entry) => isObject(entry) && threadId(entry["threadId"]) && Number.isSafeInteger(entry["revision"]),
            ))) ||
        (answered !== undefined && (!Array.isArray(answered) || answered.length > 1000 || !answered.every(threadId)))
      )
        throw new MethodError(
          "invalid_params",
          "reportActivity takes root, agentId, and optional fetched [{threadId, revision}] and answered [threadId]",
        );
      break;
    }
    case "listListeners":
      str("root");
      break;
    case "mcpRelay":
      str("cwd");
      str("host");
      str("relayVersion");
      if (
        params["agentId"] !== undefined &&
        (typeof params["agentId"] !== "string" || !/^ag-[0-9a-f]{12}$/u.test(params["agentId"]))
      )
        throw new MethodError(
          "invalid_params",
          "mcpRelay's agentId is one registerAgent returned: ag- and 12 hex digits",
        );
      break;
    default:
      break;
  }
  return value as unknown as Request;
}

/** What the service may ask of a connection it serves. */
export interface ConnectionControl {
  /**
   * For a hand-over (review decision 8): a relay connection stops taking new MCP requests (each is answered
   * at once with a JSON-RPC error whose `data.archer` is `handover_not_run`: it was not run, so calling it
   * again on the replacement is safe), keeps passing everything else, and resolves once every request it
   * already took has been answered, or at `deadlineMs`. Resolves at once on a connection that is no relay.
   * When everything it took was answered it writes RELAY_HANDOVER_NOTICE: a call still open at the relay
   * was never run, so the relay sends it to the replacement (O56). Not at the deadline: one may be running.
   */
  drainRelay(deadlineMs: number, reason?: "handover" | "stop"): Promise<void>;
  /** Whether this is a relay connection with MCP requests taken and not yet answered. */
  relayBusy(): boolean;
}

/** The request a `notifications/cancelled` names, as a key: the MCP SDK never answers a cancelled request. */
function cancelledId(line: string): string | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (
      !isObject(value) ||
      value["method"] !== "notifications/cancelled" ||
      value["id"] !== undefined ||
      !isObject(value["params"])
    )
      return null;
    const id = value["params"]["requestId"];
    return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;
  } catch {
    return null;
  }
}

/** The id of a JSON-RPC request (it has a method and an id) or of a response (an id, no method), as a key. */
function rpcId(line: string): { readonly request: boolean; readonly key: string } | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isObject(value) || (typeof value["id"] !== "string" && typeof value["id"] !== "number")) return null;
    return { request: typeof value["method"] === "string", key: JSON.stringify(value["id"]) };
  } catch {
    return null;
  }
}

/** Serves one connection until it closes. */
export function serveConnection(
  socket: Socket,
  handle: Handler,
  log: (line: string) => void,
  options: ServeOptions = {},
): ConnectionControl {
  let buffer = "";
  /** Bytes of `buffer`, the unfinished line, kept as chunks arrive (see the data handler). */
  let bufferBytes = 0;
  socket.setEncoding("utf8");
  const closed = new AbortController();
  /** Set once the connection is a relay: every later line is the relay's. */
  let relay: { push(line: string, bytes: number): void; end(): void } | null = null;
  /** The relay's requests the MCP server took and has not answered, by id; and the drain under way. */
  const inFlight = new Set<string>();
  let draining: (() => void) | null = null;
  let drainingNow: false | "handover" | "stop" = false;
  /** The agents `registerAgent` returned on this connection: the only ids an `mcpRelay` may name (round 2, Claude 14). */
  const registered = new Set<string>();
  /** Lines that arrived while an `mcpRelay` request was being answered: the relay's, or requests again on a refusal. */
  let held: string[] | null = null;
  const reply = (response: Response, written?: (ok: boolean) => void): void => {
    if (socket.destroyed || socket.writableEnded) {
      written?.(false);
      return;
    }
    socket.write(`${JSON.stringify(response)}\n`, (error) => written?.(error == null));
  };
  socket.on("close", () => {
    closed.abort();
    relay?.end();
  });
  /** Set once a line was too large: the connection is ending and nothing more is read. */
  let refused = false;
  let heldBytes = 0;
  const lineLimit = (): number => (relay === null && held === null ? MAX_REQUEST_LINE_BYTES : MAX_RELAY_LINE_BYTES);
  const tooLarge = (): void => {
    // A relay speaks JSON-RPC, not this protocol: it is closed without an Archer reply.
    if (relay === null && held === null)
      reply({
        id: 0,
        ok: false,
        error: { code: "request_too_large", message: `a request line is at most ${MAX_REQUEST_LINE_BYTES} bytes` },
      });
    refused = true;
    buffer = "";
    bufferBytes = 0;
    socket.end();
  };
  // Only the new chunk is scanned: a newline can only be in it, and the unfinished line's size is a
  // running total. Re-scanning the whole buffer on every chunk was quadratic in a line's length: a 16 MiB
  // relay line in macOS's ~8 KiB Unix-socket reads took ~15 s of event loop.
  socket.on("data", (chunk: string) => {
    if (refused) return;
    const from = buffer.length;
    buffer += chunk;
    if (!chunk.includes("\n")) {
      bufferBytes += Buffer.byteLength(chunk);
      if (bufferBytes > lineLimit()) tooLarge();
      return;
    }
    for (let end = buffer.indexOf("\n", from); end >= 0; end = buffer.indexOf("\n")) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      // Every complete line is measured in bytes before it is used (review 0.7.0 C5).
      const bytes = Buffer.byteLength(raw);
      if (bytes > lineLimit()) return tooLarge();
      if (relay !== null) {
        if (raw.trim() !== "") relay.push(raw.trim(), bytes);
        continue;
      }
      const line = raw.trim();
      if (line === "") continue;
      if (held !== null) {
        heldBytes += bytes;
        if (held.length >= MAX_HELD_LINES || heldBytes > MAX_HELD_BYTES) {
          refused = true;
          buffer = "";
          socket.destroy();
          return;
        }
        held.push(line);
        continue;
      }
      if (asksForRelay(line)) {
        held = [];
        heldBytes = 0;
        void upgrade(line);
        continue;
      }
      void answer(line);
    }
    // What is left follows the chunk's last newline, so it is part of this chunk: measuring it is cheap.
    bufferBytes = Buffer.byteLength(buffer);
    if (bufferBytes > lineLimit()) tooLarge();
  });
  socket.on("error", () => socket.destroy());

  /** Answers `mcpRelay`; on success the connection is handed to the relay server with the lines held meanwhile. */
  async function upgrade(line: string): Promise<void> {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const id = typeof parsed["id"] === "number" ? parsed["id"] : 0;
    const refused = await answerParsed(id, parsed, options.relay === undefined);
    const waiting = held ?? [];
    held = null;
    if (refused !== null || options.relay === undefined || socket.destroyed) {
      for (const next of waiting) void answer(next);
      return;
    }
    const lines: string[] = [];
    // Lines the relay sent before the answer, taken as if they arrived now.
    for (const next of waiting) {
      const id = rpcId(next);
      if (id?.request === true) inFlight.add(id.key);
      else settleCancelled(next);
      lines.push(next);
    }
    // Lines the relay server has not taken yet: past RELAY_QUEUE_BYTES the socket is paused until it catches up.
    let queued = heldBytes;
    let paused = false;
    let wake: (() => void) | null = null;
    let ended = false;
    relay = {
      push: (next, bytes) => {
        const id = rpcId(next);
        if (id?.request === true) {
          if (drainingNow) {
            const refusal = {
              jsonrpc: "2.0",
              id: JSON.parse(id.key) as unknown,
              error: {
                code: -32000,
                message:
                  drainingNow === "stop"
                    ? "Archer is stopping; this call was not run. Call it again."
                    : "Archer is handing over to a new version; this call was not run. Call it again.",
                data: { archer: "handover_not_run" },
              },
            };
            if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(refusal)}\n`);
            return;
          }
          inFlight.add(id.key);
        } else settleCancelled(next);
        lines.push(next);
        queued += bytes;
        if (!paused && queued > RELAY_QUEUE_BYTES) {
          paused = true;
          socket.pause();
        }
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    const incoming: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = lines.shift();
          if (next !== undefined) {
            queued = Math.max(0, queued - Buffer.byteLength(next));
            if (paused && queued <= RELAY_QUEUE_BYTES / 2) {
              paused = false;
              socket.resume();
            }
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise<void>((done) => {
            wake = () => {
              wake = null;
              done();
            };
          });
        }
      },
    };
    const endpoint: RelayEndpoint = {
      incoming,
      send: (out) => {
        // The answer is written before the drain may end: the hand-over notice must follow it (O56).
        const answered = inFlight.size > 0 ? rpcId(out) : null;
        if (!socket.destroyed && !socket.writableEnded) socket.write(`${out.replace(/\r?\n/g, " ")}\n`);
        if (answered !== null && !answered.request && inFlight.delete(answered.key) && inFlight.size === 0)
          draining?.();
      },
    };
    const params = parsed["params"] as RelayLaunch;
    // The relay speaks as an agent only under an id it registered on this connection; any other is ignored.
    const agentId = params.agentId !== undefined && registered.has(params.agentId) ? params.agentId : undefined;
    if (params.agentId !== undefined && agentId === undefined)
      log(
        `[archer] service: an MCP relay named agent ${params.agentId}, not registered on its connection; it relays without an agent`,
      );
    try {
      await options.relay(
        { incoming, send: endpoint.send },
        {
          cwd: params.cwd,
          host: params.host,
          relayVersion: params.relayVersion,
          ...(agentId === undefined ? {} : { agentId }),
        },
      );
    } catch (failure) {
      log(`[archer] service: MCP relay ended: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      if (!socket.destroyed) socket.end();
    }
  }

  /** A cancelled call counts as finished for the hand-over's drain (round 2, decision 20). */
  function settleCancelled(line: string): void {
    if (inFlight.size === 0) return;
    const key = cancelledId(line);
    if (key !== null && inFlight.delete(key) && inFlight.size === 0) draining?.();
  }

  async function answer(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return reply({ id: 0, ok: false, error: { code: "invalid_request", message: "a request is one line of JSON" } });
    }
    const id = isObject(parsed) && typeof parsed["id"] === "number" ? parsed["id"] : 0;
    const telemetry = activeTelemetry();
    if (telemetry === null) {
      await answerParsed(id, parsed);
      return;
    }
    // Development telemetry: per-method count, latency and outcome code.
    const started = performance.now();
    const method =
      isObject(parsed) && typeof parsed["method"] === "string" && METHODS.has(parsed["method"])
        ? parsed["method"]
        : "invalid";
    const code = await answerParsed(id, parsed);
    telemetry.management(method, performance.now() - started, code);
  }

  /** Answers one parsed line; resolves to the refusal code, or null on success. */
  async function answerParsed(id: number, parsed: unknown, noRelay = false): Promise<string | null> {
    const afterWrites: ((written: boolean) => void)[] = [];
    const context: ConnectionContext = {
      signal: closed.signal,
      afterWrite: (callback) => {
        afterWrites.push(callback);
      },
    };
    const settle = (written: boolean): void => {
      for (const callback of afterWrites.splice(0)) {
        try {
          callback(written);
        } catch (failure) {
          log(
            `[archer] service: after-write step failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
      }
    };
    try {
      const request = parseRequest(parsed);
      if (noRelay && request.method === "mcpRelay")
        throw new MethodError(
          "mcp_unavailable",
          "this service does not serve MCP over its socket; run the MCP server the session was set up with",
        );
      const result = await handle(request, context);
      if (request.method === "registerAgent") {
        const agentId = (result as { agentId?: unknown }).agentId;
        if (typeof agentId === "string") registered.add(agentId);
      }
      reply({ id, ok: true, result }, settle);
      return null;
    } catch (error) {
      settle(false);
      if (error instanceof MethodError) {
        reply({ id, ok: false, error: error.toWire() });
        return error.code;
      }
      const code = (error as { code?: unknown }).code;
      const details = (error as { details?: unknown }).details;
      if (typeof code === "string" && error instanceof Error) {
        reply({ id, ok: false, error: { code, message: error.message, ...(isObject(details) ? { details } : {}) } });
        return code;
      }
      log(`[archer] service: ${String(error instanceof Error ? (error.stack ?? error.message) : error)}`);
      reply({
        id,
        ok: false,
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
      });
      return "internal";
    }
  }

  return {
    relayBusy: () => relay !== null && !socket.destroyed && inFlight.size > 0,
    drainRelay: (deadlineMs, reason = "handover") =>
      new Promise<void>((done) => {
        if (relay === null || socket.destroyed) return done();
        drainingNow = reason;
        const timer = setTimeout(finish, deadlineMs);
        function finish(): void {
          clearTimeout(timer);
          if (draining === null) return;
          draining = null;
          if (inFlight.size === 0 && !socket.destroyed && !socket.writableEnded)
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: RELAY_HANDOVER_NOTICE })}\n`);
          done();
        }
        draining = finish;
        socket.once("close", finish);
        if (inFlight.size === 0) finish();
      }),
  };
}
