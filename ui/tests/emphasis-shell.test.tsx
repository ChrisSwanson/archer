import { fileButton } from "./support/primary-navigation";
// @vitest-environment jsdom
//
// Emphasis arriving over the wire, and the chip row that names what is stored.
//
// ONE bundle, TWO shells (ADR-0004). The canvas treatment and the legend are
// the same in both -- they are what the agent said, and the embedded view must
// not say less than the browser one. The CHIPS are chrome, so they belong to
// the web shell alone: the MCP-App view is embedded in a host that does its own
// navigation, and a second row of controls inside it competes with the host's.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { installReducedMotion } from "./match-media";

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

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

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

const okJson = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

function stubRoutes(bodies: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) =>
    url in bodies
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

const architecture = loadValidFixture("minimal-architecture.json");
const dataFlow = loadValidFixture("minimal-data-flow.json");

const VIEW = "system-context";
const OTHER_VIEW = "request-flow";

const VIEWS = [
  { id: VIEW, kind: "c4-context", title: "System context", registration: "durable" },
  { id: OTHER_VIEW, kind: "data-flow", title: "Request flow", registration: "ephemeral" },
];

const PRESENTED = { presentationId: "p1", viewId: VIEW };
const snapshot = (envelope: unknown, presentation: unknown) => ({
  envelope,
  presentation,
  diagnostics: [],
});

/** One stored emphasis over the architecture fixture, whose only node is `web`. */
function stored(id: string, title: string, palette = "teal"): unknown {
  return {
    id,
    viewId: VIEW,
    title,
    groups: [
      {
        id: "g",
        style: "highlight",
        palette,
        label: title,
        description: "",
        nodes: ["web"],
        edges: [],
      },
    ],
  };
}

const emphasisEvent = (emphases: readonly unknown[], viewId = VIEW) => ({
  schemaVersion: 1,
  viewId,
  emphases,
});

function routes(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "api/connection": {
      browserProtocolMajor: 1,
      supportedBrowserProtocolMajors: [1],
      serverEpoch: "12345678-1234-1234-1234-123456789abc",
      capabilities: [],
      applicationVersion: "0.1.0",
      semanticSchemaVersion: 2,
    },
    "api/compile": { schemaVersion: 1, failures: [] },
    "api/bootstrap": snapshot(architecture, PRESENTED),
    "api/diagrams": { schemaVersion: 1, views: VIEWS },
    [`api/diagrams/${OTHER_VIEW}`]: dataFlow,
    [`api/diagrams/${VIEW}`]: architecture,
    // Nothing stored until a test says otherwise. An unknown view answers the
    // same shape with an empty list -- never a 404.
    [`api/emphasis/${VIEW}`]: emphasisEvent([]),
    [`api/emphasis/${OTHER_VIEW}`]: emphasisEvent([], OTHER_VIEW),
    ...extra,
  };
}

function stream(): MockEventSource {
  const source = MockEventSource.instances.at(-1);
  expect(source, "App did not subscribe to the event stream").toBeDefined();
  return source!;
}

