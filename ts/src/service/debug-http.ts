// The development-only HTTP surface (ARCHER_DEBUG=1, docs/devkit/CONTRACT.md):
// request ids, Server-Timing and per-route metrics on every response, and the
// `/-/debug/*` routes. Built only for a debug service; without it the routes
// fall through to the data plane, which answers its ordinary bare 404.
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { API_ROUTES } from "../../../shared/api-routes.mts";
import { TOKEN_PATTERN, tokenMatches } from "./token.ts";
import { cookieCredential, type BrowserAuthority } from "./browser-access.ts";
import { isLoopback, readBody, sameOrigin } from "./http.ts";
import { isLevel, requestContext, RequestTiming, THRESHOLDS, type Level, type Telemetry } from "../telemetry/index.ts";

export const DEBUG_PREFIX = "/-/debug/";
export const MAX_CLIENT_BATCH_BYTES = 64 * 1024;
export const MAX_CLIENT_EVENTS = 200;
export const MAX_LOG_LIMIT = 1_000;
export const DEFAULT_LOG_LIMIT = 200;
export const MAX_PROFILE_SECONDS = 60;
/** A heap snapshot larger than this is refused (`heap_snapshot_too_large`) rather than delivered. */
export const MAX_HEAP_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export interface DebugProject {
  readonly slug: string;
  readonly root: string;
  readonly loaded: boolean;
  /** Directories the project's watcher currently has open; 0 when it watches nothing. */
  readonly watcher: number;
}

export interface DebugHttpOptions {
  readonly telemetry: Telemetry;
  readonly version: string;
  readonly authority: () => BrowserAuthority | undefined;
  readonly projects: () => readonly DebugProject[];
  readonly streams: () => number;
  /** `ARCHER_DEBUG_PROFILING=1`: CPU profiles and heap snapshots exist at all (still loopback + owner only). */
  readonly profiling?: boolean;
  /** Takes a heap snapshot, passing each chunk on; the inspector's by default (tests substitute one). */
  readonly takeHeapSnapshot?: (chunk: (text: string) => void) => Promise<void>;
  readonly maxHeapSnapshotBytes?: number;
}

/**
 * Who may use a debug route. `public`: loopback or any valid grant (secret-free health). `page`: any
 * valid grant (the page's own telemetry upload). `owner`: the service token only (metrics, logs, events
 * and reset, which hold or erase evidence: metrics are keyed by route, D-1). `profiling`: the service
 * token from a loopback peer with `ARCHER_DEBUG_PROFILING=1` (CPU profiles, and heap snapshots, which
 * hold every secret the process has).
 */
export type DebugAccess = "public" | "page" | "owner" | "profiling";

export function debugAccess(method: string, name: string): DebugAccess {
  if (method === "GET" && name === "health") return "public";
  if (method === "POST" && name === "events") return "page";
  if (method === "POST" && (name === "profile/cpu" || name === "heap-snapshot")) return "profiling";
  return "owner";
}

export type Dispatch = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The API names the service serves (`.../api/<name>`, shared/api-routes.mts): only these are kept in a route key.
 * Anything else, which may be a credential typed in the wrong slot, is `:other` (C-06/X-03).
 */
export const API_NAMES: ReadonlySet<string> = new Set(API_ROUTES.map((spec) => spec.name));
/** The literal segments some route has after its name (`comments/<id>/replies`); any other segment is `:id`. */
const LITERAL_SEGMENTS: ReadonlySet<string> = new Set(
  API_ROUTES.flatMap((spec) => spec.path.slice(2).filter((segment) => !segment.startsWith(":"))),
);
/** The debug route names `#route` serves. */
const DEBUG_NAMES: ReadonlySet<string> = new Set([
  "health",
  "metrics",
  "log",
  "events",
  "reset",
  "profile/cpu",
  "heap-snapshot",
]);
const TOKEN_SEGMENT = TOKEN_PATTERN;
const apiName = (name: string | undefined): string => (name !== undefined && API_NAMES.has(name) ? name : ":other");

