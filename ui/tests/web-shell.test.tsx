import { SELECTION_SEND_INTERVAL_MS } from "../src/app/selection-sender.ts";
import { fileButton, filesTable, projectFiles } from "./support/primary-navigation";
// @vitest-environment jsdom
//
// TWO shells over one diagram stage (ADR-0004). The MCP-App view and the
// browser-served page consume the same envelope and the same presentation
// state; the only difference is the chrome wrapped around the canvas. These tests drive the
// real page shell (`PageShell`) through the real `connectBridge`, so the shell that renders is
// the one the transport decision actually selects -- not one a test picked.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  callServerTool: vi.fn(() => Promise.resolve({ content: [] })),
  close: vi.fn(() => Promise.resolve()),
  connect: vi.fn(() => Promise.resolve()),
  toolResultHandler: undefined as ((result: unknown) => void) | undefined,
  updateModelContext: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(event: string, handler: (result: unknown) => void): void {
      if (event === "toolresult") {
        appMock.toolResultHandler = handler;
      }
    }

    callServerTool = appMock.callServerTool;
    close = appMock.close;
    connect = appMock.connect;
    updateModelContext = appMock.updateModelContext;
  },
}));

import { PageShell } from "../src/app/page-shell";
import { loadValidFixture } from "./fixtures";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly close = vi.fn();
  private readonly listeners = new Map<string, (event: { data: string }) => void>();
  onerror: ((event: unknown) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  /** The server dropped us, or was never there. */
  fail(): void {
    this.onerror?.(new Event("error"));
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

/**
 * Overrides only `protocol`, leaving the rest of jsdom's location intact:
 * React Flow and jsdom itself read `href`/`origin`, so replacing the whole
 * object with a stub breaks rendering rather than the transport decision.
 */
const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, "location")!;

function serveOver(protocol: string): void {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? protocol : Reflect.get(target, key)),
    }),
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, "location", REAL_LOCATION);
}

const CONNECTION_INFO = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: [],
  applicationVersion: "0.1.0",
  semanticSchemaVersion: 2,
};

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});

/**
 * Serves the frozen wire contract from a table of routes. Anything not in the
 * table 404s with a JSON error body, exactly as the server answers an unknown
 * view -- so a test that expects a request the shell never makes fails on the
 * missing render rather than on a helpfully invented response.
 */
function stubRoutes(bodies: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) =>
    url === "api/connection"
      ? Promise.resolve(okJson(CONNECTION_INFO))
      : url in bodies
        ? Promise.resolve(okJson(bodies[url]))
        : Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: `unknown route ${url}` }),
          }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const VIEWS = {
  context: {
    id: "system-context",
    kind: "c4-context",
    title: "System context",
    registration: "durable",
  },
  flow: {
    id: "request-flow",
    kind: "data-flow",
    title: "Request flow",
    registration: "ephemeral",
  },
} as const;

const inventory = (views: readonly unknown[]) => ({ schemaVersion: 1, views });

/** Every URL the shell has requested, in order. */
function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call: unknown[]) => call[0] as string);
}

/** The last SSE stream the mounted App subscribed to. */
function stream(): MockEventSource {
  const source = MockEventSource.instances.at(-1);
  expect(source, "App did not subscribe to the event stream").toBeDefined();
  return source!;
}

describe("shell selection", () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0;
    appMock.toolResultHandler = undefined;
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson(null))),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  it("renders no chrome in the MCP shell", () => {
    serveOver("ui:");

    render(<PageShell />);

    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
  });

  it("keeps the theme toggle in the MCP shell, unchanged", () => {
    serveOver("ui:");

    render(<PageShell />);

    expect(screen.getByRole("button", { name: /switch to (light|dark) mode/i })).not.toBeNull();
  });

  it("renders a title bar carrying the product mark in the web shell", () => {
    serveOver("http:");

    render(<PageShell />);

    const banner = screen.getByRole("banner");
    // Matched on the bar's text rather than on one element: the wordmark is
    // split across two spans so its second half can carry the accent colour,
    // which puts "Archer" in no single text node.
    expect(banner.textContent).toMatch(/Archer/);
  });

  it("hosts the theme toggle inside the web title bar", () => {
    serveOver("http:");

    render(<PageShell />);

    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("button", { name: /switch to (light|dark) mode/i })).not.toBeNull();
    // Exactly one toggle is mounted: `useTheme` may have a single owner.
    expect(screen.getAllByRole("button", { name: /switch to (light|dark) mode/i })).toHaveLength(1);
  });
});

