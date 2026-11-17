// @vitest-environment jsdom
//
// The page's address follows what is on screen. Every place the READER goes in
// the project -- a diagram, a note, a diagram drawn in a note, a folder, the
// overview -- is written to the address as a new history entry (`?view=`,
// `?note=`, `?folder=`, `?overview=1`), so a reload or a shared link opens it
// and Back walks back through it. The AGENT presenting replaces the entry
// instead: the reader did not go anywhere. The address the page loads with is
// left alone until something navigates.
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
import { openFile } from "./support/primary-navigation";
import { CONNECTION, MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

const ADDRESS = "notes/auth.md#login-flow";
const VIEWS = [
  {
    id: "system-context",
    kind: "freeform",
    title: "System context",
    registration: "durable",
    sourcePath: "system-context.mmd",
  },
  {
    id: "delivery-handoff",
    kind: "freeform",
    title: "Delivery handoff",
    registration: "durable",
    sourcePath: "delivery-handoff.mmd",
  },
  { id: "billing", kind: "freeform", title: "Billing", registration: "durable", sourcePath: "billing.mmd" },
  {
    id: ADDRESS,
    kind: "freeform",
    title: "Login flow",
    registration: "embedded",
    sourcePath: "notes/auth.md",
    note: "notes/auth.md",
    name: "login-flow",
  },
];
const MARKDOWN =
  '# Auth\n\n## Login flow\n\n```mermaid\nflowchart LR\n  user["User"] e1@--> api["API"]\n```\n\nProse.\n';
const SUMMARY = {
  name: "login-flow",
  address: ADDRESS,
  explicit: false,
  ordinal: 1,
  heading: "Login flow",
  kind: "freeform",
  line: 5,
  bodyLine: 6,
  writable: true,
  sourceRevision: `sha256:${"1".repeat(64)}`,
};
const FRESHNESS = { status: "committed", commit: "1a2b3c4", committedAt: "2026-10-07T09:30:00Z", uncommitted: false };

/** Each view draws one node named after it, so what is on screen is readable. */
const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "freeform", title: viewId },
  revision: `sha256:${String(VIEWS.findIndex((v) => v.id === viewId)).padEnd(64, "0")}`,
  model: { type: "freeform-graph", nodes: [{ id: "n", label: `node of ${viewId}` }], edges: [], groups: [] },
});

/** Mount the page on `search`, with `standing` what the agent was presenting when it opened. */
function mount(search = "", standing = "system-context", path = "/"): void {
  serveOverHttp();
  window.history.replaceState(null, "", `${path}${search}`);
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const route = url.split("?")[0]!;
      const viewId = route.startsWith("api/diagrams/") ? decodeURIComponent(route.slice("api/diagrams/".length)) : null;
      const body =
        route === "api/connection"
          ? CONNECTION
          : route === "api/bootstrap"
            ? {
                capabilities: { comments: true, notes: true },
                project: { name: "courierdesk" },
                envelope: envelope(standing),
                presentation: { presentationId: "p0", viewId: standing },
                diagnostics: [],
              }
            : route === "api/diagrams"
              ? { schemaVersion: 1, views: VIEWS }
              : viewId !== null && VIEWS.some((view) => view.id === viewId)
                ? envelope(viewId)
                : route === "api/compile"
                  ? { schemaVersion: 1, failures: [] }
                  : route.startsWith("api/emphasis/")
                    ? {
                        schemaVersion: 1,
                        viewId: decodeURIComponent(route.slice("api/emphasis/".length)),
                        emphases: [],
                      }
                    : route === "api/notes/all"
                      ? { notes: [{ path: "notes/auth.md", title: "Auth", diagrams: [], viewIds: [] }] }
                      : route === "api/notes/content"
                        ? {
                            path: "notes/auth.md",
                            frontMatter: {},
                            markdown: MARKDOWN,
                            revision: "r1",
                            diagrams: [SUMMARY],
                            freshness: FRESHNESS,
                          }
                        : route === "api/notes/diagram"
                          ? {
                              ...SUMMARY,
                              notePath: "notes/auth.md",
                              source: "flowchart LR\n",
                              diagnostics: [],
                              envelope: envelope(ADDRESS),
                              freshness: FRESHNESS,
                            }
                          : route === "api/comments"
                            ? { schemaVersion: 2, target: "view:x", threads: [] }
                            : route === "api/comments/pending"
                              ? { total: 0, targets: [] }
                              : null;
      return Promise.resolve({
        ok: body !== null,
        status: body === null ? 404 : 200,
        json: () => Promise.resolve(body),
      });
    }),
  );
  render(<App />);
  queueMicrotask(() => MockEventSource.instances[0]?.onopen?.(new Event("open")));
}

