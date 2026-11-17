import { fileRow } from "./support/primary-navigation";
// @vitest-environment jsdom
//
// The keyboard half of the canvas, ported from `docs/prototypes/emphasis`.
//
// The prototype shipped a `?` cheat sheet, a layered Esc, and Cmd+A; the React
// app shipped only the pointer half, which is what the status log of the time records
// as "no keyboard selection". These tests drive the real `App` so the bindings
// are exercised against the real selection store and the real canvas, not
// against a stand-in for either.
//
// The ordering of Esc is the behaviour most worth pinning. The prototype's
// comment names the bug it prevents: clearing the selection out from under
// someone who is dismissing the cheat sheet. One Esc must therefore mean
// exactly one thing, decided by what is on screen.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { HOTKEYS, SEARCH_SECTION } from "../src/app/HelpOverlay";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, (event: { data: string }) => void>();
  onerror: ((event: unknown) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }
}

const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, "location")!;

function serveOverHttp(): void {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? "http:" : Reflect.get(target, key)),
    }),
  });
}

const VIEWS = [{ id: "alpha", kind: "c4-context", title: "Alpha", registration: "durable" as const }];

/** Two nodes and an edge, so "select everything" has something to mean. */
const ENVELOPE = {
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

const EMPHASIS = {
  schemaVersion: 1,
  viewId: "alpha",
  emphases: [
    {
      id: "dataflow",
      viewId: "alpha",
      title: "Request path",
      groups: [
        {
          id: "request",
          style: "flow",
          palette: "teal",
          label: "Request",
          state: "existing",
          speed: "normal",
          nodes: [],
          edges: ["calls"],
        },
      ],
    },
  ],
};

function stubRoutes(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body =
        url === "api/diagrams"
          ? { schemaVersion: 1, views: VIEWS }
          : url.startsWith("api/diagrams/")
            ? ENVELOPE
            : url.startsWith("api/emphasis/")
              ? EMPHASIS
              : null;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

/** Mounts the web shell with one diagram drawn and returns its container. */
async function mountWithDiagram(): Promise<HTMLElement> {
  serveOverHttp();
  stubRoutes();
  const { container } = render(<App />);
  const tab = await fileRow(/Alpha/);
  fireEvent.click(tab);
  await waitFor(() => {
    expect(container.querySelectorAll(".react-flow__node").length).toBe(2);
  });
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  return container;
}

const selectedNodes = (container: HTMLElement): number =>
  container.querySelectorAll(".react-flow__node.selected").length;

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", REAL_LOCATION);
});

describe("search with no registered diagrams", () => {
  it.each(["/", "g", "G"])("%s opens search and focuses its box on a notes-only project", async (key) => {
    serveOverHttp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url === "api/bootstrap"
            ? { capabilities: { comments: true, notes: true }, project: { name: "Notes only" }, diagnostics: [] }
            : url === "api/diagrams"
              ? { schemaVersion: 1, views: [] }
              : url === "api/compile"
                ? { schemaVersion: 1, failures: [] }
                : url === "api/notes/all"
                  ? { notes: [{ path: "runbook.md", title: "Runbook", diagrams: [], viewIds: [] }] }
                  : url === "api/comments/pending"
                    ? { total: 0, targets: [] }
                    : null,
      })),
    );
    render(<App />);
    await screen.findByRole("region", { name: "Project documents" });
    fireEvent.keyDown(window, { key });
    const search = await screen.findByRole("searchbox", { name: "Search projects and files" });
    expect(search).toHaveFocus();
    act(() => search.blur());
    fireEvent.keyDown(window, { key });
    expect(search).toHaveFocus();
  });
});