/**
 * A metrics key for a path: ids, names and tokens become placeholders, so the key set stays small and
 * holds nothing a caller chose. Only literal names the service serves are spelled; never a slice of a
 * segment (a 24-character prefix is 96 bits of a token).
 */
export function routePattern(pathname: string): string {
  const parts = pathname.split("/").slice(1);
  const out: string[] = [];
  if (TOKEN_SEGMENT.test(parts[0] ?? "")) {
    out.push(":token");
    parts.shift();
  }
  const [head, second] = parts;
  if (head === "-" && second === "debug") {
    const name = parts.slice(2).join("/");
    return `/-/debug/${DEBUG_NAMES.has(name) ? name : ":other"}`;
  }
  if (head === "projects")
    return `${out.length ? "/:token" : ""}/projects/${parts.length > 1 && second !== "" ? ":project/*" : ""}`;
  if (head === "p" && parts.length >= 2) {
    out.push("p", ":project");
    const rest = parts.slice(2);
    if (rest[0] !== "api") return `/${[...out, ...(rest.length ? ["*"] : [])].join("/")}`;
    out.push("api", apiName(rest[1]));
    for (const segment of rest.slice(2, 5)) out.push(LITERAL_SEGMENTS.has(segment) ? segment : ":id");
    return `/${out.join("/")}`;
  }
  if (head === "api") return `/${[...out, "api", apiName(second)].join("/")}`;
  if (head === "" || head === undefined) return `/${out.join("/")}${out.length ? "/" : ""}`;
  return `/${[...out, ":other"].join("/")}`;
}

/** The request target as FNV-1a and its length: repeats of one address match, and nothing sent is kept. */
function targetDigest(target: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < target.length; i++) hash = Math.imul(hash ^ target.charCodeAt(i), 0x01000193);
  return `${(hash >>> 0).toString(36)}.${target.length}`;
}

const ACTION = /^[A-Za-z0-9._:-]{1,64}$/;

/** A debug page names its page load on each request (ui/src/telemetry/runtime.ts). */
const PAGE_LOAD = /^[a-f0-9]{8}-[a-f0-9]{8}$/;

export class DebugHttp {
  readonly #options: DebugHttpOptions;
  readonly #prefix = randomBytes(3).toString("hex");
  #counter = 0;
  #profiling = false;

  constructor(options: DebugHttpOptions) {
    this.#options = options;
  }