let presentations = 0;
/** The agent presents `viewId`, as `present_diagram` does. */
async function agentPresents(viewId: string): Promise<void> {
  await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
  presentations += 1;
  act(() => {
    MockEventSource.instances[0]!.emit("presentation", {
      envelope: envelope(viewId),
      presentation: { presentationId: `p${presentations}`, viewId },
      diagnostics: [],
    });
  });
  await shows(viewId);
}

const shows = async (viewId: string): Promise<void> => {
  // A long label wraps, so the words are compared without the breaks.
  await waitFor(() =>
    expect(document.querySelector(".react-flow__node")?.textContent?.replace(/\s/g, "")).toBe(`nodeof${viewId}`),
  );
};

/** Open a diagram or note from the project page, as a reader does: going there first is a place of its own. */
async function openFromFiles(title: string): Promise<void> {
  await openFile(title);
}

const param = (key: string): string | null => new URLSearchParams(window.location.search).get(key);
const breadcrumb = (): HTMLElement => screen.getByRole("navigation", { name: "Breadcrumb" });
const current = (): string | null => breadcrumb().querySelector('[aria-current="page"]')?.textContent ?? null;

beforeEach(() => {
  MockEventSource.instances = [];
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  restoreLocation();
  vi.unstubAllGlobals();
});

describe("the stable project browser", () => {
  it("updates the project's real search address while typing while retaining the field, gallery and focus", async () => {
    mount("?overview=1", "system-context");
    const input = await screen.findByRole("searchbox", { name: "Search projects and files" });
    // The documents wait for the page's own listings (PF-6), so they can arrive after the field.
    const table = await screen.findByRole("region", { name: "Project documents" });
    const filters = screen.getByRole("button", { name: "Filters" });
    const length = window.history.length;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "billing" } });
    expect(param("q")).toBe("billing");
    expect(param("overview")).toBeNull();
    expect(screen.getByRole("region", { name: "Project documents" })).toBe(table);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(param("q")).toBe("billing"));
    expect(param("project")).toBeNull();
    expect(param("overview")).toBeNull();
    expect(window.history.length).toBe(length + 1);
    expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(input);
    expect(screen.getByRole("region", { name: "Project documents" })).toBe(table);
    expect(screen.getByRole("button", { name: "Filters" })).toBe(filters);
    expect(input).toHaveFocus();
    fireEvent.click(within(table).getByRole("button", { name: "Billing" }));
    await shows("billing");
    act(() => window.history.back());
    expect(await screen.findByRole("searchbox", { name: "Search projects and files" })).toHaveValue("billing");
    expect(param("project")).toBeNull();
  });

  it.each(["/", "g", "G"])("%s focuses the overview's field while retaining its project scope and URL", async (key) => {
    mount("?overview=1", "system-context");
    const input = await screen.findByRole("searchbox", { name: "Search projects and files" });
    // The documents wait for the page's own listings (PF-6), so they can arrive after the field.
    const table = await screen.findByRole("region", { name: "Project documents" });
    fireEvent.keyDown(window, { key });
    expect(input).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(input);
    expect(screen.getByRole("region", { name: "Project documents" })).toBe(table);
    expect(param("overview")).toBe("1");
    expect(param("q")).toBeNull();
    fireEvent.change(input, { target: { value: "billing" } });
    expect(param("project")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Notes/ }));
    expect(param("kind")).toBe("note");
    expect(param("q")).toBe("billing");
    fireEvent.click(screen.getByRole("button", { name: "Close filters" }));
    act(() => input.blur());
    fireEvent.keyDown(window, { key });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("billing");
    expect(param("project")).toBeNull();
    expect(param("kind")).toBe("note");
  });

  it("uses the service's project name when matching the overview's rows", async () => {
    mount("?overview=1", "system-context");
    const input = await screen.findByRole("searchbox", { name: "Search projects and files" });
    await waitFor(() => expect(document.querySelectorAll("[data-browser-row]")).toHaveLength(5));
    fireEvent.change(input, { target: { value: "courierdesk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(param("q")).toBe("courierdesk");
    expect(document.querySelectorAll("[data-browser-row]")).toHaveLength(5);
    expect(param("project")).toBeNull();
  });
});

describe("the address of a diagram the reader opens", () => {
  it("is written when they open one from the project page on a page that loaded with a bare address", async () => {
    mount("", "delivery-handoff");
    await shows("delivery-handoff");
    expect(window.location.search).toBe("");

    await openFromFiles("System context");
    await shows("system-context");
    expect(param("view")).toBe("system-context");
  });

  it("moves with every diagram they open, so a reload opens the one on screen", async () => {
    mount("?view=system-context");
    await shows("system-context");
    await openFromFiles("Delivery handoff");
    await shows("delivery-handoff");
    expect(current()).toBe("Delivery handoff");
    expect(param("view")).toBe("delivery-handoff");

    // The tab-strip shortcut is a reader's navigation too.
    fireEvent.keyDown(window, { key: "]" });
    await shows("billing");
    expect(param("view")).toBe("billing");
  });

  it("is one history entry per place, and Back and Forward walk the diagrams, notes and note diagrams opened, and the project page between them", async () => {
    mount();
    await shows("system-context");
    const start = window.history.length;
    const onProjectPage = async (): Promise<void> => {
      await screen.findByRole("region", { name: "Project documents" });
      expect(param("overview")).toBe("1");
    };

    await openFromFiles("Delivery handoff");
    await shows("delivery-handoff");
    await openFromFiles("Auth");
    const figure = await screen.findByRole("link", { name: "Open login-flow, Flowchart" });
    expect(param("note")).toBe("notes/auth.md");
    expect(param("view")).toBeNull();
    fireEvent.click(figure);
    await shows(ADDRESS);
    expect(param("view")).toBe(ADDRESS);
    // The project page, the diagram, the project page, the note, its diagram.
    expect(window.history.length).toBe(start + 5);

    act(() => window.history.back());
    expect(await screen.findByRole("link", { name: "Open login-flow, Flowchart" })).toBeInTheDocument();
    expect(param("note")).toBe("notes/auth.md");
    act(() => window.history.back());
    await onProjectPage();
    act(() => window.history.back());
    await shows("delivery-handoff");
    await waitFor(() => expect(current()).toBe("Delivery handoff"));
    expect(param("view")).toBe("delivery-handoff");
    act(() => window.history.forward());
    await onProjectPage();
    act(() => window.history.forward());
    await screen.findByRole("link", { name: "Open login-flow, Flowchart" });
    act(() => window.history.forward());
    await shows(ADDRESS);
    await waitFor(() => expect(current()).toBe("login-flow"));
    expect(window.history.length).toBe(start + 5);
  });

  it("goes back to the overview and to the page's first place", async () => {
    mount();
    await shows("system-context");
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "courierdesk" }));
    await screen.findByRole("region", { name: "Project documents" });
    expect(param("overview")).toBe("1");
    await openFromFiles("Billing");
    await shows("billing");
    expect(param("overview")).toBeNull();

    act(() => window.history.back());
    expect(await screen.findByRole("region", { name: "Project documents" })).toBeInTheDocument();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("region", { name: "Project documents" })).toBeNull());
    await shows("system-context");
    expect(window.location.search).toBe("");
  });
});

