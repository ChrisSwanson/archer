// Temporary services for the service tests: a private state directory and
// socket per test, a temp project, and small HTTP and SSE clients.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startService, type RunningService, type ServiceOptions } from "../../src/service/index.ts";
import { held, readLock } from "../../src/service/lock.ts";
import { namedPageAssets } from "../../../shared/page-assets.mts";

const made: string[] = [];
const running: RunningService[] = [];

/** A child process keeps its executable environment but owns its Archer settings. */
export function isolatedProcessEnv(home: string, overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The writers root stays shared so a child writer excludes its parent test (src/comments/lock.ts).
    if (value !== undefined && (!key.startsWith("ARCHER_") || key === "ARCHER_WRITERS_DIR")) env[key] = value;
  }
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * The owner's browser, one per service origin: where it signs in (an agent-facing link, its token exchanged
 * once for the session cookie, as a page does) and that cookie once it has.
 */
const browsers = new Map<string, { readonly signIn: string; cookie?: Promise<string> | undefined }>();

/**
 * A project's API root (`<origin>/p/<name>/`) from the agent-facing page URL
 * (`<origin>/projects/<name>/?follow&token=<token>`), remembering the link so `http`, `json` and `events` send
 * the owner's session cookie to that origin as the owner's browser would. Any other URL is returned as is.
 */
export function apiBase(url: string): string {
  const parsed = new URL(url);
  // The project page (`/projects/<name>/`) or a page in it: a presented diagram's own address (claude-08).
  const name = /^\/projects\/([^/]+)\//.exec(parsed.pathname)?.[1];
  const token = parsed.searchParams.get("token");
  if (name === undefined || token === null) return url;
  const known = browsers.get(parsed.origin);
  const signIn = `${parsed.origin}/projects/${name}/?token=${token}`;
  if (known === undefined || !known.signIn.endsWith(`token=${token}`)) browsers.set(parsed.origin, { signIn });
  return `${parsed.origin}/p/${name}/`;
}

/**
 * The service's own API root (`<origin>/`: `api/projects`, `api/connection`, `api/settings`, …) from its home link
 * (`<origin>/projects/?token=<token>`, hello's `homeUrl`), remembered as `apiBase` remembers a project link.
 */
export function serviceBase(homeUrl: string): string {
  const parsed = new URL(homeUrl);
  const token = parsed.searchParams.get("token");
  if (parsed.pathname !== "/projects/" || token === null) throw new Error(`not a home link: ${parsed.pathname}`);
  const known = browsers.get(parsed.origin);
  if (known === undefined || !known.signIn.endsWith(`token=${token}`))
    browsers.set(parsed.origin, { signIn: `${parsed.origin}/projects/?token=${token}` });
  return `${parsed.origin}/`;
}

/**
 * The owner's session cookie for `url`'s origin when `apiBase` has seen an agent link there: the token exchanged
 * once (`GET /projects/<name>/?token=` → 303 and `set-cookie`), as the page's first load does. Null elsewhere.
 */
export async function ownerCookie(url: string): Promise<string | null> {
  const browser = browsers.get(new URL(url).origin);
  if (browser === undefined) return null;
  browser.cookie ??= exactly(browser.signIn).then((reply) => {
    const cookie = (reply.headers["set-cookie"] as string[] | undefined)?.[0]?.split(";")[0];
    if (reply.status !== 303 || cookie === undefined) {
      browser.cookie = undefined;
      throw new Error(`signing in at ${new URL(browser.signIn).pathname}: ${reply.status} ${reply.body}`);
    }
    return cookie;
  });
  return browser.cookie;
}

/**
 * `headers` as the owner's browser sends them to `url`: its session cookie, and on a write its own Origin and a
 * JSON content type, each unless given.
 * Unchanged when they name a credential of their own (a cookie or an Authorization) or no sign-in is known.
 */
export async function asOwner(
  url: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  const named = Object.keys(headers).map((key) => key.toLowerCase());
  if (named.includes("cookie") || named.includes("authorization")) return headers;
  const cookie = await ownerCookie(url);
  if (cookie === null) return headers;
  const write = !["GET", "HEAD"].includes(method.toUpperCase());
  // Every write the page sends is JSON from its own origin.
  return {
    ...(write && !named.includes("origin") ? { origin: new URL(url).origin } : {}),
    ...(write && !named.includes("content-type") ? { "content-type": "application/json" } : {}),
    ...headers,
    cookie,
  };
}

