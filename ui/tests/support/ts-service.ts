/**
 * The real TypeScript service (`ts/src/service`), started in this process on
 * a temporary state directory, with one temporary project attached.
 *
 * Loaded by computed path rather than imported: the service is type-checked
 * by its own workspace under its own settings (NodeNext, `.ts` imports), and
 * the page's `tsc` would otherwise check it again under the page's, which it
 * was not written for. What is used of it is typed here, narrowly.
 *
 * The agent's side is the service's own: `replyComment` is what the
 * `reply_comment` MCP tool calls.
 */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Anchor, NoteEmphasisRead, TargetRef, Thread, UpsertNoteEmphasisInput } from "../../src/comments/contract";

const TS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../ts/src");
/** The real `fetch`, taken before a test stubs the global one with a function that calls these helpers. */
const realFetch = globalThis.fetch;

/** Optional Linux evidence, bounded independently of the number of native watches. */
function watcherUsage(): { fds: number; watches: number; limited: boolean } | { unavailable: true } {
  try {
    const entries = readdirSync("/proc/self/fdinfo");
    const buffer = Buffer.alloc(256 * 1024);
    let fds = 0;
    let watches = 0;
    let limited = entries.length > 4096;
    for (const entry of entries.slice(0, 4096)) {
      let fd: number | undefined;
      try {
        if (readlinkSync(`/proc/self/fd/${entry}`) !== "anon_inode:inotify") continue;
        fd = openSync(`/proc/self/fdinfo/${entry}`, "r");
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        fds++;
        limited ||= bytes === buffer.length;
        const lines = buffer.toString("utf8", 0, bytes).matchAll(/^inotify wd:/gm);
        for (const _ of lines) watches++;
      } catch {
        /* A descriptor can close between listing and reading. */
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    return { fds, watches, limited };
  } catch {
    return { unavailable: true };
  }
}

type Service = { readonly socketPath: string; close(): Promise<void> };
type Client = { call(method: string, params: unknown): Promise<unknown>; close(): void };

async function load<T>(path: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(TS_SRC, path)).href)) as T;
}

/** A tool answer that says it refused (rather than throwing) is a refusal all the same. */
function refused(answer: unknown): void {
  const a = answer as { isError?: unknown; text?: unknown } | null;
  if (a?.isError === true) throw new Error(typeof a.text === "string" ? a.text : "the tool refused");
}

export type TsProject = {
  readonly caCert?: string;
  issueAccess(label: string): Promise<{ id: string; token: string; url: string }>;
  /** Explicit fixture issuance; ordinary reader grants retain their authority. */
  issueAuthoringAccess(label: string): Promise<{ id: string; token: string; url: string }>;
  revokeAccess(grantId: string): Promise<void>;
  /** What `issue_pairing_code` returns: the base address and a single-use code. */
  issuePairingCode(): Promise<{ code: string; url: string; minutes: number; expiresAt: string }>;
  listAccess(): Promise<{ id: string; label: string; revokedAt: string | null }[]>;
  /**
   * What the agent is handed: `<origin>/projects/<name>/?follow&token=<service token>`. Opening it is how the
   * owner's browser signs in: the service sets the access cookie and redirects to `/projects/<name>/?follow`.
   */
  readonly url: string;
  /** The same as `url`. */
  readonly agentUrl: string;
  /** `url` with `query` (`view=…`, `note=…`, `folder=…`, `overview=1`) after it: a link to that place that signs in. */
  address(query: string): string;
  /** The project's API route `path` (`api/…`), absolute: `<origin>/p/<name>/<path>`. */
  api(path: string): string;
  /**
   * `fetch` of the API route `path` as the owner's browser sends it: its session cookie (the agent link's token
   * exchanged once, as the page's first load does) and, on a write, its own Origin, beside the headers given.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly root: string;
  /** Isolated shared configuration; tests must never write the operator's global file. */
  readonly configPath: string;
  /** The agent presenting a view, with its caption when given. */
  present(
    viewId: string,
    annotation?: string,
    walkthrough?: { readonly id: string; readonly step: number },
  ): Promise<void>;
  /** What `get_presentation_context` reports of the reader's walkthrough: the page posts it beside the selection. */
  reading(): Promise<{ viewId: string; id: string; step: number } | null>;
  /**
   * The agent writing a view's source, as `write_diagram` does (phase 3): it
   * tells the service first (`recordWrite`), so the recompile is the agent's.
   * `path` is relative to the project root.
   */
  agentWrite(viewId: string, path: string, text: string, summary?: string): Promise<void>;
  /** What the page last reported the reader selected, as `get_selection` returns it. */
  selection(): Promise<{
    viewId: string;
    nodes: { id: string; label?: string }[];
    edges: { id: string; label?: string }[];
  } | null>;
  /** The agent's emphasis on a view, as the `set_emphasis` tool sends it. */
  setEmphasis(viewId: string, emphases: readonly unknown[]): Promise<void>;
  /** The agent opening a discussion through the production `create_comment` implementation. */
  agentCreateComment(target: TargetRef, anchor: Anchor, body: string): Promise<Thread>;
  /** The agent writing one named passage-emphasis set through the production store. */
  agentSetNoteEmphasis(input: UpsertNoteEmphasisInput): Promise<NoteEmphasisRead>;
  /**
   * The agent answering a thread, through the service's own tool code, at the
   * revision it read (schema version 2; a version-1 service ignores it).
   */
  agentReply(threadId: string, body: string, expectedRevision?: number): Promise<void>;
  /**
   * The agent marking a thread done (`resolve_comment`). ASSUMES the version-2
   * tool code takes `(project, threadId, expectedRevision, note?)`, the order
   * the amendment lists the tool's arguments in; adjust here if it does not.
   */
  agentResolve(threadId: string, expectedRevision: number, note?: string): Promise<void>;
  /** The threads awaiting the agent, as `get_comments` returns them (in version 2, sent becomes read). */
  agentInbox(): Promise<unknown[]>;
  /** Any management-socket method on this project (`root` is added): present with `expand`, getContext. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Another project on this same service: `files` written to a fresh temporary root and attached, as a second
   * `attach` does. An attach costs a few tens of milliseconds where a service costs most of a second, so a test
   * file can start one service in `beforeAll` and give each test a project nothing else has touched. Its `stop`
   * detaches it and removes its root; the service, and `restart`, are the one that made it.
   */
  attachProject(
    files: Record<string, string>,
    options?: {
      readonly nestedView?: boolean;
      /** Run on the project's root once its files are written, before it is attached (a `git init`, say). */
      readonly prepare?: (root: string) => Promise<void> | void;
    },
  ): Promise<TsProject>;
  /** Stops the service and starts it again on the same state directory, restoring what it saved. */
  restart(): Promise<void>;
  stop(): Promise<void>;
};