describe("the help overlay", () => {
  it("opens on ? and announces itself as a dialog", async () => {
    await mountWithDiagram();

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "?" });

    const dialog = await screen.findByRole("dialog", { name: "Keyboard & Pointer" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("opens on Shift+/ too, which is how ? is typed on many layouts", async () => {
    await mountWithDiagram();

    fireEvent.keyDown(window, { key: "/", shiftKey: true });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("renders one row per entry in HOTKEYS, under its section", async () => {
    // Scoped to what it can actually see: that the list in `HOTKEYS` reaches
    // the DOM intact. Whether each ROW is true is not something a render test
    // can know -- that is `selection-modifiers.test.tsx` (the additive rows)
    // and the behaviour tests below (Esc, ?, Cmd+A, 1).
    //
    // `HOTKEYS` is the GRAPH list, and this page presents a graph. The sheet
    // is now per-canvas; that a sequence view is shown `SEQUENCE_HOTKEYS`
    // instead is `help-sheet-view.test.tsx`.
    await mountWithDiagram();
    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");

    for (const section of HOTKEYS) {
      expect(screen.getByRole("heading", { name: section.section })).toBeInTheDocument();
    }
    const rows = HOTKEYS.flatMap((section) => section.keys);
    // Then the shell's own rows on every web page: Search (/ and G) and the Panels' Esc.
    expect(dialog.querySelectorAll("dt kbd")).toHaveLength(rows.length + SEARCH_SECTION.keys.length + 1);
    for (const [key] of rows) {
      expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    }
  });

  it("closes on a click outside, but not on a click inside the panel", async () => {
    await mountWithDiagram();
    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(dialog.querySelector(".help-panel")!);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on the Close button", async () => {
    await mountWithDiagram();
    fireEvent.keyDown(window, { key: "?" });
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("gives focus to the panel and hands it back on close", async () => {
    // `aria-modal="true"` tells a screen reader the rest of the page is
    // unavailable. Dropping focus on `<body>` afterwards costs a keyboard user
    // their place, which is the same promise broken from the other end.
    const container = await mountWithDiagram();
    // jsdom does not apply the responsive stylesheet. Model this desktop
    // fixture's hidden Menu; real desktop/phone visibility and focus are
    // asserted by shell-consistency-audit.e2e.ts against the actual CSS.
    container.querySelector<HTMLButtonElement>(".primary-drawer-button")!.style.display = "none";
    const opener = container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]')!;
    act(() => opener.focus());

    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(dialog.querySelector(".help-panel"));

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes on a second ?, so the same key both asks and dismisses", async () => {
    await mountWithDiagram();

    fireEvent.keyDown(window, { key: "?" });
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "?" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ignores ? typed into a field, which is a question mark and not a command", async () => {
    await mountWithDiagram();
    const input = document.createElement("input");
    document.body.append(input);

    fireEvent.keyDown(input, { key: "?" });

    expect(screen.queryByRole("dialog")).toBeNull();
    input.remove();
  });
});

describe("Esc is layered, so one press means exactly one thing", () => {
  it("closes the overlay and leaves the selection untouched", async () => {
    const container = await mountWithDiagram();
    fireEvent.click(container.querySelector(".react-flow__node")!);
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    fireEvent.keyDown(window, { key: "?" });
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The exact bug the prototype's comment names: dismissing the cheat sheet
    // must not also throw away what the user had selected.
    expect(selectedNodes(container)).toBe(1);
  });

  it("clears the selection once the overlay is out of the way", async () => {
    const container = await mountWithDiagram();
    fireEvent.click(container.querySelector(".react-flow__node")!);
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(selectedNodes(container)).toBe(0));
  });

  it("dismisses the agent's emphasis", async () => {
    const container = await mountWithDiagram();
    await waitFor(() => {
      expect(container.querySelector(".archer-emph-legend")).not.toBeNull();
    });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(container.querySelector(".archer-emph-legend")).toBeNull();
    });
  });
});

describe("selecting everything", () => {
  it("selects every node and edge on Cmd+A", async () => {
    const container = await mountWithDiagram();

    fireEvent.keyDown(window, { key: "a", metaKey: true });

    await waitFor(() => expect(selectedNodes(container)).toBe(2));
    expect(container.querySelectorAll(".react-flow__edge.selected").length).toBe(1);
  });

  it("selects everything on Ctrl+A as well", async () => {
    const container = await mountWithDiagram();

    fireEvent.keyDown(window, { key: "a", ctrlKey: true });

    await waitFor(() => expect(selectedNodes(container)).toBe(2));
  });

  it("leaves a plain 'a' alone", async () => {
    const container = await mountWithDiagram();

    fireEvent.keyDown(window, { key: "a" });

    expect(selectedNodes(container)).toBe(0);
  });
});
