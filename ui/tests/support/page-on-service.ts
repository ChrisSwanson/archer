/**
 * The page in jsdom, served by the real service (`ts-service.ts`): the owner's browser, in small.
 *
 * The page sits at its project's follow address (`/projects/<name>/?follow`), signed in once as a browser is
 * (the agent link's `?token=` exchanged for the session cookie), and every request it makes goes to the service
 * with that cookie and, on a write, the page's Origin -- what a browser would send.
 *
 * Its event stream is the service's own (`api/events`), read over real HTTP: every event the service publishes
 * reaches the page, in the service's order, inside `act` (React would otherwise warn of updates it did not see).
 * A test that drives event order by hand can still `emit` one, or `hold` the stream to stand for one that is down.
 */
import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { Anchor, TargetRef, Thread } from "../../src/comments/contract";
import { httpCommentsTransport } from "../../src/comments/transport";
import { serveOverHttp } from "../app-harness";
import { commentWrites } from "./comment-writes";
import { fetchAsOwner, signInCookie, type TsProject } from "./ts-service";

type Listener = (event: { data: string; type: string }) => void;

const parsed = (data: string): unknown => {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
};

/** One stream the page opened, read from the service; `instances` holds them in the order the page opened them. */
export class ServiceEventSource {
  static instances: ServiceEventSource[] = [];
  /** Set by `pageOnService`: where a URL the page names lands on the service, and the owner's cookie. */
  static resolve: (href: string) => URL = (href) => new URL(href);
  static cookie = "";
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #abort = new AbortController();
  #held = false;
  /** Every event handed to the page, in order: the type and its data, parsed. */
  readonly received: { readonly type: string; readonly data: unknown }[] = [];
  /** Settles when the stream has ended (closed, failed or aborted). */
  readonly ended: Promise<void>;

  constructor(readonly url: string) {
    ServiceEventSource.instances.push(this);
    this.ended = this.#read();
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
    this.#abort.abort();
  }

  /** An event the test sends by hand, as though the service had: for a test that orders events itself. */
  emit(type: string, payload: unknown): void {
    this.#dispatch(type, JSON.stringify(payload));
  }

  /** While held, what the service sends is dropped: the stream stands for one that is down. */
  hold(held: boolean): void {
    this.#held = held;
  }

  #dispatch(type: string, data: string): void {
    const event = { type, data };
    this.received.push({ type, data: parsed(data) });
    act(() => {
      for (const listener of this.#listeners.get(type) ?? []) listener(event);
      if (type === "message") this.onmessage?.(event);
    });
  }

  async #read(): Promise<void> {
    try {
      const response = await fetchAsOwner(ServiceEventSource.resolve(this.url).href, ServiceEventSource.cookie, {
        headers: { accept: "text/event-stream" },
        signal: this.#abort.signal,
      });
      if (!response.ok || response.body === null) throw new Error(`api/events: ${response.status}`);
      if (this.readyState === 2) return;
      this.readyState = 1;
      act(() => this.onopen?.({ type: "open" }));
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
          let type = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") type = value;
            else if (field === "data") data.push(value);
          }
          if (data.length > 0 && !this.#held && this.readyState !== 2) this.#dispatch(type, data.join("\n"));
        }
      }
    } catch {
      if (this.readyState === 2) return;
    }
    if (this.readyState === 2) return;
    this.readyState = 2;
    act(() => this.onerror?.({ type: "error" }));
  }
}

export type PageOnService = {
  /** The streams the page opened, oldest first. */
  readonly streams: readonly ServiceEventSource[];
  /** Every request the page made, as it named it (`api/…` from `/`), in order. */
  readonly requests: readonly string[];
  /** Closes every stream and waits out every request still in flight: call before the service stops. */
  close(): Promise<void>;
};

/**
 * Puts the page at `project`'s follow address (or `path`, on the same origin), signed in, with `fetch` and
 * `EventSource` reaching the service. Call before `render(<App />)`; `close` it in `afterEach`, after `cleanup`.
 */