/** The project name an agent-facing page URL addresses. */
export function slugOf(url: string): string {
  const path = new URL(url).pathname;
  return /^\/projects\/([^/]+)\//.exec(path)?.[1] ?? /\/p\/([^/]+)\//.exec(path)?.[1] ?? "";
}

export function tempDir(prefix = "archer-svc-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function write(dir: string, path: string, text: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

/** A service on its own state directory, closed by `cleanUp`. */
/**
 * `comments: "queued"` writes the account's `comment_submission = "queued"` first: for tests of drafts and
 * Send queued comments, now that each comment is sent by default (decided 2026-10-29).
 */
export async function service(
  options: Partial<ServiceOptions> = {},
  extra: { readonly comments?: "queued" } = {},
): Promise<{ svc: RunningService; state: string }> {
  const state = options.stateDir ?? tempDir("archer-state-");
  if (extra.comments === "queued")
    write(join(state, ".config"), "archer/archer.toml", 'version = 1\n[service]\ncomment_submission = "queued"\n');
  // warmStart (Mermaid loaded before listening, a painter started, quick background drawing) is
  // production's default; off here so each test's drawings and timings are its own unless it asks.
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    socketPath: join(state, "archer.sock"),
    log: () => {},
    warmStart: false,
    ...options,
    env: { HOME: state, XDG_CONFIG_HOME: join(state, ".config"), ARCHER_HOME: join(state, ".archer"), ...options.env },
  });
  running.push(svc);
  return { svc, state };
}

export async function cleanUp(): Promise<void> {
  for (const svc of running.splice(0)) await svc.close();
  // A later test's service may take the same port: its browser signs in afresh.
  browsers.clear();
  const dirs = made.splice(0);
  // A test that started a detached service (`archer serve`, ensureService) and failed before
  // stopping it left that daemon running on a deleted state dir (server review S16).
  await Promise.all(dirs.map(stopServicesUnder));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

/** The lock files a service started under `dir` would hold: its state dir, or its XDG state home's. */
function locksUnder(dir: string, depth = 3): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === "archer.lock") return [path];
    return entry.isDirectory() && !entry.isSymbolicLink() && depth > 0 && entry.name !== "node_modules"
      ? locksUnder(path, depth - 1)
      : [];
  });
}

/**
 * Stops each service whose lock lies under `dir`: SIGTERM, then SIGKILL after 3 s. Only a lock's
 * live holder is signalled (its owner token matches), never this process or a reused pid.
 */
