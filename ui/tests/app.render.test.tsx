// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { DIMMED_OPACITY, FOCUSED_OPACITY } from "../src/diagrams/focus-style";
import { loadValidFixture } from "./fixtures";

/**
 * Drives the real host bridge, not a test-local stand-in: `App` calls
 * `connectBridge` on mount, and jsdom serves this file over `http:`, so
 * production routes it to the HTTP fallback transport. Presentations therefore
 * arrive the way the browser-served build receives them -- as a `presentation`
 * event on `api/events` -- and travel the whole production path
 * (bridge -> projection -> layout -> canvas).
 *
 * Only `fetch` and `EventSource` are faked, because jsdom implements neither.
 * The URLs and event name they are called with are pinned in
 * `host-bridge.test.ts` against the same production function.
 */
class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly close = vi.fn();
  private readonly listeners = new Map<string, (event: { data: string }) => void>();
  onerror: ((event: unknown) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

const CONNECTION_INFO = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: [],
  applicationVersion: "0.1.0",
  semanticSchemaVersion: 2,
};

/** The snapshot shape `api/bootstrap` and the `presentation` event both carry. */
function snapshot(envelope: unknown, presentation?: unknown): unknown {
  return { envelope, presentation: presentation ?? null, diagnostics: [] };
}

/**
 * Answers both read routes: the presentation snapshot and the registry. The
 * registry defaults to empty because these tests drive presentations down the
 * SSE stream rather than through the inventory -- but it must be ANSWERED, or
 * the page is in the "cannot list the diagrams" state, which is a different
 * fact with a different message.
 */
function stubBootstrap(body: unknown, inventory: unknown = { schemaVersion: 1, views: [] }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url === "api/connection"
              ? CONNECTION_INFO
              : url === "api/compile"
                ? { schemaVersion: 1, failures: [] }
                : url === "api/diagrams"
                  ? inventory
                  : url.startsWith("api/emphasis/")
                    ? { schemaVersion: 1, viewId: decodeURIComponent(url.slice("api/emphasis/".length)), emphases: [] }
                    : body,
          ),
      }),
    ),
  );
}

