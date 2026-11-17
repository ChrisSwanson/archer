// @vitest-environment jsdom
//
// The assembled primary shell exposes ordinary file controls and preserves reader navigation.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { within } from "@testing-library/react";

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

const view = (id: string, title: string) => ({
  id,
  kind: "c4-context",
  title,
  registration: "durable" as const,
  sourcePath: `${id}.mmd`,
});

const VIEWS = [view("a", "Alpha"), view("b", "Bravo"), view("c", "Charlie")];

/** A readable envelope for one view, so a tab click actually lands a diagram. */
const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "data-flow", title: viewId },
  revision: `sha256:${viewId.padEnd(64, "0")}`,
  model: {
    type: "data-flow-graph",
    nodes: [{ id: "web", label: "Web" }],
    edges: [],
    groups: [],
  },
});

function stubRoutes(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const viewId = url.startsWith("api/diagrams/") ? url.slice("api/diagrams/".length) : null;
      const body =
        url === "api/diagrams" ? { schemaVersion: 1, views: VIEWS } : viewId !== null ? envelope(viewId) : null;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

async function mount(): Promise<HTMLElement> {
  serveOverHttp();
  stubRoutes();
  render(<App />);
  return screen.findByRole("region", { name: "Project documents" });
}

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

describe("the project page's files", () => {
  it("opens files from ordinary buttons; the only tabs are the browser's own Folders, Diagrams and Notes", async () => {
    const files = await mount();
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    expect(screen.getAllByRole("tablist").map((list) => list.getAttribute("aria-label"))).toEqual(["Project content"]);
    expect(within(files).queryAllByRole("tab")).toHaveLength(0);
    for (const title of ["Alpha", "Bravo", "Charlie"])
      expect(within(files).getByRole("button", { name: title })).toBeEnabled();
  });
  it("focus alone does not fetch or turn a diagram", async () => {
    const files = await mount();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    act(() => within(files).getByRole("button", { name: "Bravo" }).focus());
    expect(fetchMock.mock.calls.some((call) => call[0] === "api/diagrams/b")).toBe(false);
  });
  it("loads the exact registered diagram and names it as the current page", async () => {
    const files = await mount();
    fireEvent.click(within(files).getByRole("button", { name: "Bravo" }));
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Project documents" })).toBeNull();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Bravo");
    // A diagram at the root of the Archer folder sits under the project itself, with no made-up folder.
    expect(
      within(breadcrumb)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Project"]);
    expect(within(breadcrumb).getByText("Bravo")).toHaveAttribute("aria-current", "page");
  });
  it("searches every registered file from the search page, and says honestly when nothing matches", async () => {
    await mount();
    fireEvent.keyDown(window, { key: "/" });
    const box = screen.getByRole("searchbox", { name: "Search projects and files" });
    fireEvent.change(box, { target: { value: "bravo" } });
    const results = screen.getByRole("region", { name: "Project documents" });
    expect(within(results).queryByRole("button", { name: "Alpha" })).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(within(results).getByRole("button", { name: "Bravo" })).toBeInTheDocument();
    expect(within(results).queryByRole("button", { name: "Alpha" })).toBeNull();
    fireEvent.change(box, { target: { value: "missing" } });
    expect(within(results).queryByRole("button", { name: "Bravo" })).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Nothing matches “missing”.")).toBeInTheDocument();
  });
  it("lets long names and paths wrap on a phone rather than widen the page", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/ProjectPages.css"), "utf8");
    expect(css).toMatch(/\.archer-files-frame\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.archer-files-open\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
