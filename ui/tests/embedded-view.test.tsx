// @vitest-environment jsdom
//
// Slice C on the page (ADR 0012): a diagram drawn in a note opens in the
// canvas at ?view=<address>; the breadcrumb reads project / notes / auth.md /
// login-flow, its note segment returns to the note where the reader was, the
// header says how fresh the note is, and a diagram that leaves its note says
// so in the existing moved-or-deleted notice.
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
import { filesTable } from "./support/primary-navigation";
import { CONNECTION, MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

const ADDRESS = "notes/auth.md#login-flow";
const FILE_VIEW = {
  id: "system",
  kind: "freeform",
  title: "System",
  registration: "durable",
  sourcePath: "system.mmd",
};
const EMBEDDED_VIEW = {
  id: ADDRESS,
  kind: "freeform",
  title: "Login flow",
  registration: "embedded",
  sourcePath: "notes/auth.md",
  note: "notes/auth.md",
  name: "login-flow",
};
const FRESHNESS = { status: "committed", commit: "1a2b3c4", committedAt: "2026-10-07T09:30:00Z", uncommitted: false };
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
const ENVELOPE = {
  schemaVersion: 2,
  view: { id: ADDRESS, kind: "freeform", title: "Login flow" },
  revision: `sha256:${"2".repeat(64)}`,
  model: {
    type: "freeform-graph",
    nodes: [
      { id: "api", label: "API" },
      { id: "user", label: "User" },
    ],
    edges: [{ id: "e1", source: "user", target: "api" }],
    groups: [],
  },
};

let views: unknown[] = [FILE_VIEW, EMBEDDED_VIEW];

function mount(search = ""): void {
  serveOverHttp();
  window.history.replaceState(null, "", `/${search}`);
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const route = url.split("?")[0]!;
      const body =
        route === "api/connection"
          ? CONNECTION
          : route === "api/bootstrap"
            ? { capabilities: { comments: true, notes: true }, project: { name: "archer" } }
            : route === "api/diagrams"
              ? { schemaVersion: 1, views }
              : route === `api/diagrams/${encodeURIComponent(ADDRESS)}`
                ? ENVELOPE
                : route === "api/compile"
                  ? { schemaVersion: 1, failures: [] }
                  : route.startsWith("api/emphasis/")
                    ? { schemaVersion: 1, viewId: ADDRESS, emphases: [] }
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
                              envelope: ENVELOPE,
                              freshness: FRESHNESS,
                            }
                          : route === "api/comments"
                            ? { schemaVersion: 2, target: `view:${ADDRESS}`, threads: [] }
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

const breadcrumb = (): HTMLElement => screen.getByRole("navigation", { name: "Breadcrumb" });
const crumbs = (): string[] =>
  [...breadcrumb().querySelectorAll("button, [aria-current]")].map((el) => el.textContent ?? "");

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T12:00:00Z"));
  MockEventSource.instances = [];
  views = [FILE_VIEW, EMBEDDED_VIEW];
  // Figures wait for the screen; here nothing ever scrolls, which is enough to open one.
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
  vi.restoreAllMocks();
  cleanup();
  window.history.replaceState(null, "", "/");
  restoreLocation();
  vi.unstubAllGlobals();
});

describe("a diagram embedded in a note", () => {
  it("opens from the note, with the note in the breadcrumb and its freshness in the header, and goes back to it", async () => {
    mount("?note=notes%2Fauth.md");
    const link = await screen.findByRole("link", { name: "Open login-flow, Flowchart" });
    expect(link).toHaveAttribute("href", `?view=${encodeURIComponent(ADDRESS)}`);
    fireEvent.click(link);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2));
    expect(crumbs()).toEqual(["archer", "notes", "auth.md", "login-flow"]);
    expect(within(breadcrumb()).getByText("login-flow")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Login flow" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("banner")).toHaveTextContent(/Committed \dd ago/));

    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "auth.md" }));
    const back = await screen.findByRole("link", { name: "Open login-flow, Flowchart" });
    await waitFor(() => expect(back).toHaveFocus());
  });

  it("opens straight from its address, and is listed as a diagram of its own beside the file diagrams", async () => {
    mount(`?view=${encodeURIComponent(ADDRESS)}`);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2));
    expect(crumbs()).toEqual(["archer", "notes", "auth.md", "login-flow"]);
    const files = await filesTable();
    expect(within(files).getByRole("button", { name: "Login flow" })).toBeInTheDocument();
    expect(within(files).getByRole("button", { name: "System" })).toBeInTheDocument();
  });

  it("says so when it leaves its note, and still offers the note", async () => {
    mount(`?view=${encodeURIComponent(ADDRESS)}`);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2));
    views = [FILE_VIEW];
    act(() => MockEventSource.instances[0]!.emit("inventory", { schemaVersion: 1, views }));
    expect(await screen.findByText("This diagram is no longer in its note.")).toBeInTheDocument();
    expect(screen.getByText(/notes\/auth\.md has no diagram named login-flow now/)).toBeInTheDocument();
    expect(crumbs()).toEqual(["archer", "notes", "auth.md", "login-flow"]);
  });

  it("offers no revision compare or accuracy check, which only file diagrams have", async () => {
    mount(`?view=${encodeURIComponent(ADDRESS)}`);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
    expect(screen.queryByRole("button", { name: "Compare revisions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check diagram accuracy" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export diagram" })).toBeInTheDocument();
  });
});