describe("the address when the agent presents", () => {
  it("follows the agent without adding a history entry", async () => {
    mount();
    await shows("system-context");
    await openFromFiles("Delivery handoff");
    await shows("delivery-handoff");
    const length = window.history.length;

    await agentPresents("billing");
    expect(param("view")).toBe("billing");
    expect(window.history.length).toBe(length);
  });

  it("leaves a bare address bare for what the agent was already presenting", async () => {
    mount();
    await shows("system-context");
    expect(window.location.search).toBe("");
  });
});

// Ruling 2026-11-03: the page never publishes a selection because it opened. Only a person's selection (or
// their turning to another view, ADR 0011) is published; until then an agent's `get_presentation_context` has none.
describe("the selection when a page opens", () => {
  const selectionWrites = (): unknown[] =>
    (vi.mocked(fetch).mock.calls as [string, RequestInit?][]).filter(
      ([url, init]) => url === "api/selection" && init?.method === "POST",
    );
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it.each([
    ["a diagram of the reader's own", "?view=billing", "billing"],
    ["the agent's presented diagram", "?view=system-context", "system-context"],
  ])("publishes nothing when the address opens %s", async (_what, search, viewId) => {
    mount(search);
    await shows(viewId);
    await waitFor(() => expect(MockEventSource.instances[0]?.onopen).toBeTypeOf("function"));
    await settle();
    expect(selectionWrites()).toEqual([]);
  });

  it("publishes the person's selection once they make one", async () => {
    mount("?view=billing");
    await shows("billing");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="n"]')!);
    await settle();
    expect(selectionWrites()).toHaveLength(1);
    expect(JSON.parse((selectionWrites()[0] as [string, RequestInit])[1].body as string)).toMatchObject({
      viewId: "billing",
      presentationId: "reader:billing",
      nodes: [expect.objectContaining({ id: "n" })],
    });
  });
});
