// @vitest-environment jsdom
//
// App navigation follows the primary Files directory: the keys that step
// between diagrams, the project page across window widths, and the project's
// name in the breadcrumb.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { projectNameFromPath } from "../src/app/project-name";
import { MockEventSource } from "./app-harness";
import { installViewport, type Viewport } from "./match-media";

const view = (id: string, title: string, kind: string) => ({ id, kind, title, registration: "durable" as const });

const VIEWS = [
  view("compile", "Compile pipeline", "data-flow"),
  view("orders", "Order lifecycle", "state"),
  view("shop", "Web shop containers", "c4-container"),
  view("checkout", "Checkout journey", "journey"),
];

const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "data-flow", title: viewId },
  revision: `sha256:${"0".repeat(63)}${VIEWS.findIndex((v) => v.id === viewId) + 1}`,
  model: { type: "data-flow-graph", nodes: [{ id: "web", label: "Web" }], edges: [], groups: [] },
});

const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, "location")!;

/** Served over HTTP at `pathname`, as the TypeScript service serves a project's page. */
function serveAt(pathname: string): void {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? "http:" : key === "pathname" ? pathname : Reflect.get(target, key)),
    }),
  });
}

let fetched: string[];

function stubRoutes(): void {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      // This fixture models the original single-project service, with no catalog API.
      if (url === "api/browser-projects" || url === "api/projects")
        return Promise.resolve({ ok: false, status: 404, json: async () => null });
      const viewId = url.startsWith("api/diagrams/") ? url.slice("api/diagrams/".length) : null;
      const body =
        url === "api/diagrams"
          ? { schemaVersion: 1, views: VIEWS }
          : url === "api/compile"
            ? { schemaVersion: 1, failures: [] }
            : viewId !== null
              ? envelope(viewId)
              : null;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

let moveWindow: (next: Viewport) => void;

async function mount(
  viewport: Viewport = { width: 1440, coarse: false },
  pathname = "/projects/web-shop/",
): Promise<void> {
  moveWindow = installViewport(viewport);
  serveAt(pathname);
  stubRoutes();
  await act(async () => {
    render(<App />);
  });
  // Await the complete rendered inventory, then flush the passive shortcut
  // handler effect before a test sends its first window-level keystroke.
  await waitFor(() => {
    const shown = [...document.querySelectorAll("[data-browser-row][data-target]")]
      .map((row) => row.getAttribute("data-target")?.slice("view:".length))
      .sort();
    expect(shown).toEqual(VIEWS.map((entry) => entry.id).sort());
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });
  await act(async () => {});
}

const selectedDocument = (): string | null =>
  document.querySelector(".primary-document-identity h1")?.textContent ?? null;

/** Waits for `viewId`'s envelope to be asked for: the click reached the page. */
async function loaded(viewId: string): Promise<void> {
  await waitFor(() => expect(fetched).toContain(`api/diagrams/${viewId}`));
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

describe("keys for moving between diagrams", () => {
  it("] and [ step to the next and previous diagram, wrapping at the ends", async () => {
    await mount();

    await act(async () => {
      fireEvent.keyDown(window, { key: "]" });
    });
    await waitFor(() => expect(selectedDocument()).toContain("Compile pipeline"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "]" });
    });
    await waitFor(() => expect(selectedDocument()).toContain("Order lifecycle"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "[" });
    });
    await waitFor(() => expect(selectedDocument()).toContain("Compile pipeline"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "[" });
    });
    await waitFor(() => expect(selectedDocument()).toContain("Checkout journey"));
  });

  it("G opens the search page with its box ready", async () => {
    await mount();
    act(() => {
      fireEvent.keyDown(window, { key: "g" });
    });
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toHaveFocus());
  });

  it("leaves the keys alone while someone types, or with a modifier held", async () => {
    await mount();
    const search = screen.getByRole("searchbox");
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "]" });
    fireEvent.keyDown(field, { key: "g" });
    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
    fireEvent.keyDown(window, { key: "g", metaKey: true });
    field.remove();

    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).not.toHaveFocus();
    expect(fetched.some((url) => url.startsWith("api/diagrams/"))).toBe(false);
  });

  it("does nothing under the cheat sheet, which promises the page is untouched", async () => {
    await mount();
    const search = screen.getByRole("searchbox");
    act(() => {
      fireEvent.keyDown(window, { key: "?" });
    });
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "g" });
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).not.toHaveFocus();
    expect(fetched.some((url) => url.startsWith("api/diagrams/"))).toBe(false);
  });
});

describe("the primary directory across window widths", () => {
  it("opens diagrams from the project page on a phone, names the selected document in full, and lists it as recent", async () => {
    await mount({ width: 390, coarse: true });
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    expect(screen.queryByRole("button", { name: "All diagrams" })).toBeNull();
    const files = screen.getByRole("region", { name: "Project documents" });
    await act(async () => {
      fireEvent.click(within(files).getByRole("button", { name: "Web shop containers" }));
    });
    await loaded("shop");
    await waitFor(() => expect(selectedDocument()).toContain("Web shop containers"));
    expect(screen.queryByRole("region", { name: "Project documents" })).toBeNull();
    // The drawer's Recent says where the reader is.
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(
      within(screen.getByRole("navigation", { name: "Recent" })).getByRole("button", { name: /^Web shop containers/ }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("keeps the same project page when the window widens", async () => {
    await mount({ width: 390, coarse: true });
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    act(() => moveWindow({ width: 1024, coarse: false }));
    expect(screen.queryByRole("tablist", { name: "Diagrams" })).toBeNull();
    const files = screen.getByRole("region", { name: "Project documents" });
    for (const view of VIEWS) expect(within(files).getByRole("button", { name: view.title })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All diagrams" })).toBeNull();
  });
});

describe("the project's name", () => {
  it("is read from the page's own address, as the TypeScript service serves it", () => {
    expect(projectNameFromPath("/projects/web-shop/")).toBe("web-shop");
    expect(projectNameFromPath("/projects/archer/notes/a.md")).toBe("archer");
    // The service-wide page, an embedded view and anything else carry no project; so does a retired
    // token-prefixed address.
    expect(projectNameFromPath("/")).toBeUndefined();
    expect(projectNameFromPath("/projects/")).toBeUndefined();
    expect(projectNameFromPath("/3f9a/p/web-shop-1a2b3c4d/")).toBeUndefined();
  });

  it("is shown in the title bar beside the mark", async () => {
    await mount();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByText("web-shop")).toBeInTheDocument();
  });

  it("is absent where the address names no project", async () => {
    await mount(undefined, "/");
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Project");
    expect(within(breadcrumb).queryByText("web-shop")).toBeNull();
  });
});
