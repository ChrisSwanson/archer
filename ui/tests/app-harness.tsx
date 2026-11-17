/**
 * Mounting the real `App` over a stubbed HTTP host.
 *
 * Shared because the AGENT-PRESENTED path is the one most tests are about and
 * the one that is easy to miss: entering through a tab click makes the view a
 * tab the reader picked, whose selections are stamped `reader:<viewId>` rather
 * than with an agent presentation (`App.tsx`, ADR 0011), so a test that mounts
 * the easy way exercises a different stamp from the one it appears to.
 *
 * `vi.mock("@modelcontextprotocol/ext-apps", …)` is deliberately NOT here:
 * `vi.mock` is hoisted per test FILE, so it has to be declared in each one.
 */
import { SELECTION_SEND_INTERVAL_MS } from "../src/app/selection-sender.ts";
import { act, render, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { JSX } from "react";

export type Listener = (event: { data: string }) => void;

/** An `EventSource` whose server-sent events the test can emit by hand. */
export class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Listener>();
  onerror: ((event: unknown) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) });
  }
}

const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, "location")!;

/** The web shell is chosen by protocol, so the page has to look served. */
export function serveOverHttp(): void {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? "http:" : Reflect.get(target, key)),
    }),
  });
}

export function restoreLocation(): void {
  Object.defineProperty(window, "location", REAL_LOCATION);
}

export const VIEWS = [{ id: "alpha", kind: "c4-context", title: "Alpha", registration: "durable" as const }];

/** Two nodes and an edge, so "select everything" has something to mean. */
export const ENVELOPE = {
  schemaVersion: 2,
  view: { id: "alpha", kind: "data-flow", title: "Alpha" },
  revision: `sha256:${"a".repeat(64)}`,
  model: {
    type: "data-flow-graph",
    nodes: [
      { id: "web", label: "Web" },
      { id: "api", label: "API" },
    ],
    edges: [{ id: "calls", source: "web", target: "api", label: "calls" }],
    groups: [],
  },
};

export type Routes = {
  /**
   * The reader's view of a diagram with containers (ADR 0029). "full" by default: these page tests
   * select boundaries and count the model's elements, as written.
   */
  readonly nestMode?: "nested" | "full";
  readonly emphases?: readonly unknown[];
  /** The comment threads `api/comments?target=view:alpha` lists (the page must be told it may comment, in `bootstrap`). */
  readonly threads?: readonly unknown[];
  /** What `api/walkthroughs` answers; absent, the diagram has none (an answer the page cannot read). */
  readonly walkthroughs?: unknown;
  /** What `api/bootstrap` answers when the page opens (a presentation standing before it did); absent, nothing is presented. */
  readonly bootstrap?: unknown;
  /** Extra fields of the agent's presentation (a caption, a walkthrough step). */
  readonly presentation?: Readonly<Record<string, unknown>>;
  /**
   * The envelope every diagram fetch and the presentation event carry.
   * Defaults to the two-node graph above. Pass a real protocol fixture rather
   * than a hand-written shape (see `loadValidFixture`).
   */
  readonly envelope?: unknown;
  /**
   * What "the diagram is on screen" means for that envelope. Defaults to the
   * graph's two React Flow nodes, which a sequence view never renders.
   */
  readonly ready?: (container: HTMLElement) => void;
  /** The registered views `api/diagrams` lists. Defaults to `VIEWS`. */
  readonly views?: readonly unknown[];
  /**
   * What `api/compile` answers when the page opens. Defaults to "nothing is
   * failing", which is what a healthy workspace answers.
   */
  readonly compile?: unknown;
};

/** The `id` the envelope's view carries, which the presentation must name. */
function envelopeViewId(envelope: unknown): string {
  return (envelope as { view: { id: string } }).view.id;
}

let fetchSpy: ReturnType<typeof vi.fn>;

/** A current service's `api/connection` answer (every service since 0.15.0 has the route). */
export const CONNECTION = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: [],
  applicationVersion: "0.1.0",
  semanticSchemaVersion: 2,
};