  /** Serves one request with timing headers and metrics, routing `/-/debug/*` here. */
  handle(req: IncomingMessage, res: ServerResponse, dispatch: Dispatch): void {
    const telemetry = this.#options.telemetry;
    const action =
      typeof req.headers["x-archer-client-action"] === "string" && ACTION.test(req.headers["x-archer-client-action"])
        ? req.headers["x-archer-client-action"]
        : undefined;
    const timing = new RequestTiming(
      `${this.#prefix}-${(++this.#counter).toString(36)}`,
      req.socket.remoteAddress,
      action,
    );
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?", 1)[0] ?? "/";
    const debugRoute = pathname.startsWith(DEBUG_PREFIX);
    let status = 0,
      bytes = 0,
      streaming = false,
      recorded = false;
    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      if (!this.headersSent) {
        status = args[0] as number;
        const headers = typeof args[1] === "string" ? args[2] : args[1];
        const type = headerOf(headers, "content-type") ?? this.getHeader("content-type");
        streaming = typeof type === "string" && type.startsWith("text/event-stream");
        this.setHeader("x-archer-request-id", timing.id);
        this.setHeader("server-timing", timing.serverTiming());
      }
      return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
    } as ServerResponse["writeHead"];
    const write = res.write,
      end = res.end;
    res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      bytes += sizeOf(chunk);
      return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    } as ServerResponse["write"];
    res.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
      if (typeof chunk !== "function") bytes += sizeOf(chunk);
      return (end as (...a: unknown[]) => ServerResponse).call(this, chunk, ...rest);
    } as ServerResponse["end"];
    // A write's body, as the handler reads it, tells distinct edits to one endpoint apart (svc.duplicate-request).
    // Observing `emit` sees every chunk a reader consumes without adding a reader, so flow is untouched.
    // FNV-1a over the bytes read so far (the body may still be arriving, or never read, when the answer ends).
    let body: { hash: number; length: number } | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const seen = (body = { hash: 0x811c9dc5, length: 0 });
      const emit = req.emit;
      req.emit = function (this: IncomingMessage, event: string | symbol, ...args: unknown[]) {
        const chunk = args[0];
        if (event === "data" && chunk instanceof Uint8Array) {
          for (const byte of chunk) seen.hash = Math.imul(seen.hash ^ byte, 0x01000193);
          seen.length += chunk.length;
        }
        return (emit as (...a: unknown[]) => boolean).call(this, event, ...args);
      } as IncomingMessage["emit"];
    }
    const pageLoad = req.headers["x-archer-page-load"];
    const page = typeof pageLoad === "string" && PAGE_LOAD.test(pageLoad) ? pageLoad : undefined;
    const record = (): void => {
      if (recorded) return;
      recorded = true;
      telemetry.request(
        {
          requestId: timing.id,
          method: req.method ?? "GET",
          route: routePattern(pathname),
          target: targetDigest(rawUrl),
          status: status || res.statusCode,
          ms: timing.elapsed(),
          bytes,
          client: timing.client,
          streaming,
          ...(timing.action === undefined ? {} : { action: timing.action }),
          phases: timing.phases(),
          ...(body === undefined ? {} : { bodyHash: `${(body.hash >>> 0).toString(36)}.${body.length}` }),
          ...(page === undefined ? {} : { page }),
        },
        debugRoute,
      );
    };
    res.once("finish", record);
    res.once("close", record);
    requestContext.run(timing, () => {
      if (!debugRoute) return dispatch(req, res);
      const admitted = this.#admitted(req, pathname.slice(DEBUG_PREFIX.length));
      if (admitted === null) return void dispatch(req, res);
      void this.#route(req, res, pathname, new URL(rawUrl, "http://archer.invalid").searchParams, admitted).catch(
        (failure) => {
          telemetry.log(
            "error",
            "svc.debug-route",
            `debug route failed: ${failure instanceof Error ? failure.message : String(failure)}`,
            { requestId: timing.id },
          );
          if (!res.headersSent)
            send(res, 500, { error: { code: "internal", message: "the debug route failed; see /-/debug/log" } });
          else res.destroy();
        },
      );
    });
  }

  /**
   * On an authority the service serves (never when that is unknown), by `debugAccess`: loopback peers
   * may read health and metrics; any valid grant may also post the page's events; everything else —
   * logs, client events, reset, CPU profiles and heap snapshots — needs the service's own token, as
   * the cookie or a bearer token, and profiles and snapshots also a loopback peer and the opt-in.
   * Every write with a cookie needs the exact Origin and a JSON body; a cross-site Fetch Metadata
   * value refuses any write. Admitted, it says whether the caller is the owner (the service token, as
   * the owner's session cookie or a bearer token); refused, null.
   */
  #admitted(req: IncomingMessage, name: string): Admission | null {
    const telemetry = this.#options.telemetry;
    const authority = this.#options.authority();
    if (authority === undefined) return refuse(telemetry, "authority_unknown");
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !authority.allowedHosts.has(host)) return refuse(telemetry, "host_not_allowed");
    const write = req.method !== "GET" && req.method !== "HEAD";
    // Browser writes carry their Origin; a cross-origin page may not post into the log.
    if (write && req.headers.origin !== undefined && !sameOrigin(req.headers)) return refuse(telemetry, "cross_origin");
    const site = req.headers["sec-fetch-site"];
    if (write && site !== undefined && site !== "same-origin" && site !== "none")
      return refuse(telemetry, "cross_site");
    const access = debugAccess(req.method ?? "GET", name);
    const loopback = isLoopback(req.socket.remoteAddress);
    if (access === "public" && loopback) return { owner: false };
    if (access === "profiling" && this.#options.profiling !== true) return refuse(telemetry, "profiling_off");
    if (access === "profiling" && !loopback) return refuse(telemetry, "not_loopback");
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const values = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${authority.cookieName}=`));
    if (bearer === undefined && values.length !== 1)
      return refuse(telemetry, values.length === 0 ? "credential_missing" : "cookie_ambiguous");
    // A cookie write is a browser's: the exact Origin and a JSON body, as browser-access.ts asks of the
    // data plane (G2). Only a Bearer caller, which no page can make send a cookie for it, may omit them.
    if (
      write &&
      bearer === undefined &&
      (req.headers.origin !== `${authority.secure ? "https" : "http"}://${host}` ||
        req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    )
      return refuse(telemetry, "cookie_write_origin");
    const secret = bearer ?? values[0]!.slice(authority.cookieName.length + 1);
    if (!TOKEN_SEGMENT.test(secret)) return refuse(telemetry, "credential_malformed");
    // A cookie holds the browser's session (owner or grant), never a secret itself.
    // A Bearer is the service token or a grant's own secret, never a session: a session is a cookie only (C-31).
    const credential =
      bearer !== undefined
        ? tokenMatches(secret, authority.serviceToken)
          ? {}
          : authority.grants.authenticateLink(secret) === null
            ? null
            : { grantId: "bearer" }
        : cookieCredential(authority, secret);
    if (credential === null) return refuse(telemetry, "credential_invalid");
    if (credential.grantId === undefined) return { owner: true };
    return access === "public" || access === "page" ? { owner: false } : refuse(telemetry, "not_owner");
  }

  async #route(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
    admitted: Admission,
  ): Promise<void> {
    const telemetry = this.#options.telemetry;
    const name = pathname.slice(DEBUG_PREFIX.length);
    const method = req.method ?? "GET";
    if (method === "GET" && name === "health") return send(res, 200, this.#health());
    if (method === "GET" && name === "metrics")
      return send(res, 200, { ...telemetry.metrics(), streamsOpen: this.#options.streams() });
    if (method === "GET" && (name === "log" || name === "events")) {
      const parsed = logQuery(query, name === "events");
      if (typeof parsed === "string")
        return send(res, 422, { error: { code: "invalid_debug_query", message: parsed } });
      return send(res, 200, { seq: telemetry.seq, entries: telemetry.entries(parsed) });
    }
    if (method === "POST" && name === "events") return this.#clientEvents(req, res, admitted.owner);
    if (method === "POST" && name === "reset") {
      req.resume();
      telemetry.reset();
      return send(res, 200, { reset: true, seq: telemetry.seq });
    }
    if (method === "POST" && name === "profile/cpu") return this.#cpuProfile(req, res, query);
    if (method === "POST" && name === "heap-snapshot") return this.#heapSnapshot(req, res);
    req.resume();
    res.writeHead(404, { "content-length": "0" }).end();
  }

  #health(): unknown {
    const telemetry = this.#options.telemetry;
    const memory = telemetry.memoryNow();
    return {
      ok: true,
      version: this.#options.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      projects: this.#options.projects().map((project) => ({
        slug: project.slug,
        loaded: project.loaded,
        watcher: project.watcher,
        lastReloadMs: telemetry.lastReloadMs(project.root),
      })),
      streams: this.#options.streams(),
      eventLoopLagMs: telemetry.eventLoopLagMs(),
      heapUsedMb: memory.heapUsedMb,
      rssMb: memory.rssMb,
      warnings: telemetry.warningsWithin(THRESHOLDS.warningsWindowMs),
    };
  }

  /**
   * The owner's events keep their text, redacted. Anyone else's (a grant, a paired device) keep their
   * code and structure but no free text (R9, C-35): such a caller can write its own secret cut short,
   * which no redactor can know (a grant is stored as a verifier).
   */
  async #clientEvents(req: IncomingMessage, res: ServerResponse, owner: boolean): Promise<void> {
    const type = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    // A cookie upload is JSON (checked at admission; the page's beacon sends an application/json Blob).
    // A Bearer caller may also post text/plain carrying the same JSON.
    if (type !== undefined && type !== "application/json" && type !== "text/plain") {
      req.resume();
      return send(res, 415, { error: { code: "invalid_debug_events", message: "send the batch as JSON" } });
    }
    const text = await readBody(req, res, MAX_CLIENT_BATCH_BYTES);
    if (text === null) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return send(res, 422, { error: { code: "invalid_debug_events", message: "the batch is not JSON" } });
    }
    const parsed = parseClientBatch(value);
    if (typeof parsed === "string") return send(res, 422, { error: { code: "invalid_debug_events", message: parsed } });
    const batch = owner ? parsed : textless(parsed);
    for (const event of batch.events)
      this.#options.telemetry.client(event.level, event.code, event.msg, event.at, {
        session: batch.session,
        page: batch.page,
        build: batch.build,
        type: event.type,
        ...(event.data === undefined ? {} : { data: event.data }),
      });
    send(res, 200, { accepted: batch.events.length, seq: this.#options.telemetry.seq });
  }

  async #cpuProfile(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    req.resume();
    const raw = query.get("seconds") ?? "5";
    const seconds = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (!(seconds >= 1 && seconds <= MAX_PROFILE_SECONDS))
      return send(res, 422, {
        error: { code: "invalid_debug_query", message: `seconds must be an integer from 1 to ${MAX_PROFILE_SECONDS}` },
      });
    if (this.#profiling)
      return send(res, 409, {
        error: { code: "profile_busy", message: "a profile or heap snapshot is already being taken" },
      });
    this.#profiling = true;
    const session = new Session();
    try {
      session.connect();
      await post(session, "Profiler.enable");
      await post(session, "Profiler.start");
      this.#options.telemetry.log("info", "svc.profile", `CPU profile started for ${seconds} s`);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      const { profile } = (await post(session, "Profiler.stop")) as { profile: unknown };
      const body = JSON.stringify(profile);
      res
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          "content-disposition": `attachment; filename="archer-${stamp()}.cpuprofile"`,
        })
        .end(body);
    } finally {
      session.disconnect();
      this.#profiling = false;
    }
  }

  /**
   * The snapshot goes to a private, size-capped temporary file first (the inspector cannot be paused),
   * then to the client with backpressure. One profile or snapshot at a time: the lock is held until
   * delivery ends, a client that went away gets nothing, and the file is always removed.
   */
  async #heapSnapshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume();
    if (this.#profiling)
      return send(res, 409, {
        error: { code: "profile_busy", message: "a profile or heap snapshot is already being taken" },
      });
    this.#profiling = true;
    const limit = this.#options.maxHeapSnapshotBytes ?? MAX_HEAP_SNAPSHOT_BYTES;
    let gone = false;
    res.once("close", () => {
      gone = true;
    });
    const dir = mkdtempSync(join(tmpdir(), "archer-heap-"));
    const file = join(dir, "snapshot.heapsnapshot");
    let fd: number | null = openSync(file, "wx", 0o600);
    try {
      let size = 0,
        tooLarge = false;
      this.#options.telemetry.log("info", "svc.heap-snapshot", "heap snapshot started");
      await (this.#options.takeHeapSnapshot ?? inspectorHeapSnapshot)((chunk) => {
        if (tooLarge || gone) return;
        const bytes = Buffer.from(chunk, "utf8");
        if (size + bytes.length > limit) {
          tooLarge = true;
          return;
        }
        writeSync(fd!, bytes);
        size += bytes.length;
      });
      closeSync(fd);
      fd = null;
      if (gone)
        return void this.#options.telemetry.log(
          "info",
          "svc.heap-snapshot",
          "heap snapshot abandoned: the client went away",
        );
      if (tooLarge)
        return send(res, 413, {
          error: { code: "heap_snapshot_too_large", message: `the heap snapshot exceeds ${limit} bytes` },
        });
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": size,
        "content-disposition": `attachment; filename="archer-${stamp()}.heapsnapshot"`,
      });
      try {
        await pipeline(createReadStream(file), res);
      } catch {
        this.#options.telemetry.log(
          "info",
          "svc.heap-snapshot",
          "heap snapshot delivery ended early: the client went away",
        );
      }
    } finally {
      if (fd !== null) closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
      this.#profiling = false;
    }
  }
}