/** The project's API base (`<origin>/p/<name>/`) of an agent-facing URL (`<origin>/projects/<name>/?follow&token=…`). */
export function apiBaseOf(agentUrl: string): string {
  const attached = new URL(agentUrl);
  const name = /^\/projects\/([^/]+)\/$/.exec(attached.pathname)?.[1];
  if (name === undefined) throw new Error(`not an agent-facing project URL: ${attached.pathname}`);
  return `${attached.origin}/p/${name}/`;
}

/**
 * The owner's session cookie, as the browser gets it: the agent link (its service token) opened once, the
 * service answering 303 with `set-cookie`. Only the `name=value` pair.
 */
export async function signInCookie(agentUrl: string): Promise<string> {
  const answer = await realFetch(agentUrl, { redirect: "manual" });
  const cookie = answer.headers.getSetCookie()[0]?.split(";")[0];
  if (answer.status !== 303 || cookie === undefined)
    throw new Error(`signing in at ${new URL(agentUrl).pathname}: ${answer.status}`);
  return cookie;
}

/** `fetch` of `url` as the owner's browser sends it: `cookie`, and on a write its own Origin, beside `init`'s headers. */
export function fetchAsOwner(url: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", new URL(url).origin);
  return realFetch(url, { ...init, headers });
}

const CHECKOUT_PAGE = resolve(import.meta.dirname, "../../dist/index.html");
/**
 * ARCHER_PAGE names a page built elsewhere (a scratch `vite build --outDir`), as the e2e files that load it
 * directly honour; it stands in for this checkout's build (the default, or `ui/dist/index.html` named), never
 * for another page a test names.
 */
function servedPage(pagePath: string | undefined): string | undefined {
  const scratch = process.env["ARCHER_PAGE"];
  return scratch !== undefined && (pagePath === undefined || resolve(pagePath) === CHECKOUT_PAGE) ? scratch : pagePath;
}