export async function pageOnService(
  project: TsProject,
  options: {
    path?: string;
    /**
     * A fault between the page and the service: the answer to a request (by its path on the service, query
     * included) when it is not to reach the service, say a 500 the service gives only when something breaks.
     */
    fault?: (path: string) => Response | undefined;
  } = {},
): Promise<PageOnService> {
  const agent = new URL(project.agentUrl);
  const cookie = await signInCookie(project.agentUrl);
  /**
   * Where a request the page makes lands on the service. At a browser route the page names its project's routes
   * itself (`/p/<name>/api/…`); anywhere else (`/`, where these tests have long mounted it so its navigation stays
   * in the page) it asks `api/…` relative, which is its project's.
   */
  const resolveRequest = (href: string): URL => {
    const at = /^[a-z]+:|^\//i.test(href) ? new URL(href, window.location.href) : new URL(href, project.api(""));
    return new URL(at.pathname + at.search, agent.origin);
  };
  ServiceEventSource.instances = [];
  ServiceEventSource.cookie = cookie;
  window.history.replaceState(null, "", options.path ?? `${agent.pathname}?follow`);
  serveOverHttp();
  ServiceEventSource.resolve = resolveRequest;
  const inFlight = new Set<Promise<unknown>>();
  const requests: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(href);
    const at = resolveRequest(href);
    const faulted = options.fault?.(at.pathname + at.search);
    if (faulted !== undefined) return Promise.resolve(faulted);
    // Read to the end before answering, as the page will: a body still streaming when the service stops is
    // a late ECONNRESET after the test has finished.
    const request = fetchAsOwner(at.href, cookie, init).then(async (response) => {
      await response
        .clone()
        .arrayBuffer()
        .catch(() => undefined);
      return response;
    });
    const settled: Promise<unknown> = request.then(
      () => inFlight.delete(settled),
      () => inFlight.delete(settled),
    );
    inFlight.add(settled);
    return request;
  });
  vi.stubGlobal("EventSource", ServiceEventSource);
  return {
    get streams() {
      return ServiceEventSource.instances;
    },
    requests,
    async close() {
      for (const stream of ServiceEventSource.instances) stream.close();
      await act(async () => {
        await Promise.allSettled(ServiceEventSource.instances.map((stream) => stream.ended));
        while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      });
    },
  };
}

/** The Mermaid of the fake's old `SYSTEM_VIEW`: a web app, and an API and database in a Backend group. */
export const SYSTEM_MMD =
  "flowchart LR\n  web[Web app] e1@-->|HTTPS| api\n  subgraph backend[Backend]\n    api[API]\n    db[(Database)]\n  end\n  api e2@--> db\n";

/**
 * The owner's comments, read and written as their page does: the page's own HTTP transport over the signed-in
 * browser's session, and its writes as ADR 0016 operations. What a test sets up through it is what another tab
 * of the person's would have written.
 */
export function ownerComments(project: TsProject) {
  const transport = httpCommentsTransport((url, init) => project.fetch(url, init));
  const writes = commentWrites(transport);
  return {
    transport,
    ...writes,
    /** A draft the person wrote elsewhere: on the whole of `target` unless an anchor is given. */
    draft: (target: TargetRef, body: string, anchor: Anchor = { kind: "view" }): Promise<Thread> =>
      writes.createThread({ target, anchor, body }),
    /** The threads on `target`, as the page lists them. */
    list: async (target: TargetRef): Promise<readonly Thread[]> => (await transport.listThreads(target)).threads,
  };
}

/**
 * The project of the service a jsdom file starts once, in `beforeAll`, each test then attaching its own project
 * to it (`attachProject`). Empty, so nothing it lists is mistaken for a test's: the page's project directory names
 * every attached project, as it would for an owner with several.
 */
export const SERVICE_HOME: Record<string, string> = { "archer.toml": "version = 1\n" };

/** One `[[views]]` entry, its source at `.archer/<id>.mmd`. */
export const viewEntry = (id: string, title: string, kind = "freeform"): string =>
  `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${title}"\nsource = ".archer/${id}.mmd"\n\n`;