async function inspectorHeapSnapshot(chunk: (text: string) => void): Promise<void> {
  const session = new Session();
  session.connect();
  try {
    session.on("HeapProfiler.addHeapSnapshotChunk", (message) => chunk((message.params as { chunk: string }).chunk));
    await post(session, "HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    session.disconnect();
  }
}

/** An admitted debug request: whether its caller is the owner. */
interface Admission {
  readonly owner: boolean;
}

function refuse(telemetry: Telemetry, reason: string): null {
  telemetry.log("info", "svc.debug-refused", `debug route refused: ${reason}`, { data: { reason } });
  return null;
}

function post(session: Session, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) =>
    session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))),
  );
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

function headerOf(headers: unknown, name: string): unknown {
  if (headers === undefined || headers === null) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2)
      if (String(headers[i]).toLowerCase() === name) return headers[i + 1];
    return undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>))
    if (key.toLowerCase() === name) return value;
  return undefined;
}

function sizeOf(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-length": Buffer.byteLength(text),
    })
    .end(text);
}

export interface LogQuery {
  since?: number;
  level?: Level;
  limit: number;
  code?: string;
  source?: "client" | "all";
}

/** The log routes' query, or why it is refused. */
export function logQuery(query: URLSearchParams, clientOnly: boolean): LogQuery | string {
  const out: LogQuery = { limit: DEFAULT_LOG_LIMIT, source: clientOnly ? "client" : "all" };
  const since = query.get("since"),
    level = query.get("level"),
    limit = query.get("limit"),
    code = query.get("code");
  if (since !== null) {
    if (!/^\d{1,15}$/.test(since)) return "since is a log sequence number";
    out.since = Number(since);
  }
  if (level !== null) {
    if (!isLevel(level)) return "level is debug, info, warn or error";
    out.level = level;
  }
  if (limit !== null) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LOG_LIMIT)
      return `limit is 1 to ${MAX_LOG_LIMIT}`;
    out.limit = Number(limit);
  }
  if (code !== null) {
    if (code.length > 96) return "code is a prefix of at most 96 characters";
    out.code = code;
  }
  return out;
}