export async function stopServicesUnder(dir: string): Promise<number[]> {
  const pids = [
    ...new Set(
      locksUnder(dir).flatMap((lock) => {
        const holder = readLock(lock);
        return holder !== null && holder.pid !== process.pid && held(lock, holder) ? [holder.pid] : [];
      }),
    ),
  ];
  await Promise.all(
    pids.map(async (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }),
  );
  return pids;
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** `fetch` as the owner's browser sends it (`asOwner`). */
export async function ownerFetch(
  url: string | URL,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const href = String(url);
  return fetch(href, { ...init, headers: await asOwner(href, init.method ?? "GET", init.headers) });
}

type HttpOptions = { method?: string; headers?: Record<string, string>; body?: string };

/**
 * One HTTP request as the owner's browser sends it (`asOwner`): the headers given, and its session cookie where
 * `apiBase` has seen an agent link to that origin and the headers name no credential of their own.
 */
export async function http(url: string, options: HttpOptions = {}): Promise<Reply> {
  return exactly(url, { ...options, headers: await asOwner(url, options.method ?? "GET", options.headers) });
}

/** One HTTP request with exactly the headers given (fetch would add an Origin of its own). */
export function exactly(url: string, options: HttpOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Open a page as a browser does: an access exchange's cookie is carried to the clean address it names. */
export async function openPage(url: string): Promise<Reply> {
  const first = await exactly(url);
  if (first.status !== 303) return first;
  const cookie = (first.headers["set-cookie"] as string[] | undefined)?.[0]?.split(";")[0];
  return exactly(
    new URL(first.headers.location as string, url).href,
    cookie === undefined ? {} : { headers: { cookie } },
  );
}

/**
 * Open a page as a browser does, then fetch each page asset it names (`/-/page-assets/<name>`, its layout
 * worker) with the same cookie, as its worker would be fetched. A single-file page names none.
 */
export async function pageWorkers(url: string): Promise<{
  readonly page: Reply;
  readonly workers: readonly {
    readonly name: string;
    readonly status: number;
    readonly contentType: string | null;
    readonly encoding: string | null;
    readonly bytes: number;
  }[];
}> {
  const first = await exactly(url);
  const cookie = (first.headers["set-cookie"] as string[] | undefined)?.[0]?.split(";")[0];
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  const page =
    first.status === 303 ? await exactly(new URL(first.headers.location as string, url).href, { headers }) : first;
  const names = namedPageAssets(page.body);
  const workers = await Promise.all(
    names.map(async (name) => {
      const reply = await fetch(new URL(`/-/page-assets/${name}`, url), {
        headers: { ...headers, "accept-encoding": "br, gzip" },
      });
      return {
        name,
        status: reply.status,
        contentType: reply.headers.get("content-type"),
        encoding: reply.headers.get("content-encoding"),
        bytes: (await reply.arrayBuffer()).byteLength,
      };
    }),
  );
  return { page, workers };
}

export const json = async (url: string): Promise<unknown> => {
  const reply = await http(url);
  if (reply.status !== 200) throw new Error(`GET ${url}: ${reply.status} ${reply.body}`);
  return JSON.parse(reply.body) as unknown;
};

export interface Sse {
  readonly status: number;
  /** Resolves with the next event of that name (ignoring others), or rejects after `ms`. */
  next(name: string, ms?: number): Promise<unknown>;
  readonly comments: string[];
  close(): void;
}

/** Opens `api/events` and collects named events as they arrive (with the owner's cookie, as `http`). */
export async function events(url: string, given: Record<string, string> = {}): Promise<Sse> {
  const headers = await asOwner(url, "GET", given);
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const queue: { event: string; data: unknown }[] = [];
      const waiters: (() => void)[] = [];
      const comments: string[] = [];
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) comments.push(line.slice(1).trim());
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data !== "") queue.push({ event, data: JSON.parse(data) as unknown });
          waiters.splice(0).forEach((w) => w());
        }
      });
      resolve({
        status: res.statusCode ?? 0,
        comments,
        close: () => req.destroy(),
        next: (name, ms = 10_000) =>
          new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`no ${name} event within ${ms} ms`)), ms);
            const look = (): void => {
              const index = queue.findIndex((e) => e.event === name);
              if (index >= 0) {
                clearTimeout(timer);
                ok(queue.splice(0, index + 1).at(-1)?.data);
              } else waiters.push(look);
            };
            look();
          }),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** A fresh operation identity (ADR 0016): a 128-bit client nonce, as 32 lowercase hex, and the time now. */
function operationIdentity(): { id: string; issuedAt: number } {
  return { id: randomBytes(16).toString("hex"), issuedAt: Date.now() };
}

/**
 * The page's comment writes as it sends them (ADR 0016): each an operation, `{ operation, payload }`, answered with a
 * receipt (a create or reply's answer is an OperationAck: its `thread` is the thread as it is now).
 */
export const commentOperation = {
  /** POST api/comments: a NewThread (`{ target, anchor, body, context? }`). */
  create: (input: { readonly target: string } & Record<string, unknown>) => ({
    operation: { ...operationIdentity(), name: "comment.create", target: input.target },
    payload: input,
  }),
  /** POST api/comments/<id>/replies: `{ body, context? }`, on the thread's target. */
  reply: (target: string, payload: { readonly body: string } & Record<string, unknown>) => ({
    operation: { ...operationIdentity(), name: "comment.reply", target },
    payload,
  }),
  /** POST api/comments/submit: `{ target?, threadId? }`. */
  submit: (payload: { readonly target?: string; readonly threadId?: string } = {}) => ({
    operation: { ...operationIdentity(), name: "comment.submit" },
    payload,
  }),
};

const REPLIES = /(?:^|\/)api\/comments\/([^/?]+)\/replies$/;
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !("operation" in value);

/**
 * A comment write's body as the page sends it: a create, a reply or a submit as its operation (a reply on the target
 * `targetOf` names for its thread). Anything else (another route, an envelope already, a body that is not an object)
 * is sent as it is, so a refusal of a malformed body is still the service's to give.
 */