/**
 * The tab strip is the registered inventory, not the presentation.
 *
 * `GET api/diagrams` is the inventory's source on load rather than the
 * bootstrap payload's `views` key, because bootstrap answers `null` when
 * nothing has been presented yet -- and "registered but not yet presented" is
 * exactly the state a tab strip exists to show.
 */
describe("web shell tabs", () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    serveOver("http:");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  it("renders one tab per registered view", async () => {
    stubRoutes({
      "api/bootstrap": null,
      "api/diagrams": inventory([VIEWS.context, VIEWS.flow]),
    });

    render(<PageShell />);

    await filesTable();
    const tabs = within(projectFiles()).getAllByRole("button", { name: /System context|Request flow/ });
    expect(tabs.map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("System context"), expect.stringContaining("Request flow")]),
    );
    expect(tabs).toHaveLength(2);
  });

  it("renders the shell without a tab strip when nothing is registered", async () => {
    stubRoutes({
      "api/bootstrap": null,
      "api/diagrams": inventory([]),
    });

    render(<PageShell />);
    await screen.findByRole("banner");

    // No empty rail, and the page says which nothing this is.
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    expect(await screen.findByText("No diagrams or notes yet.")).not.toBeNull();
  });

  it("adds and removes tabs as inventory events arrive", async () => {
    stubRoutes({
      "api/bootstrap": null,
      "api/diagrams": inventory([VIEWS.context]),
    });

    render(<PageShell />);
    await filesTable(), fileButton(/System context/);

    await act(async () => {
      stream().emit("inventory", inventory([VIEWS.context, VIEWS.flow]));
    });
    expect(within(projectFiles()).getAllByRole("button", { name: /System context|Request flow/ })).toHaveLength(2);

    await act(async () => {
      stream().emit("inventory", inventory([VIEWS.flow]));
    });
    expect(within(projectFiles()).getAllByRole("button", { name: /System context|Request flow/ })).toHaveLength(1);
    expect(within(projectFiles()).queryByRole("button", { name: /System context/ })).toBeNull();
  });

  it("carries no tab strip into the MCP shell even when views are registered", async () => {
    stubRoutes({
      "api/bootstrap": null,
      "api/diagrams": inventory([VIEWS.context, VIEWS.flow]),
    });
    serveOver("ui:");

    render(<PageShell />);
    await Promise.resolve();

    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    // The embedded view must not reach for same-origin routes it does not own.
    expect(fetch).not.toHaveBeenCalled();
  });
});

/**
 * Tab switching is USER NAVIGATION, not an agent presentation change.
 *
 * The distinction is the point of these tests. Clicking a tab fetches that
 * view and draws it in this browser; it must not tell the server what is being
 * looked at, because the presentation is the agent's and a second writer would
 * make it mean two things. When the agent presents, its presentation
 * re-asserts and takes the tab selection with it.
 */