export async function startTsProject(options: {
  readonly files: Record<string, string>;
  /** Offline durable-state seed before the singleton service starts; test fixture only. */
  readonly beforeService?: (stateDir: string, projectRoot: string) => Promise<void>;
  /** The page to serve; this checkout's build (ui/dist/index.html, `npm run build`) by default. */
  readonly pagePath?: string;
  readonly https?: boolean;
  /** Deterministic service lifecycle clock; browser waits still use real conditions. */
  readonly now?: () => number;
  /**
   * Whether the project draws the nested view (ADR 0029). Off by default here: the browser tests
   * written before it assert diagrams as written; `nested-view.e2e.ts` turns it on. An
   * `archer.toml` that states `nested_view` itself is left as it is.
   */
  readonly nestedView?: boolean;
  /**
   * The account's `comment_submission`. Unset, the service's default (each comment sent, decided 2026-10-29);
   * the contract suites set `queued`, the workflow the jsdom fake models.
   */
  readonly commentSubmission?: "queued" | "immediate";
}): Promise<TsProject> {
  const { startService } = await load<{ startService(o: unknown): Promise<Service> }>("service/service.ts");
  const { connectService } = await load<{ connectService(p: string): Promise<Client> }>("service/index.ts");
  const agent = await load<{
    createComment(
      project: unknown,
      target: TargetRef,
      anchor: Anchor,
      body: string,
    ): Promise<{ structured: Record<string, unknown> }>;
    replyComment(project: unknown, threadId: string, body: string, expectedRevision?: number): unknown;
    resolveComment(project: unknown, threadId: string, ...rest: unknown[]): unknown;
    getComments(
      project: unknown,
      target?: unknown,
      options?: { readonly asListener?: boolean },
    ): { structured: { threads?: unknown[] } };
  }>("comments/agent.ts");
  const { findProject } = await load<{ findProject(root: string): unknown }>("project/index.ts");
  const { NoteEmphasisStore } = await load<{
    NoteEmphasisStore: new (project: unknown) => { upsert(input: unknown, author: "agent"): NoteEmphasisRead };
  }>("notes/emphasis.ts");

  const state = realpathSync(mkdtempSync(join(tmpdir(), "archer-ui-state-")));
  const configPath = join(state, "instance.archer.toml");
  writeFileSync(
    configPath,
    options.commentSubmission === undefined
      ? "version = 1\n"
      : `version = 1\n[service]\ncomment_submission = "${options.commentSubmission}"\n`,
    { mode: 0o600 },
  );
  const writeProject = (files: Record<string, string>, nestedView = options.nestedView): string => {
    const at = realpathSync(mkdtempSync(join(tmpdir(), "archer-ui-proj-")));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(at, path)), { recursive: true });
      const off =
        path === "archer.toml" && nestedView !== true && !/^nested_view\s*=/m.test(text) && /^version = 1\n/.test(text);
      writeFileSync(join(at, path), off ? text.replace(/^version = 1\n/, "version = 1\nnested_view = false\n") : text);
    }
    return at;
  };
  const root = writeProject(options.files);
  await options.beforeService?.(state, root);
  const certificate =
    options.https === true
      ? await (
          await load<{
            setupLocalTls(options: {
              directory: string;
              host: string;
            }): Promise<{ tlsCert: string; tlsKey: string; caCert: string }>;
          }>("service/tls-setup.ts")
        ).setupLocalTls({ directory: join(state, "tls"), host: "127.0.0.1" })
      : undefined;
  const watchBefore = watcherUsage();
  const watchTrace: string[] = [];
  const serviceOptions = {
    host: "127.0.0.1",
    ...(certificate === undefined ? { forceHttp: true } : { tlsCert: certificate.tlsCert, tlsKey: certificate.tlsKey }),
    env: { ...process.env, HOME: state, ARCHER_CONFIG: configPath, ARCHER_OPEN_BROWSER: "never" },
    stateDir: state,
    socketPath: join(state, "archer.sock"),
    // Keep failures from the real watcher/reload path in Vitest/Playwright
    // output. Discarding these made a failed watcher indistinguishable from
    // a live stream that simply had no updates to send.
    log: (line: string) => {
      if (/watch|failed/i.test(line)) console.warn(line);
    },
    watchTrace: (line: string) => {
      watchTrace.push(`${performance.now().toFixed(1)} ${line}`);
      if (watchTrace.length > 16) watchTrace.shift();
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(servedPage(options.pagePath) === undefined ? {} : { pagePath: servedPage(options.pagePath)! }),
  };
  let svc = await startService(serviceOptions);
  let client = await connectService(svc.socketPath);

  /**
   * One attached project's handle. `lifecycle` is what only the service's first project does: restart and stop
   * the service itself; another project's stop detaches it.
   */
  const handle = async (
    at: string,
    lifecycle: { restart(this: void): Promise<void>; stop(this: void): Promise<void> } | undefined,
  ): Promise<TsProject> => {
    let { url: agentUrl } = (await client.call("attach", { root: at })) as { url: string };
    // The owner's browser session, signed in once on first use (a restart keeps it unless the address changed).
    let session: Promise<string> | undefined;
    const ownerCookie = (): Promise<string> => {
      session ??= signInCookie(agentUrl).catch((failure: unknown) => {
        session = undefined;
        throw failure;
      });
      return session;
    };
    const reattach = async (): Promise<void> => {
      const before = agentUrl;
      // A restarted service reopens saved projects after it answers: a call naming one waits a moment, then
      // answers project_loading (a loaded host takes longer than that wait). Attach again until it is open,
      // bounded by the test's own timeout, as recovery.e2e.ts does.
      for (;;) {
        try {
          ({ url: agentUrl } = (await client.call("attach", { root: at })) as { url: string });
          break;
        } catch (error) {
          if ((error as { error?: { code?: string } }).error?.code !== "project_loading") throw error;
        }
      }
      // A session is the service's, kept across its restart; a new address (another port, a new token) is a new one.
      if (agentUrl !== before) session = undefined;
    };
    reattachers.add(reattach);
    return {
      get agentUrl() {
        return agentUrl;
      },
      address(query) {
        return `${agentUrl}&${query.replace(/^[?&]/, "")}`;
      },
      api(path) {
        return new URL(path, apiBaseOf(agentUrl)).href;
      },
      async fetch(path, init) {
        return fetchAsOwner(new URL(path, apiBaseOf(agentUrl)).href, await ownerCookie(), init);
      },
      async call(method, params = {}) {
        return await client.call(method, { root: at, ...params });
      },
      async attachProject(files, attach) {
        const at = writeProject(files, attach?.nestedView ?? options.nestedView);
        await attach?.prepare?.(at);
        return handle(at, undefined);
      },
      async restart() {
        await (lifecycle ?? first).restart();
      },
      ...(certificate === undefined ? {} : { caCert: certificate.caCert }),
      async issueAccess(label) {
        return (await client.call("issueAccess", { label })) as { id: string; token: string; url: string };
      },
      async issueAuthoringAccess(label) {
        return (await client.call("issueAuthoringAccess", { label, projectRoots: [at] })) as {
          id: string;
          token: string;
          url: string;
        };
      },
      async revokeAccess(grantId) {
        await client.call("revokeAccess", { grantId });
      },
      async issuePairingCode() {
        return (await client.call("issuePairingCode", {})) as {
          code: string;
          url: string;
          minutes: number;
          expiresAt: string;
        };
      },
      async listAccess() {
        return (
          (await client.call("listAccess", {})) as {
            grants: { id: string; label: string; revokedAt: string | null }[];
          }
        ).grants;
      },
      get url() {
        return agentUrl;
      },
      root: at,
      configPath,
      async reading() {
        return (
          (
            (await client.call("getContext", { root: at })) as {
              walkthrough?: { viewId: string; id: string; step: number } | null;
            }
          ).walkthrough ?? null
        );
      },
      async present(viewId, annotation, walkthrough) {
        await client.call("present", {
          root: at,
          viewId,
          ...(annotation === undefined ? {} : { annotation }),
          ...(walkthrough === undefined ? {} : { walkthrough }),
        });
      },
      async agentWrite(viewId, path, text, summary) {
        await client.call("recordWrite", { root: at, viewId, ...(summary === undefined ? {} : { summary }) });
        writeFileSync(join(at, path), text);
      },
      async selection() {
        const { selection } = (await client.call("getContext", { root: at })) as {
          selection: Awaited<ReturnType<TsProject["selection"]>>;
        };
        return selection;
      },
      async setEmphasis(viewId, emphases) {
        await client.call("setEmphasis", { root: at, viewId, emphases });
      },
      async agentCreateComment(target, anchor, body) {
        const answer = await agent.createComment(findProject(at), target, anchor, body);
        return answer.structured as unknown as Thread;
      },
      async agentSetNoteEmphasis(input) {
        return new NoteEmphasisStore(findProject(at)).upsert(input, "agent");
      },
      async agentReply(threadId, body, expectedRevision) {
        refused(agent.replyComment(findProject(at), threadId, body, expectedRevision));
      },
      async agentResolve(threadId, expectedRevision, note) {
        refused(
          agent.resolveComment(findProject(at), threadId, expectedRevision, ...(note === undefined ? [] : [note])),
        );
      },
      async agentInbox() {
        return agent.getComments(findProject(at), undefined, { asListener: true }).structured.threads ?? [];
      },
      async stop() {
        reattachers.delete(reattach);
        if (lifecycle !== undefined) {
          await lifecycle.stop();
          return;
        }
        await client.call("detach", { root: at });
        rmSync(at, { recursive: true, force: true });
      },
    };
  };
  /** Every attached project's re-attach after a restart. */
  const reattachers = new Set<() => Promise<void>>();
  const first = {
    async restart() {
      client.close();
      await svc.close();
      svc = await startService({ ...serviceOptions, restoreState: true });
      client = await connectService(svc.socketPath);
      for (const reattach of reattachers) await reattach();
    },
    async stop() {
      client.close();
      const watchBeforeClose = watcherUsage();
      await svc.close();
      // One bounded record per fixture, including successful cases: a missing
      // notification can now be located before or after the native callback.
      console.warn(
        `[archer] watcher diagnostics ${JSON.stringify({ root, before: watchBefore, beforeClose: watchBeforeClose, afterClose: watcherUsage(), trace: watchTrace })}`,
      );
      rmSync(state, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
  return handle(root, first);
}