interface ClientEvent {
  readonly at: string;
  readonly type: string;
  readonly level: Level;
  readonly code: string;
  readonly msg: string;
  readonly data?: unknown;
}
interface ClientBatch {
  readonly session: string;
  readonly page: string;
  readonly build: string;
  readonly events: readonly ClientEvent[];
}

const shortString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** A browser batch `{session, page, build, events:[{at, type, code?, msg?, data?, level?}]}`, or why it is refused. */
export function parseClientBatch(value: unknown): ClientBatch | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "a batch is an object";
  const batch = value as Record<string, unknown>;
  if (!shortString(batch.session, 128) || !shortString(batch.page, 1024) || !shortString(batch.build, 128))
    return "session, page and build are short strings";
  if (!Array.isArray(batch.events) || batch.events.length > MAX_CLIENT_EVENTS)
    return `events is a list of at most ${MAX_CLIENT_EVENTS}`;
  const events: ClientEvent[] = [];
  for (const item of batch.events) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "each event is an object";
    const event = item as Record<string, unknown>;
    if (!shortString(event.type, 64) || event.type === "") return "each event has a type";
    if (event.code !== undefined && !shortString(event.code, 96)) return "an event code is a short string";
    if (event.msg !== undefined && !shortString(event.msg, 4096))
      return "an event msg is a string of at most 4096 characters";
    if (event.level !== undefined && !isLevel(event.level)) return "an event level is debug, info, warn or error";
    const at =
      typeof event.at === "number" && Number.isFinite(event.at)
        ? new Date(event.at)
        : typeof event.at === "string"
          ? new Date(event.at)
          : null;
    if (at === null || Number.isNaN(at.getTime())) return "each event has an at time";
    const code = (event.code as string | undefined) ?? `ui.${event.type}`;
    events.push({
      at: at.toISOString(),
      type: event.type,
      level: clientLevel(event.level as Level | undefined, event.type, code),
      code,
      msg: (event.msg as string | undefined) ?? "",
      ...(event.data === undefined ? {} : { data: event.data }),
    });
  }
  return { session: batch.session, page: batch.page, build: batch.build, events };
}