export function pageCommentBody(
  method: string,
  path: string,
  body: unknown,
  targetOf: (threadId: string) => string | undefined = () => undefined,
): unknown {
  if (method !== "POST" || !isPlainRecord(body)) return body;
  const route = path.split("?", 1)[0]!;
  if (/(?:^|\/)api\/comments$/.test(route) && typeof body["target"] === "string")
    return commentOperation.create(body as { target: string });
  if (/(?:^|\/)api\/comments\/submit$/.test(route)) return commentOperation.submit(body);
  const reply = REPLIES.exec(route);
  const target = reply === null ? undefined : targetOf(decodeURIComponent(reply[1]!));
  if (reply !== null && target !== undefined && typeof body["body"] === "string")
    return commentOperation.reply(target, body as { body: string });
  return body;
}

/** A create or reply's answer as the page reads it: the receipt's thread. Any other answer is unchanged. */
export function pageCommentAnswer(method: string, path: string, reply: Reply): Reply {
  const route = path.split("?", 1)[0]!;
  if (method !== "POST" || reply.status !== 200 || !(/(?:^|\/)api\/comments$/.test(route) || REPLIES.test(route)))
    return reply;
  const parsed = JSON.parse(reply.body) as { thread?: unknown };
  return "thread" in parsed ? { ...reply, body: JSON.stringify(parsed.thread) } : reply;
}

/**
 * `http` for a request the page makes: a create, reply or submit's JSON body sent as its operation (`pageCommentBody`;
 * a reply on `replyTarget`), and a create or reply's answer read as its receipt's thread (`pageCommentAnswer`).
 */
export async function pageHttp(url: string, options: HttpOptions = {}, replyTarget = "view:flow"): Promise<Reply> {
  const method = options.method ?? "GET";
  const path = new URL(url).pathname;
  let body = options.body;
  if (method === "POST" && body !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const sent = pageCommentBody(method, path, parsed, () => replyTarget);
    if (parsed !== undefined && sent !== parsed) body = JSON.stringify(sent);
  }
  // A length given for the body as written is the length of the body as sent.
  const headers =
    options.headers === undefined || body === undefined || !("content-length" in options.headers)
      ? options.headers
      : { ...options.headers, "content-length": String(Buffer.byteLength(body)) };
  return pageCommentAnswer(
    method,
    path,
    await http(url, {
      ...options,
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    }),
  );
}

/**
 * The page's requests to the project API base `page`, from `origin`, as ui/src/comments/transport.ts sends them:
 * JSON, a create, reply or submit as its operation (`pageCommentBody`; a reply on the target its thread was answered
 * with, else `fallbackTarget`), and a create or reply read as its receipt's thread (`pageCommentAnswer`).
 */
export function pageWrites(page: string, origin: string, fallbackTarget = "view:flow") {
  const targets = new Map<string, string>();
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    // A body-less write is `{}`, as the page sends it.
    const given = body === undefined && method !== "GET" && method !== "DELETE" ? {} : body;
    const sent = pageCommentBody(method, path, given, (threadId) => targets.get(threadId) ?? fallbackTarget);
    const text = sent === undefined ? undefined : typeof sent === "string" ? sent : JSON.stringify(sent);
    const reply = pageCommentAnswer(
      method,
      path,
      await http(`${page}${path}`, {
        method,
        headers: { origin, ...(text === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(text === undefined ? {} : { body: text }),
      }),
    );
    if (reply.status === 200) {
      const answer = JSON.parse(reply.body) as { id?: unknown; target?: unknown };
      if (typeof answer.id === "string" && typeof answer.target === "string") targets.set(answer.id, answer.target);
    }
    return reply;
  };
}

export const FLOW = "flowchart LR\n  a[Client] e1@--> b[API]\n";
export const FLOW2 = "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[DB]\n";
export const SEQ = "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: hi\n";
/** An implicit node: refused by Archer's validator. */
export const BROKEN = "flowchart LR\n  a[A] --> b[B]\n";

/** A project with one archer.toml view (`flow`) and one unlisted sequence (`chat`). */
export function project(): string {
  const root = tempDir("archer-proj-");
  write(
    root,
    "archer.toml",
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/flow.mmd"\n',
  );
  write(root, ".archer/flow.mmd", FLOW);
  write(root, ".archer/chat.mmd", SEQ);
  return root;
}