describe("web shell tab navigation", () => {
  const architecture = loadValidFixture("minimal-architecture.json");
  const dataFlow = loadValidFixture("minimal-data-flow.json");

  const snapshot = (envelope: unknown, presentation: unknown) => ({
    envelope,
    presentation,
    diagnostics: [],
  });

  const AGENT_PRESENTATION = { presentationId: "p1", viewId: VIEWS.context.id };

  function routes(): Record<string, unknown> {
    return {
      "api/bootstrap": snapshot(architecture, AGENT_PRESENTATION),
      "api/diagrams": inventory([VIEWS.context, VIEWS.flow]),
      // Every read a reconcile makes is served: one left to 404 keeps the page unsynced, and its 2 s retry then
      // lands inside a test's request count under load (O267).
      "api/compile": { schemaVersion: 1, failures: [] },
      [`api/emphasis/${VIEWS.context.id}`]: { schemaVersion: 1, viewId: VIEWS.context.id, emphases: [] },
      [`api/emphasis/${VIEWS.flow.id}`]: { schemaVersion: 1, viewId: VIEWS.flow.id, emphases: [] },
      "api/selection": {},
      // The per-view route serves the envelope itself, not a presentation
      // snapshot: it answers "what is this diagram", not "what is being shown".
      [`api/diagrams/${VIEWS.flow.id}`]: dataFlow,
      [`api/diagrams/${VIEWS.context.id}`]: architecture,
    };
  }

  /** Opens a diagram from the project page, as a reader does. */
  function tab(name: RegExp): HTMLElement {
    return fileButton(name);
  }
  /** The diagram on screen, as the document bar names it. */
  const onScreen = (): string => screen.getByRole("heading", { level: 1 }).textContent ?? "";

  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    serveOver("http:");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  /** Every selection the page posted, as parsed bodies, in order. */
  // Selection publication is throttled (selection-sender.ts): a change made within the window opened by the
  // previous publication is sent when it closes.
  const SELECTION_SETTLE_MS = SELECTION_SEND_INTERVAL_MS + 20;

  function selectionsPosted(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return (fetchMock.mock.calls as [string, RequestInit?][])
      .filter(([url]) => url === "api/selection")
      .map(([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>);
  }

  /*
   * ADR 0011. Picking a tab is the reader navigating: it reads the view and
   * presents nothing. What it does say is WHERE THE READER IS, by publishing
   * the empty selection the turn starts with, stamped with the picked view and
   * `reader:<viewId>`. That replaces whatever they had selected on the view
   * they left, which the agent would otherwise go on being handed as current
   * (adversarial review 2026-10-02, F2).
   */
  it("draws the picked view, presents nothing, and says where the reader went", async () => {
    const fetchMock = stubRoutes(routes());
    render(<PageShell />);
    await screen.findByText("Web");

    // Scoped to the click.
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The picked view is on screen: "API" belongs to the data flow alone.
    expect(await screen.findByText("API")).not.toBeNull();
    // Exactly these requests: the view itself, the emphasis stored against it
    // (the stream carries deltas and says nothing on connect, so a view being
    // shown has to ask what is already stored), and the one write.
    // The notification bell refreshes in the background on its own timer; its
    // reads are not caused by the click, so they are left out of this count.
    const notificationRead = (url: string): boolean =>
      /(^|\/)api\/(connection|bootstrap|comment-activity)$|(^|\/)api\/comments\?target=/.test(url);
    // The view's walkthroughs (ADR 0034) are asked for with it, and are the reader's to ignore.
    const walkthroughRead = (url: string): boolean => url.startsWith("api/walkthroughs?");
    // Which reads, not how many: a slow run may see one read more than once (O267).
    expect(
      [...new Set(requestedUrls(fetchMock).filter((url) => !notificationRead(url) && !walkthroughRead(url)))].sort(),
    ).toEqual([`api/diagrams/${VIEWS.flow.id}`, `api/emphasis/${VIEWS.flow.id}`, "api/selection"].sort());
    expect(requestedUrls(fetchMock)).toContain(`api/walkthroughs?viewId=${VIEWS.flow.id}`);
    expect(selectionsPosted(fetchMock)).toEqual([
      {
        schemaVersion: 1,
        viewId: VIEWS.flow.id,
        revision: (dataFlow as { revision: string }).revision,
        presentationId: `reader:${VIEWS.flow.id}`,
        selectionRevision: 0,
        nodes: [],
        edges: [],
      },
    ]);
    // And it did not re-open the stream: the agent's channel is untouched.
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("publishes a selection made on a picked view, stamped with that view and not with the agent's presentation", async () => {
    const fetchMock = stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="api"]');
    expect(node, "the picked view did not render its nodes").not.toBeNull();
    await act(async () => {
      fireEvent.click(node!);
      await new Promise((resolve) => setTimeout(resolve, SELECTION_SETTLE_MS));
    });

    const posted = selectionsPosted(fetchMock);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      viewId: VIEWS.flow.id,
      revision: (dataFlow as { revision: string }).revision,
      presentationId: `reader:${VIEWS.flow.id}`,
      nodes: [{ id: "api", label: "API" }],
    });
  });

  it("says the reader is on a different diagram from the agent's, and goes back in one click", async () => {
    const fetchMock = stubRoutes(routes());
    render(<PageShell />);
    await screen.findByText("Web");
    expect(screen.queryByRole("group", { name: "What the agent is presenting" })).toBeNull();

    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");

    const notice = screen.getByRole("group", { name: "What the agent is presenting" });
    expect(notice).toHaveTextContent("The agent is presenting System context. You are viewing Request flow.");

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(within(notice).getByRole("button", { name: "Back to the agent's view" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByText("Web")).not.toBeNull();
    expect(screen.queryByText("API")).toBeNull();
    expect(screen.queryByRole("group", { name: "What the agent is presenting" })).toBeNull();
    expect(onScreen()).toBe("System context");
    // Drawn from the snapshot in hand, and the server is told the reader is
    // back: an empty selection on the agent's own presentation.
    expect(requestedUrls(fetchMock)).not.toContain("api/bootstrap");
    expect(selectionsPosted(fetchMock)).toEqual([
      expect.objectContaining({
        viewId: VIEWS.context.id,
        presentationId: AGENT_PRESENTATION.presentationId,
        nodes: [],
        edges: [],
      }),
    ]);
  });

  it("treats the tab of the agent's own view as the agent's presentation, not as a tab of the reader's", async () => {
    const fetchMock = stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");

    // Already on it: the view is not read again, and a selection is still the presentation's. Its emphasis is: the
    // project page this goes through holds no drawing, so nothing per-view is kept or read there (G1, PF-1), and the
    // drawing coming back asks what is stored against it, as any diagram opened does.
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(tab(/System context/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requestedUrls(fetchMock)).toEqual([`api/emphasis/${VIEWS.context.id}`]);
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    await act(async () => {
      fireEvent.click(container.querySelector<HTMLElement>('.react-flow__node[data-id="web"]')!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(selectionsPosted(fetchMock).at(-1)).toMatchObject({
      presentationId: AGENT_PRESENTATION.presentationId,
      nodes: [{ id: "web" }],
    });

    // Away, and back by the tab: the agent's presentation again.
    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    await act(async () => {
      fireEvent.click(tab(/System context/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText("Web")).not.toBeNull();
    expect(screen.queryByRole("group", { name: "What the agent is presenting" })).toBeNull();
    expect(selectionsPosted(fetchMock).at(-1)).toMatchObject({
      viewId: VIEWS.context.id,
      presentationId: AGENT_PRESENTATION.presentationId,
      nodes: [],
    });
  });

  it("stays on the reader's tab when the agent's view is live-reloaded, and publishes their selection again", async () => {
    const fetchMock = stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");
    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    await act(async () => {
      fireEvent.click(container.querySelector<HTMLElement>('.react-flow__node[data-id="api"]')!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The same presentation at a new revision: the agent's file was saved.
    fetchMock.mockClear();
    const reloaded = { ...(architecture as Record<string, unknown>), revision: `sha256:${"e".repeat(64)}` };
    await act(async () => {
      stream().emit("presentation", snapshot(reloaded, AGENT_PRESENTATION));
      await new Promise((resolve) => setTimeout(resolve, SELECTION_SETTLE_MS));
    });

    expect(screen.getByText("API")).not.toBeNull();
    expect(onScreen()).toBe("Request flow");
    expect(screen.getByRole("group", { name: "What the agent is presenting" })).not.toBeNull();
    // The server drops the stored selection when the presented view's
    // revision moves; the reader's is theirs, so it is said again.
    expect(selectionsPosted(fetchMock)).toEqual([
      expect.objectContaining({ viewId: VIEWS.flow.id, nodes: [{ id: "api", label: "API" }] }),
    ]);
  });

  // The other half of the rule: once the agent presents again, the view on
  // screen is the agent's and selections in it are publishable as before.
  it("resumes publishing selection once the agent presents again", async () => {
    const fetchMock = stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");

    await act(async () => {
      stream().emit("presentation", snapshot(dataFlow, { presentationId: "p2", viewId: VIEWS.flow.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");

    fetchMock.mockClear();
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="api"]');
    expect(node).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    await act(async () => {
      fireEvent.click(node!);
      await new Promise((resolve) => setTimeout(resolve, SELECTION_SETTLE_MS));
    });

    expect(requestedUrls(fetchMock)).toContain("api/selection");
  });

  it("moves the tab selection to the view being looked at", async () => {
    stubRoutes(routes());
    render(<PageShell />);
    await screen.findByText("Web");
    expect(onScreen()).toBe("System context");

    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");

    expect(onScreen()).toBe("Request flow");
  });

  it("re-asserts the agent's presentation and selects its tab", async () => {
    stubRoutes(routes());
    render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("API");

    // `present_diagram` on the agent's side arrives as a presentation event.
    await act(async () => {
      stream().emit("presentation", snapshot(architecture, AGENT_PRESENTATION));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByText("Web")).not.toBeNull();
    expect(screen.queryByText("API")).toBeNull();
    expect(onScreen()).toBe("System context");
  });

  it("lets an agent presentation win over a tab fetch still in flight", async () => {
    let releaseFlow: (() => void) | undefined;
    const table = routes();
    const fetchMock = vi.fn((url: string) => {
      if (url === `api/diagrams/${VIEWS.flow.id}`) {
        return new Promise((resolve) => {
          releaseFlow = () => resolve(okJson(dataFlow));
        });
      }
      return Promise.resolve(okJson(url === "api/connection" ? CONNECTION_INFO : table[url]));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PageShell />);
    await screen.findByText("Web");
    fireEvent.click(tab(/Request flow/));

    // The agent presents while the tab's fetch is still outstanding.
    await act(async () => {
      stream().emit("presentation", snapshot(architecture, AGENT_PRESENTATION));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      releaseFlow?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A late answer to a superseded click must not overwrite what the agent
    // asked for -- the user would see the agent's diagram flicker away.
    expect(screen.queryByText("API")).toBeNull();
    expect(onScreen()).toBe("System context");
  });

  it("keeps the current diagram when a picked view cannot be loaded", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const table = routes();
    delete table[`api/diagrams/${VIEWS.flow.id}`];
    stubRoutes(table);

    render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      fireEvent.click(tab(/Request flow/));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A 404 is a gone or mistyped view, not a reason to blank the canvas.
    expect(screen.getByText("Web")).not.toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });
});

/**
 * What the page says when it is not drawing a diagram.
 *
 * The screen must state ground truth about what exists, whatever the agent
 * claims. An agent that says it drew a diagram and did not must be
 * contradicted by the page, so every non-drawing condition is named out loud
 * and none of them is allowed to look like any other.
 */
describe("web shell page states", () => {
  const architecture = loadValidFixture("minimal-architecture.json");
  const snapshot = (envelope: unknown, presentation: unknown) => ({
    envelope,
    presentation,
    diagnostics: [],
  });
  const PRESENTED = { presentationId: "p1", viewId: VIEWS.context.id };

  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    serveOver("http:");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  it("says the registry is empty rather than showing a blank canvas", async () => {
    stubRoutes({ "api/bootstrap": null, "api/diagrams": inventory([]) });

    render(<PageShell />);

    expect(await screen.findByText(/No diagrams or notes yet\./)).not.toBeNull();
  });

  it("lists the diagrams to choose from when diagrams exist but none is presented", async () => {
    const fetchMock = stubRoutes({
      "api/bootstrap": null,
      "api/diagrams": inventory([VIEWS.context, VIEWS.flow]),
    });

    render(<PageShell />);

    // The project page, in place of "Select a diagram to view.".
    await filesTable();
    expect(screen.getByRole("button", { name: "System context" })).not.toBeNull();
    expect(within(projectFiles()).getAllByRole("button", { name: /System context|Request flow/ })).toHaveLength(2);
    // No tab is selected and nothing was fetched for one: auto-selecting would
    // have the page invent a presentation the agent never made.
    expect(
      within(projectFiles())
        .getAllByRole("button", { name: /System context|Request flow/ })
        .map((t) => t.getAttribute("aria-current")),
    ).toEqual([null, null]);
    expect(requestedUrls(fetchMock).some((url) => url.startsWith("api/diagrams/"))).toBe(false);
  });

  it("contradicts a drawing whose view has been unregistered", async () => {
    stubRoutes({
      "api/bootstrap": snapshot(architecture, PRESENTED),
      "api/diagrams": inventory([VIEWS.context]),
    });

    render(<PageShell />);
    await screen.findByText("Web");

    // The agent called `unregister_diagram`, or the watcher dropped a deleted
    // source: the registry no longer holds what is on screen.
    await act(async () => {
      stream().emit("inventory", inventory([VIEWS.flow]));
    });

    expect(await screen.findByText(/no longer registered\./)).not.toBeNull();
    // The stale render is gone, not left up as if it were live.
    expect(screen.queryByText("Web")).toBeNull();
  });

  it("restores the diagram if the view returns to the registry", async () => {
    stubRoutes({
      "api/bootstrap": snapshot(architecture, PRESENTED),
      "api/diagrams": inventory([VIEWS.context]),
    });

    render(<PageShell />);
    await screen.findByText("Web");
    await act(async () => {
      stream().emit("inventory", inventory([]));
    });
    await screen.findByText(/no longer registered\./);

    await act(async () => {
      stream().emit("inventory", inventory([VIEWS.context]));
    });

    expect(await screen.findByText("Web")).not.toBeNull();
  });

  it("reports a lost connection as itself, not as an empty registry", async () => {
    stubRoutes({ "api/bootstrap": null, "api/diagrams": inventory([VIEWS.context]) });

    render(<PageShell />);
    await screen.findByRole("region", { name: "Project documents" });
    await act(async () => {
      stream().fail();
    });

    expect(await screen.findByText(/Not connected to Archer\./)).not.toBeNull();
    expect(screen.queryByText(/No diagrams or notes yet\./)).toBeNull();
  });

  /*
   * Server UP, stream connected, bootstrap unreadable.
   *
   * The page used to say "Loading..." here forever: the bootstrap catch only
   * logged, so nothing ever flipped `heardFromHost` and the page went on
   * claiming a request was in progress when it had already failed. It is not a
   * lost connection either -- the stream is fine -- so the disconnected notice
   * would be its own false statement.
   */
  it("says it cannot tell what is presented when bootstrap fails", async () => {
    // `api/bootstrap` is absent from the table, so it answers non-ok.
    stubRoutes({ "api/diagrams": inventory([VIEWS.context]) });

    render(<PageShell />);

    expect(await screen.findByText(/Cannot tell what Archer is showing\./)).not.toBeNull();
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(screen.queryByText(/Not connected to Archer\./)).toBeNull();
  });

  it("stops saying so once the stream delivers a presentation", async () => {
    stubRoutes({ "api/diagrams": inventory([VIEWS.context]) });

    render(<PageShell />);
    await screen.findByText(/Cannot tell what Archer is showing\./);

    await act(async () => {
      stream().emit("presentation", snapshot(architecture, PRESENTED));
    });

    expect(await screen.findByText("Web")).not.toBeNull();
  });

  it("keeps a live diagram on screen when the connection drops, and says so", async () => {
    stubRoutes({
      "api/bootstrap": snapshot(architecture, PRESENTED),
      "api/diagrams": inventory([VIEWS.context]),
    });

    render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      stream().fail();
    });

    // Blanking a true drawing would trade one false statement for another, so
    // the diagram stays and the lost connection is reported alongside it.
    expect(screen.getByText("Web")).not.toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent(/Reconnecting to Archer/i);
    expect(screen.getByRole("status")).toHaveAttribute("data-connection", "lost");
  });

  /*
   * RECONNECTION (adversarial review 2026-10-02, F1). The stream coming back
   * is not the page being current: what it missed is read from the routes,
   * and only then does the warning go. The bridge half is
   * `tests/reconcile.test.ts`; the real stream is `browser/reconnect.e2e.ts`.
   */
  it("replaces a drawing retired while the stream was down, and only then withdraws the warning", async () => {
    const routes: Record<string, unknown> = {
      "api/bootstrap": snapshot(architecture, PRESENTED),
      "api/diagrams": inventory([VIEWS.context]),
      "api/compile": { schemaVersion: 1, failures: [] },
      [`api/emphasis/${VIEWS.context.id}`]: { schemaVersion: 1, viewId: VIEWS.context.id, emphases: [] },
    };
    stubRoutes(routes);
    render(<PageShell />);
    await screen.findByText("Web");
    await act(async () => {
      stream().fail();
    });
    expect(await screen.findByText(/Reconnecting to Archer/i)).not.toBeNull();

    // The agent unregistered the view while nobody was listening.
    routes["api/bootstrap"] = null;
    routes["api/diagrams"] = inventory([]);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(await screen.findByText(/no longer registered\./)).not.toBeNull();
    expect(screen.queryByText("Web")).toBeNull();
    expect(screen.queryByText(/Reconnecting to Archer/i)).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("goes on saying the drawing may be out of date while it cannot read what it missed", async () => {
    const routes: Record<string, unknown> = {
      "api/bootstrap": snapshot(architecture, PRESENTED),
      "api/diagrams": inventory([VIEWS.context]),
      "api/compile": { schemaVersion: 1, failures: [] },
      [`api/emphasis/${VIEWS.context.id}`]: { schemaVersion: 1, viewId: VIEWS.context.id, emphases: [] },
    };
    stubRoutes(routes);
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PageShell />);
    await screen.findByText("Web");
    await act(async () => {
      stream().fail();
    });

    // The stream is back and the registry cannot be read: updates are
    // arriving again, and what is on screen is still unconfirmed.
    const listing = routes["api/diagrams"];
    delete routes["api/diagrams"];
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText(/Synchronizing with Archer/i)).toHaveAttribute("data-connection", "unsynced");
    expect(screen.getByText("Web")).not.toBeNull();

    // A drop and a second stream ask again; this time everything answers.
    routes["api/diagrams"] = listing;
    await act(async () => {
      stream().fail();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText("Web")).not.toBeNull();
  });

  /*
   * LANDMARKS. Every piece of content sits in one: the title bar is the
   * banner, and everything under it -- the dataflow chips, the connection
   * strip, the stage -- is `main`. The page had no `main` at all, which axe
   * reported three ways (`tests/browser/a11y.e2e.ts` (in the Rust implementation, not in this tree) holds the outcome).
   */
  it("puts the stage, and the connection strip beside it, in the one main landmark", async () => {
    stubRoutes({
      "api/bootstrap": snapshot(architecture, PRESENTED),
      "api/diagrams": inventory([VIEWS.context]),
    });

    render(<PageShell />);
    await screen.findByText("Web");
    await act(async () => {
      stream().fail();
    });

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    const main = mains[0];
    // The stage is still the panel the tabs control, inside the landmark
    // rather than instead of it: `role="tabpanel"` on `<main>` itself would
    // replace the landmark role and leave the page with none again.
    const panel = main!.querySelector(".archer-stage")!;
    expect(panel).not.toBe(main);
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    expect(panel.getAttribute("aria-describedby")).toBeNull();
    // The strip is a direct child, which is what its in-flow rule selects.
    const strip = within(main).getByText(/Reconnecting to Archer/i);
    expect(strip.parentElement).toBe(main);
    // The bar is a landmark of its own, beside `main`, never inside it.
    expect(main.contains(screen.getByRole("banner"))).toBe(false);
    expect(screen.getByRole("banner").contains(main)).toBe(false);
  });

  it("keeps a notice inside the main landmark too", async () => {
    stubRoutes({ "api/bootstrap": null, "api/diagrams": inventory([]) });

    render(<PageShell />);

    const notice = await screen.findByText(/No diagrams or notes yet\./);
    expect(screen.getByRole("main").contains(notice)).toBe(true);
    // No diagram tabs, so the stage wears no tabpanel role: the only panel is the project browser's own.
    expect(screen.getAllByRole("tabpanel").every((panel) => panel.classList.contains("archer-project-tab-panel"))).toBe(
      true,
    );
  });

  it("lays the main landmark out as the column the shell was, so nothing moves", () => {
    const css = readStylesheet();
    const declared = (selector: string): Map<string, string> => {
      const rule = rulesOf(css).find((candidate) => candidate.selectors.includes(selector));
      expect(rule, `a ${selector} rule`).toBeDefined();
      return new Map(declarationsOf(rule!.body));
    };

    const main = declared(".archer-main");
    expect(main.get("display")).toBe("flex");
    expect(main.get("flex-direction")).toBe("column");
    expect(main.get("flex")).toBe("1");
    expect(main.get("min-height")).toBe("0");
    // The strip moved from the shell into `main`; its in-flow rule moved with it.
    expect(declared(".archer-main > .archer-stale-strip").get("position")).toBe("static");
    expect(rulesOf(css).some((rule) => rule.selectors.includes(".archer-web-shell > .archer-stale-strip"))).toBe(false);
  });

  it("distinguishes a listing that failed from a registry that is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "api/connection"
          ? Promise.resolve(okJson(CONNECTION_INFO))
          : url === "api/diagrams"
            ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
            : Promise.resolve(okJson(null)),
      ),
    );

    render(<PageShell />);

    expect(await screen.findByText(/Cannot list the registered diagrams\./)).not.toBeNull();
    expect(screen.queryByText(/No diagrams or notes yet\./)).toBeNull();
  });

  it("says it does not know yet before the first answers arrive", async () => {
    // Requests that never settle: the page has heard nothing, and must not
    // claim an empty registry on the strength of not having asked yet.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<PageShell />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Loading/)).not.toBeNull();
    expect(screen.queryByText(/No diagrams or notes yet\./)).toBeNull();
  });
});

/**
 * The MCP shell has no inventory route and no inventory event, so it cannot
 * observe the registry at all. It must therefore report only what it knows and
 * claim nothing about what it does not -- silence about a registry it cannot
 * see is honest; "no diagrams registered" would not be.
 */
describe("MCP shell page states", () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson(null))),
    );
    serveOver("ui:");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  it("says no diagram is presented, and makes no claim about a registry", async () => {
    render(<PageShell />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/No diagram presented\./)).not.toBeNull();
    expect(screen.queryByText(/registered/i)).toBeNull();
  });

  it("reports a host connection it never established", async () => {
    appMock.connect.mockRejectedValueOnce(new Error("host unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<PageShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText(/Not connected to Archer\./)).not.toBeNull();
  });
});

/**
 * The MCP shell says its states in the same words as the web shell and wears
 * no more chrome to do it. Minimal is the rule here, but a bare canvas
 * asserting nothing is the failure being guarded against -- so "minimal" may
 * not shade into "silent".
 */
describe("MCP shell states stay minimal without going quiet", () => {
  const architecture = loadValidFixture("minimal-architecture.json");

  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson(null))),
    );
    serveOver("ui:");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  it("is one main landmark, edge to edge, with everything it draws inside", async () => {
    const { container } = render(<PageShell />);
    await act(async () => {
      await Promise.resolve();
    });

    const main = screen.getByRole("main");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    // The shell element itself: no wrapper grew, and nothing sits outside it.
    expect(container.firstElementChild).toBe(main);
    expect(main.classList.contains("archer-mcp-shell")).toBe(true);
    expect(main.contains(screen.getByText(/No diagram presented\./))).toBe(true);
    expect(main.contains(screen.getByRole("button", { name: /switch to (light|dark) mode/i }))).toBe(true);
  });

  it("states its condition without growing chrome to do it", async () => {
    render(<PageShell />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/No diagram presented\./)).not.toBeNull();
    // Still the embedded view: the host owns the frame.
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
  });

  it("names a handshake that never completed, without chrome", async () => {
    appMock.connect.mockRejectedValueOnce(new Error("host unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<PageShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The one connection fact this shell can observe. The SDK reports the
    // handshake and nothing after it, so a host that goes away mid-session is
    // NOT knowable here -- and the page says nothing it cannot know.
    expect(screen.getByText(/Not connected to Archer\./)).not.toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
  });
});