/** A word that could be a credential cut short: 8 or more hex digits in a row, in either case. */
const HEX_RUN = /[0-9a-f]{8,}/i;
const CLIENT_CODE = /^ui(?:\.[a-z][a-z0-9-]{0,47}){1,3}$/;
const CLIENT_TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const TEXTLESS_DEPTH = 4,
  TEXTLESS_ITEMS = 40;

/** A string's length, in place of the string. */
const textMark = (text: string): string => `<text:${text.length}>`;
/** A name of the shape the page's own reports use (`ui.fetch-slow`, `pageview`), holding no hex run; else `fallback`. */
const named = (value: string, shape: RegExp, fallback: string): string =>
  shape.test(value) && !HEX_RUN.test(value) ? value : fallback;

/** This process's key for non-owner session marks; never stored, so a mark means nothing after a restart. */
const SESSION_KEY = randomBytes(32);
/** An opaque mark the service makes from a page-load session: equal sessions get equal marks, and none holds the caller's text. */
const sessionMark = (session: string): string =>
  `anon-${createHmac("sha256", SESSION_KEY).update(session).digest("hex").slice(0, 12)}`;

/**
 * A non-owner batch with no free text (R9, C-35, re-score 4): each event keeps its level and structure;
 * its time is when the service received it; its code and type only when shaped like the page's own
 * (`ui.other`, `other` otherwise); its page-load session as an opaque service-made mark. Every other
 * string, and every number written with 8 or more digits (a credential's 8-character prefix as a number),
 * becomes its length; a key not shaped like an identifier, or holding a hex run, becomes its position.
 * Cut as redact() cuts: depth 4, 40 keys or items.
 */