// The MCP bridge loads its SDK lazily: wait for that import, then one macrotask.
const settle = async () => {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const emphasisedNode = (container: HTMLElement, id: string): boolean => {
  const node = container.querySelector(`.react-flow__node[data-id="${id}"]`);
  return node?.classList.contains("archer-emph") === true;
};

const chipRow = (): HTMLElement | null => screen.queryByRole("group", { name: "Highlights" });

beforeEach(() => {
  MockEventSource.instances.length = 0;
  appMock.toolResultHandler = undefined;
  installReducedMotion(false);
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

describe("emphasis arrives over the event stream", () => {
  beforeEach(() => serveOver("http:"));

  it("reads what is already stored when a view goes up", async () => {
    const fetchMock = stubRoutes(
      routes({ [`api/emphasis/${VIEW}`]: emphasisEvent([stored("write-path", "The write path")]) }),
    );
    const { container } = render(<PageShell />);
    await screen.findByText("Web");
    await act(settle);

    // The stream sends deltas and nothing on connect, so a page that joins
    // late has to ask -- otherwise emphasis published before it loaded is
    // invisible until the agent happens to publish again.
    expect(fetchMock.mock.calls.map((call: unknown[]) => call[0])).toContain(`api/emphasis/${VIEW}`);
    expect(emphasisedNode(container, "web")).toBe(true);
  });

  it("emphasises live when an event arrives", async () => {
    stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");
    await act(settle);
    expect(emphasisedNode(container, "web")).toBe(false);

    await act(async () => {
      stream().emit("emphasis", emphasisEvent([stored("write-path", "The write path")]));
      await settle();
    });

    expect(emphasisedNode(container, "web")).toBe(true);
    expect(screen.getByRole("region", { name: "Highlights" }).textContent).toContain("The write path");
  });

  // O41: the agent set highlights just after the page turned to the view. The event landed while the
  // view's own read was still out, and that read, answered before the agent spoke, then emptied the list.
  it("keeps an event that lands while the view's own read is out: the read is older", async () => {
    const bodies = routes();
    const held: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === `api/emphasis/${VIEW}`
          ? new Promise((resolve) => held.push(() => resolve(okJson(emphasisEvent([])))))
          : Promise.resolve(
              url in bodies ? okJson(bodies[url]) : { ok: false, status: 404, json: () => Promise.resolve(null) },
            ),
      ),
    );
    const { container } = render(<PageShell />);
    await screen.findByText("Web");
    await act(settle);
    expect(held.length).toBeGreaterThan(0);

    await act(async () => {
      stream().emit("emphasis", emphasisEvent([stored("write-path", "The write path")]));
      await settle();
    });
    expect(emphasisedNode(container, "web")).toBe(true);

    await act(async () => {
      for (const answer of held.splice(0)) answer();
      await settle();
    });
    expect(emphasisedNode(container, "web")).toBe(true);
    expect(screen.getByRole("region", { name: "Highlights" }).textContent).toContain("The write path");
  });

  it("keeps the chips and the legend inside the main landmark, the legend as a region", async () => {
    stubRoutes(routes());
    render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      stream().emit("emphasis", emphasisEvent([stored("write-path", "The write path")]));
      await settle();
    });

    const main = screen.getByRole("main");
    expect(main.contains(screen.getByRole("group", { name: "Highlights" }))).toBe(true);
    const legend = screen.getByRole("region", { name: "Highlights" });
    expect(main.contains(legend)).toBe(true);
    // Not an `<aside>`: a complementary landmark may not sit inside another
    // landmark, and the legend is drawn over the stage, which is in `main`.
    expect(legend.tagName).toBe("SECTION");
    expect(legend).not.toHaveAttribute("role", "complementary");
  });

  it("takes the emphasis away when the agent clears it", async () => {
    stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      stream().emit("emphasis", emphasisEvent([stored("write-path", "The write path")]));
      await settle();
    });
    expect(emphasisedNode(container, "web")).toBe(true);

    // `groups: []` means cleared.
    await act(async () => {
      stream().emit(
        "emphasis",
        emphasisEvent([{ id: "write-path", viewId: VIEW, title: "The write path", groups: [] }]),
      );
      await settle();
    });

    expect(emphasisedNode(container, "web")).toBe(false);
    expect(screen.queryByRole("region", { name: "Highlights" })).toBeNull();
  });

  // An emphasis names ids in the diagram it was published against. Drawing one
  // over a different diagram would emphasise whatever happened to share a name.
  it("ignores an emphasis published for a view that is not on screen", async () => {
    stubRoutes(routes());
    const { container } = render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      stream().emit("emphasis", {
        schemaVersion: 1,
        viewId: OTHER_VIEW,
        emphases: [{ ...(stored("elsewhere", "Elsewhere") as object), viewId: OTHER_VIEW }],
      });
      await settle();
    });

    expect(emphasisedNode(container, "web")).toBe(false);
    expect(chipRow()).toBeNull();
  });

  it("survives a malformed event without taking the canvas down", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubRoutes(routes());
    render(<PageShell />);
    await screen.findByText("Web");

    await act(async () => {
      stream().emit("emphasis", { schemaVersion: 1, nonsense: true });
      await settle();
    });

    expect(screen.getByText("Web")).not.toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("the dataflow chip row", () => {
  beforeEach(() => serveOver("http:"));

  async function withStored(...emphases: readonly unknown[]): Promise<HTMLElement> {
    stubRoutes(routes({ [`api/emphasis/${VIEW}`]: emphasisEvent(emphases) }));
    const { container } = render(<PageShell />);
    await screen.findByText("Web");
    await act(settle);
    return container;
  }

  it("gives every stored emphasis a chip", async () => {
    await withStored(stored("write-path", "The write path"), stored("read-path", "The read path", "coral"));

    const chips = within(chipRow()!).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["The write path", "The read path"]);
  });

  it("shows no row when the agent has stored nothing", async () => {
    await withStored();

    expect(chipRow()).toBeNull();
  });

  it("applies the emphasis a chip names", async () => {
    const container = await withStored(
      stored("write-path", "The write path"),
      stored("read-path", "The read path", "coral"),
    );
    // The newest arrival is up, so pick the other one to prove the click acts.
    const write = screen.getByRole("button", { name: "The write path" });

    fireEvent.click(write);

    expect(write.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "The read path" }).getAttribute("aria-pressed")).toBe("false");
    expect(emphasisedNode(container, "web")).toBe(true);
  });

  it("clears when the active chip is clicked again", async () => {
    const container = await withStored(stored("write-path", "The write path"));
    const chip = within(chipRow()!).getByRole("button", { name: "The write path" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(emphasisedNode(container, "web")).toBe(false);
    // Dismissed, not deleted: the chip is still there to pick up again.
    expect(within(chipRow()!).getAllByRole("button")).toHaveLength(1);
  });

  it("re-applies after a clear, so the dismissal is not one-way", async () => {
    const container = await withStored(stored("write-path", "The write path"));
    const chip = within(chipRow()!).getByRole("button", { name: "The write path" });

    fireEvent.click(chip);
    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(emphasisedNode(container, "web")).toBe(true);
  });

  it("sits under the tabs, where picking a diagram and picking a flow are one gesture", async () => {
    await withStored(stored("write-path", "The write path"));

    const tabs = screen.getByRole("banner");
    const row = chipRow()!;
    expect(tabs.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the row across when the user picks another diagram", async () => {
    stubRoutes(
      routes({
        [`api/emphasis/${VIEW}`]: emphasisEvent([stored("write-path", "The write path")]),
      }),
    );
    render(<PageShell />);
    await screen.findByText("Web");
    await act(settle);
    expect(chipRow()).not.toBeNull();

    await act(async () => {
      fireEvent.click(fileButton(/Request flow/));
      await settle();
    });
    await screen.findByText("API");

    // The new view has nothing stored, so nothing is offered -- the previous
    // view's flows name ids this diagram does not have.
    expect(chipRow()).toBeNull();
  });
});

/**
 * The embedded view: the emphasis rides in `set_emphasis`'s own
 * `structuredContent`, because that transport has no server push.
 */
describe("the MCP shell", () => {
  beforeEach(() => {
    serveOver("ui:");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson(null))),
    );
  });

  async function present(container: () => HTMLElement): Promise<HTMLElement> {
    // The bridge registers its tool-result listener once its lazily loaded SDK arrives.
    await act(settle);
    await act(async () => {
      appMock.toolResultHandler?.({
        structuredContent: snapshot(architecture, PRESENTED),
      });
      await settle();
    });
    await screen.findByText("Web");
    return container();
  }

  it("emphasises from the tool result, with no stream to listen to", async () => {
    const { container } = render(<PageShell />);
    await present(() => container);

    await act(async () => {
      appMock.toolResultHandler?.({
        structuredContent: emphasisEvent([stored("write-path", "The write path")]),
      });
      await settle();
    });

    expect(emphasisedNode(container, "web")).toBe(true);
  });

  // present_diagram with an emphasis: one tool result turns the page and points, so the
  // snapshot arrives before the shell has turned to the view it belongs to.
  it("emphasises from present_diagram's own result when it turns to the view", async () => {
    const { container } = render(<PageShell />);
    await act(settle);
    await act(async () => {
      appMock.toolResultHandler?.({
        structuredContent: {
          ...snapshot(architecture, PRESENTED),
          emphasisSnapshot: emphasisEvent([stored("write-path", "The write path")]),
        },
      });
      await settle();
    });
    await screen.findByText("Web");

    expect(emphasisedNode(container, "web")).toBe(true);
  });

  it("shows the legend, which is what the emphasis means", async () => {
    const { container } = render(<PageShell />);
    await present(() => container);

    await act(async () => {
      appMock.toolResultHandler?.({
        structuredContent: emphasisEvent([stored("write-path", "The write path")]),
      });
      await settle();
    });

    expect(screen.getByRole("region", { name: "Highlights" }).textContent).toContain("The write path");
  });

  it("grows no chip row, because the host owns navigation here", async () => {
    const { container } = render(<PageShell />);
    await present(() => container);

    await act(async () => {
      appMock.toolResultHandler?.({
        structuredContent: emphasisEvent([
          stored("write-path", "The write path"),
          stored("read-path", "The read path", "coral"),
        ]),
      });
      await settle();
    });

    expect(emphasisedNode(container, "web")).toBe(true);
    expect(chipRow()).toBeNull();
    // Still the embedded view: no chrome grew to carry the emphasis.
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
  });

  it("asks no same-origin route for emphasis it cannot own", async () => {
    render(<PageShell />);
    await act(settle);

    expect(fetch).not.toHaveBeenCalled();
  });
});