export function stubRoutes(routes: Routes = {}): void {
  const envelope = routes.envelope ?? ENVELOPE;
  fetchSpy = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    // A new comment arrives as an ADR 0016 operation, and is answered with its acknowledgement.
    const sent =
      url === "api/comments" && init?.method === "POST"
        ? (JSON.parse(init.body ?? "{}") as {
            operation: { id: string; issuedAt: number; name: string };
            payload: { target: string; anchor: unknown; body: string };
          })
        : undefined;
    const body =
      sent !== undefined
        ? {
            operation: { id: sent.operation.id, issuedAt: sent.operation.issuedAt, name: sent.operation.name },
            replayed: false,
            committed: { threadId: "t-new", commentId: "c-new", revision: 1, committedAt: "2026-10-23T10:00:00.000Z" },
            thread: {
              id: "t-new",
              target: sent.payload.target,
              anchor: sent.payload.anchor,
              status: "draft",
              revision: 1,
              comments: [
                { id: "c-new", author: "person", body: sent.payload.body, createdAt: "2026-10-23T10:00:00.000Z" },
              ],
            },
          }
        : url.startsWith("api/comments?")
          ? { schemaVersion: 2, target: "view:alpha", threads: routes.threads ?? [] }
          : url === "api/comments/pending"
            ? { total: 0, targets: [] }
            : url === "api/connection"
              ? CONNECTION
              : url === "api/bootstrap"
                ? (routes.bootstrap ?? null)
                : url === "api/diagrams"
                  ? { schemaVersion: 1, views: routes.views ?? VIEWS }
                  : url === "api/compile"
                    ? (routes.compile ?? { schemaVersion: 1, failures: [] })
                    : url.startsWith("api/diagrams/")
                      ? envelope
                      : url.startsWith("api/emphasis/")
                        ? { schemaVersion: 1, viewId: "alpha", emphases: routes.emphases ?? [] }
                        : url.startsWith("api/walkthroughs?")
                          ? (routes.walkthroughs ?? null)
                          : null;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchSpy);
}

/** Every URL this page has requested, in order. */
export function fetchCalls(): string[] {
  return fetchSpy.mock.calls.map(([url]) => url as string);
}

/** Every selection this page has published to the host. */
export function selectionPosts(): unknown[] {
  return fetchSpy.mock.calls.filter(([url]) => url === "api/selection");
}

/** Every walkthrough position this page has told the host, as sent. */
export function readingPosts(): unknown[] {
  return fetchSpy.mock.calls
    .filter(([url]) => url === "api/walkthrough-position")
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

export type Mounted = {
  readonly container: HTMLElement;
  readonly source: MockEventSource;
};

/**
 * Mounts the page with a diagram the AGENT presented, so the publish path is
 * live: a selection made here really would be sent to the host.
 */
export async function mountAgentPresented(app: JSX.Element, routes: Routes = {}): Promise<Mounted> {
  try {
    window.localStorage.setItem("archer.nest.mode", routes.nestMode ?? "full");
  } catch {
    /* none in this environment */
  }
  serveOverHttp();
  stubRoutes(routes);
  const { container } = render(app);

  const source = MockEventSource.instances[0];
  await waitFor(() => expect(source).toBeDefined());

  await act(async () => {
    source.onopen?.(new Event("open"));
  });
  const envelope = routes.envelope ?? ENVELOPE;
  act(() => {
    source.emit("presentation", {
      envelope,
      // The presented id must be the envelope's own, or `App` holds the
      // projection back and nothing is ever laid out.
      presentation: { presentationId: "agent-run", viewId: envelopeViewId(envelope), ...routes.presentation },
      diagnostics: [],
    });
  });

  const ready =
    routes.ready ??
    ((mounted: HTMLElement) => {
      expect(mounted.querySelectorAll(".react-flow__node").length).toBe(2);
    });
  await waitFor(() => ready(container));
  return { container, source };
}

export const selectedNodes = (container: HTMLElement): number =>
  container.querySelectorAll(".react-flow__node.selected").length;

/**
 * Every node id this page has ever told the host was selected.
 *
 * Counting posts alone is not enough: React Flow reports an empty selection
 * when the canvas mounts and again when it unmounts, so a page can publish
 * without ever naming a node. What must never appear is an id.
 */
export function publishedNodeIds(posts: readonly unknown[]): string[] {
  return posts.flatMap((post) => {
    const [, init] = post as [string, { body: string }];
    const body = JSON.parse(init.body) as { nodes: { id: string }[] };
    return body.nodes.map((node) => node.id);
  });
}

/** Every edge id this page has ever told the host was selected. */
export function publishedEdgeIds(posts: readonly unknown[]): string[] {
  return posts.flatMap((post) => {
    const [, init] = post as [string, { body: string }];
    const body = JSON.parse(init.body) as { edges?: { id: string }[] };
    return (body.edges ?? []).map((edge) => edge.id);
  });
}

/** Lets pending microtasks settle, so "nothing happened" is a real answer. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Waits out the selection publication window (selection-sender.ts), so the last selection has been posted. */
export const settleSelection = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, SELECTION_SEND_INTERVAL_MS + 20));