/** Pushes a snapshot down the SSE stream the mounted App is subscribed to. */
async function present(envelope: unknown, presentation?: unknown): Promise<void> {
  const source = MockEventSource.instances.at(-1);
  expect(source, "App did not subscribe to the presentation stream").toBeDefined();
  await act(async () => {
    source!.emit("presentation", snapshot(envelope, presentation));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Returns the canvas transform React Flow renders the user's pan and zoom as.
 * This is the only place the viewport is observable from the DOM, so viewport
 * behaviour is asserted through it rather than through reducer state -- a
 * reducer field no renderer reads can be arbitrarily wrong and still "pass".
 */
function viewportTransform(container: HTMLElement): string {
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
  expect(viewport, "no React Flow viewport is mounted").not.toBeNull();
  return viewport!.style.transform;
}

/** The transform of a canvas React Flow has not framed yet. */
const UNFRAMED = "translate(0px,0px) scale(1)";

/**
 * React Flow frames a freshly mounted canvas once its pan/zoom instance is up,
 * which is a tick after the nodes render. Tests that compare framings have to
 * wait for that, or they race it.
 */
async function waitForInitialFit(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(viewportTransform(container)).not.toBe(UNFRAMED);
  });
}

/** Zooms the canvas the way a user does, so a later refit is detectable. */
async function zoomCanvas(container: HTMLElement): Promise<void> {
  await waitForInitialFit(container);
  const pane = container.querySelector<HTMLElement>(".react-flow__pane");
  expect(pane, "no React Flow pane is mounted").not.toBeNull();
  const before = viewportTransform(container);
  await act(async () => {
    pane!.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -200,
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(viewportTransform(container), "the wheel did not move the canvas").not.toBe(before);
}

/** The same fixture at a new revision, with one node and edge appended. */
function editedDataFlow(revision: string): unknown {
  const edited = loadValidFixture("minimal-data-flow.json") as {
    revision: string;
    model: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  };
  edited.revision = revision;
  edited.model.nodes.push({ id: "ledger", label: "Ledger", shape: "rectangle" });
  edited.model.edges.push({ id: "writes", source: "api", target: "ledger", label: "writes" });
  return edited;
}

const NEXT_REVISION = "sha256:0000000000000000000000000000000000000000000000000000000000000001";

type PublishedSelection = {
  revision?: string;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
};

/** Records every selection the page publishes to `api/selection`. */
function capturePosts(): PublishedSelection[] {
  const posts: PublishedSelection[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { body?: string }) => {
      if (url.endsWith("api/selection") && init?.body !== undefined) {
        posts.push(JSON.parse(init.body) as PublishedSelection);
      }
      const body =
        url === "api/connection"
          ? CONNECTION_INFO
          : url === "api/compile"
            ? { schemaVersion: 1, failures: [] }
            : url === "api/diagrams"
              ? { schemaVersion: 1, views: [] }
              : url.startsWith("api/emphasis/")
                ? { schemaVersion: 1, viewId: decodeURIComponent(url.slice("api/emphasis/".length)), emphases: [] }
                : null;
      return Promise.resolve({
        ok: true,
        status: url === "api/selection" ? 204 : 200,
        json: () => Promise.resolve(body),
      });
    }),
  );
  return posts;
}

async function clickNode(container: HTMLElement, id: string): Promise<void> {
  const node = await waitFor(() => {
    const found = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  fireEvent.click(node);
}

async function renderApp(): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return result;
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  // No presentation yet: the server answers `api/bootstrap` with `null`.
  stubBootstrap(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App", () => {
  // "Nothing is registered" is a specific claim, and the page now makes it
  // rather than showing a blank canvas an agent could be believed over. The
  // fetch stub answers the inventory route properly, because "we could not
  // list the diagrams" is a DIFFERENT state with its own message.
  it("says the registry is empty before any diagram arrives", async () => {
    stubBootstrap(null, { schemaVersion: 1, views: [] });
    await renderApp();
    expect(await screen.findByText("No diagrams or notes yet.")).toBeInTheDocument();
  });

  it("renders a graph canvas when the host presents an architecture diagram", async () => {
    await renderApp();
    await present(loadValidFixture("minimal-architecture.json"), {
      presentationId: "p1",
      viewId: "system-context",
    });

    expect(await screen.findByText("Web")).toBeInTheDocument();
    expect(screen.queryByText("No diagram selected")).not.toBeInTheDocument();
  });

  it.each([
    ["Compare revisions", "Compare Revisions"],
    ["Export diagram", "Export Diagram"],
    ["Check diagram accuracy", "Diagram Accuracy"],
  ])("returns focus to the permanent graph-tools wrench after closing %s", async (action, heading) => {
    const envelope = loadValidFixture("minimal-architecture.json");
    stubBootstrap({
      ...(snapshot(envelope, { presentationId: "p1", viewId: "system-context" }) as object),
      capabilities: { comments: true },
    });
    await renderApp();
    const wrench = await screen.findByRole("button", { name: "Export, compare and more" });
    fireEvent.click(wrench);
    fireEvent.click(screen.getByRole("button", { name: action }));
    const panel = (await screen.findByRole("heading", { name: heading })).closest("section");
    expect(panel).not.toBeNull();
    fireEvent.click(within(panel!).getByRole("button", { name: "Close" }));
    expect(wrench).toHaveFocus();
  });

  it("renders nodes and edges when the host presents a data-flow diagram", async () => {
    const { container } = await renderApp();
    await present(loadValidFixture("minimal-data-flow.json"));

    expect(await screen.findByText("Web")).toBeInTheDocument();
    expect(await screen.findByText("API")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge[data-id="request"]')).not.toBeNull();
    });
  });

  it("renders the sequence canvas when the host presents a sequence trace", async () => {
    await renderApp();
    await present(loadValidFixture("minimal-sequence.json"));

    expect(await screen.findByLabelText("Sequence diagram canvas")).toBeInTheDocument();
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("POST /login")).toBeInTheDocument();
  });

  it("swaps the canvas when a second diagram is presented", async () => {
    await renderApp();
    await present(loadValidFixture("minimal-data-flow.json"));
    expect(await screen.findByText("API")).toBeInTheDocument();

    await present(loadValidFixture("minimal-sequence.json"));
    expect(await screen.findByLabelText("Sequence diagram canvas")).toBeInTheDocument();
    expect(screen.queryByText("API")).not.toBeInTheDocument();
  });

  // Live reload: the watcher re-presents the *same* view under a new revision.
  // The layout cache is keyed on the presentation reducer's layoutGeneration,
  // which used to move only on a view change, so the canvas replayed the
  // pre-edit layout and the user's saved edit never appeared on screen.
  it("redraws the same view when its model is re-presented at a new revision", async () => {
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("API")).toBeInTheDocument();

    await present(editedDataFlow(NEXT_REVISION), command);

    expect(await screen.findByText("Ledger")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('.react-flow__node[data-id="ledger"]')).not.toBeNull();
    });
  });

  // The cached layout is the picture of one model in one direction. The cache
  // is keyed on the revision, which a direction edit normally moves -- but the
  // direction is what the layout was COMPUTED from, so it is part of the key
  // in its own right rather than by courtesy of the hash.
  it("lays the view out again when only its direction changes", async () => {
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };
    const placed = (id: string): { x: number; y: number } => {
      const node = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      expect(node, `node ${id} is not drawn`).not.toBeNull();
      const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node!.style.transform)!;
      return { x: Number(x), y: Number(y) };
    };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    await screen.findByText("API");
    // `web --> api`, top to bottom by default: one column.
    expect(placed("api").x).toBe(placed("web").x);
    expect(placed("api").y).toBeGreaterThan(placed("web").y);

    const sideways = loadValidFixture("minimal-data-flow.json") as { model: { direction?: string } };
    sideways.model.direction = "lr";
    await present(sideways, command);

    await waitFor(() => {
      expect(placed("api").y).toBe(placed("web").y);
      expect(placed("api").x).toBeGreaterThan(placed("web").x);
    });
  });

  // Layout for the new revision is async, and the canvas used to drop to a
  // "Loading..." message while it ran. That unmounts React Flow, so the user
  // watched their diagram vanish on every save. The canvas already on screen
  // is still a truthful drawing of the view until the new one is ready, so it
  // stays mounted; element identity is the assertion because a remount is
  // exactly what a blank frame costs.
  it("keeps the current diagram mounted while a live-reload layout computes", async () => {
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("API")).toBeInTheDocument();
    const mounted = container.querySelector<HTMLElement>(".react-flow");
    expect(mounted).not.toBeNull();

    await present(editedDataFlow(NEXT_REVISION), command);
    await screen.findByText("Ledger");

    expect(mounted!.isConnected, "React Flow was unmounted during the redraw").toBe(true);
    expect(container.querySelector(".react-flow")).toBe(mounted);
  });

  // The edit is the reason for the redraw, so the frame the user chose has to
  // survive it: pan into a corner, save one character, and you must still be
  // looking at that corner.
  it("preserves pan and zoom across a live-reload redraw of the same view", async () => {
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("API")).toBeInTheDocument();
    await zoomCanvas(container);
    const zoomed = viewportTransform(container);

    await present(editedDataFlow(NEXT_REVISION), command);
    await screen.findByText("Ledger");

    expect(viewportTransform(container)).toBe(zoomed);
  });

  // `preserve` is the default for a redraw, so an explicit `fit-all` is the
  // only way a host can pull a lost user back to the whole diagram.
  it("re-frames the whole diagram when the host asks for fit-all", async () => {
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("API")).toBeInTheDocument();
    await waitForInitialFit(container);
    const fitted = viewportTransform(container);
    await zoomCanvas(container);

    // Same model, new stamp: the only thing under test is the framing.
    const reloaded = loadValidFixture("minimal-data-flow.json") as { revision: string };
    reloaded.revision = NEXT_REVISION;
    await present(reloaded, { ...command, viewport: "fit-all" });

    await waitFor(() => {
      expect(viewportTransform(container)).toBe(fitted);
    });
  });

  // `present_diagram` advertises a `viewport` parameter, and `fit-focus` is
  // the default whenever the host focuses something on the view already shown.
  // Honouring it means re-framing the canvas onto the focused node.
  it("re-frames the canvas onto the focus when the host focuses a node", async () => {
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("Web")).toBeInTheDocument();
    await zoomCanvas(container);
    const zoomed = viewportTransform(container);

    await present(loadValidFixture("minimal-data-flow.json"), {
      ...command,
      focus: { nodeIds: ["web"], edgeIds: [] },
    });

    await waitFor(() => {
      expect(viewportTransform(container)).not.toBe(zoomed);
    });
  });

  // The selection the page publishes is stamped with the revision it belongs
  // to, and the server rejects a stale one with HTTP 409. A live-reload redraw
  // has to move that stamp forward, or every click after the first saved edit
  // is thrown away.
  it("publishes a selection stamped with the revision it was made against", async () => {
    const posts = capturePosts();

    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };
    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("API")).toBeInTheDocument();

    const edited = loadValidFixture("minimal-data-flow.json") as { revision: string };
    const newRevision = "sha256:0000000000000000000000000000000000000000000000000000000000000002";
    edited.revision = newRevision;
    await present(edited, command);

    posts.length = 0;
    const node = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.react-flow__node[data-id="web"]');
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
    fireEvent.click(node);

    await waitFor(() => {
      expect(posts.length).toBeGreaterThan(0);
    });
    expect(posts.at(-1)?.revision).toBe(newRevision);
  });

  // Stable IDs exist so a node keeps its identity across an unrelated edit.
  // Dropping the selection on every save would throw away the user's place for
  // a reason that has nothing to do with what they selected, so a surviving
  // node stays selected -- re-published under the new revision, because the
  // host rejects a selection stamped with the revision it no longer holds.
  it("keeps a selected node selected across a live reload that did not touch it", async () => {
    const posts = capturePosts();
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };
    await present(loadValidFixture("minimal-data-flow.json"), command);
    await clickNode(container, "web");
    await waitFor(() => {
      expect(posts.at(-1)?.nodes).toHaveLength(1);
    });

    posts.length = 0;
    await present(editedDataFlow(NEXT_REVISION), command);
    await screen.findByText("Ledger");

    await waitFor(() => {
      expect(posts.length).toBeGreaterThan(0);
    });
    const republished = posts.at(-1)!;
    expect(republished.revision).toBe(NEXT_REVISION);
    expect(republished.nodes).toEqual([{ id: "web", label: "Web" }]);
  });

  // The deleted-node half of this rule is covered in `selection.test.ts`
  // instead: React Flow reports the removal through `onSelectionChange` on its
  // own, so the canvas ends up in the same place whether or not the reducer
  // drops the ID, and an assertion here would pass without the code it claims
  // to guard.

  it("shows the empty state when the bootstrap reports no current presentation", async () => {
    // The bootstrap `null` is the one production input that reaches
    // `App.handleClear`; the SSE stream only ever carries snapshots.
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url === "api/connection"
              ? CONNECTION_INFO
              : url === "api/compile"
                ? { schemaVersion: 1, failures: [] }
                : url === "api/diagrams"
                  ? { schemaVersion: 1, views: [] }
                  : null,
          ),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(fetchMock).toHaveBeenCalledWith(
      "api/bootstrap",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText("No diagrams or notes yet.")).toBeInTheDocument();
  });

  it("applies a host focus set to the view it is already showing", async () => {
    // Exercises the full production path App.handlePresent takes on a
    // focus-only update: projectEnvelope -> isPresentationCommand -> the
    // presentation reducer (no page turn, no layout generation bump) -> the
    // cached-layout branch -> xflow-adapter focus styling.
    const { container } = await renderApp();
    const command = { presentationId: "p1", viewId: "request-flow" };

    await present(loadValidFixture("minimal-data-flow.json"), command);
    expect(await screen.findByText("Web")).toBeInTheDocument();

    await present(loadValidFixture("minimal-data-flow.json"), {
      ...command,
      focus: { nodeIds: ["web"], edgeIds: [] },
    });

    await waitFor(() => {
      const web = container.querySelector<HTMLElement>('.react-flow__node[data-id="web"]');
      const api = container.querySelector<HTMLElement>('.react-flow__node[data-id="api"]');
      expect(web?.style.opacity).toBe(`${FOCUSED_OPACITY}`);
      expect(api?.style.opacity).toBe(`${DIMMED_OPACITY}`);
    });
  });

  it("surfaces a projection failure instead of a canvas", async () => {
    await renderApp();
    const broken = loadValidFixture("minimal-data-flow.json") as {
      model: { edges: Array<Record<string, unknown>> };
    };
    broken.model.edges.push({ id: "dangling", source: "web", target: "ghost" });

    await present(broken);

    expect(await screen.findByText(/ghost|dangling|edge/i)).toBeInTheDocument();
    expect(screen.queryByText("No diagram selected")).not.toBeInTheDocument();
  });
});