export function textless(batch: ClientBatch, received: Date = new Date()): ClientBatch {
  const at = received.toISOString();
  return {
    session: sessionMark(batch.session),
    page: textMark(batch.page),
    build: textMark(batch.build),
    events: batch.events.map((event) => ({
      at,
      level: event.level,
      type: named(event.type, CLIENT_TYPE, "other"),
      code: named(event.code, CLIENT_CODE, "ui.other"),
      msg: event.msg === "" ? "" : textMark(event.msg),
      ...(event.data === undefined ? {} : { data: withoutText(event.data, 0) }),
    })),
  };
}

function withoutText(value: unknown, depth: number): unknown {
  if (typeof value === "string") return textMark(value);
  if (typeof value === "number")
    return (String(value).match(/\d/g)?.length ?? 0) >= 8 ? `<number:${String(value).length}>` : value;
  if (value === null || typeof value !== "object") return typeof value === "boolean" ? value : null;
  if (depth >= TEXTLESS_DEPTH) return "[depth]";
  if (Array.isArray(value)) {
    const items = value.slice(0, TEXTLESS_ITEMS).map((item) => withoutText(item, depth + 1));
    if (value.length > TEXTLESS_ITEMS) items.push(`[${value.length - TEXTLESS_ITEMS} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (n >= TEXTLESS_ITEMS) {
      out["…"] = "[more keys]";
      break;
    }
    out[named(key, KEY, `#${n}`)] = withoutText((value as Record<string, unknown>)[key], depth + 1);
    n++;
  }
  return out;
}

/** An explicit level wins; otherwise the contract's `ui.*` codes are warnings, except the vitals report. */
function clientLevel(level: Level | undefined, type: string, code: string): Level {
  if (level !== undefined) return level;
  if (type === "error") return "error";
  if (type === "warn" || type === "warning") return "warn";
  if (type === "info" || type === "pageview" || code === "ui.web-vitals") return "info";
  return code.startsWith("ui.") ? "warn" : "info";
}
