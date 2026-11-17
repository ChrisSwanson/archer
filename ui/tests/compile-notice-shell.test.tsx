import { fileButton } from "./support/primary-navigation";
// @vitest-environment jsdom
//
// The compile-failure notice in the real `App`, over the real bridge: when it
// appears, what it leaves alone, and what a selection made under it means.
//
// Mounted the AGENT-PRESENTED way (see `app-harness.tsx`), because the
// selection half of this is about what reaches the host.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  toolResultHandler: undefined as ((result: unknown) => void) | undefined,
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(event: string, handler: (result: unknown) => void): void {
      if (event === "toolresult") {
        appMock.toolResultHandler = handler;
      }
    }
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { PageShell } from "../src/app/page-shell";
import {
  ENVELOPE,
  MockEventSource,
  VIEWS,
  mountAgentPresented,
  publishedNodeIds,
  restoreLocation,
  fetchCalls,
  selectionPosts,
  serveOverHttp,
  settle,
  stubRoutes,
} from "./app-harness";
import { loadValidFixture } from "./fixtures";

const BROKEN_REVISION = `sha256:${"b".repeat(64)}`;

function failing(viewId: string, lastValidRevision: string | null = ENVELOPE.revision): unknown {
  return {
    schemaVersion: 1,
    failures: [
      {
        viewId,
        sourceRevision: BROKEN_REVISION,
        lastValidRevision,
        diagnostics: [
          {
            code: "expected_label",
            message: "expected a label inside delimiters",
            span: { start: { line: 2, column: 9 }, end: { line: 2, column: 10 } },
          },
        ],
      },
    ],
  };
}

const NOTHING_FAILING = { schemaVersion: 1, failures: [] };

const TWO_VIEWS = [...VIEWS, { id: "beta", kind: "sequence", title: "Beta", registration: "ephemeral" as const }];

const nodeCount = (container: HTMLElement): number => container.querySelectorAll(".react-flow__node").length;

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  appMock.toolResultHandler = undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

describe("a failed compile of the view on screen", () => {
  it("puts the notice over the last valid drawing, and a fix takes it away", async () => {
    const { container, source } = await mountAgentPresented(<PageShell />);
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => source.emit("compile", failing("alpha")));

    expect(screen.getByRole("alert")).toHaveTextContent(/no longer compiles/i);
    expect(within(screen.getByRole("list", { name: "Problems" })).getByRole("listitem")).toHaveTextContent(
      "Line 2, column 9",
    );
    // The drawing is still the drawing: nothing was unmounted to make room.
    expect(nodeCount(container)).toBe(2);

    act(() => source.emit("compile", NOTHING_FAILING));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(nodeCount(container)).toBe(2);
  });

  it("is shown by a page that opened after the failure", async () => {
    await mountAgentPresented(<PageShell />, { compile: failing("alpha") });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no longer compiles/i));
  });

  it("forgets that it was collapsed once the failure is over", async () => {
    const { source } = await mountAgentPresented(<PageShell />);
    act(() => source.emit("compile", failing("alpha")));
    fireEvent.click(screen.getByRole("button", { name: "Hide problems" }));
    expect(screen.queryByRole("list", { name: "Problems" })).toBeNull();

    act(() => source.emit("compile", NOTHING_FAILING));
    act(() => source.emit("compile", failing("alpha")));

    // A new failure is news; a collapsed notice would hide that it happened.
    expect(screen.getByRole("list", { name: "Problems" })).toBeInTheDocument();
  });

  it("keeps the drawing selectable, and publishes the selection against the revision on screen", async () => {
    // The revision a selection carries is the revision of the MODEL. While the
    // source is broken the model the server serves is still the last valid
    // one, so this is the stamp the server accepts (`live_reload.rs`).
    const { container, source } = await mountAgentPresented(<PageShell />);
    act(() => source.emit("compile", failing("alpha")));
    const before = selectionPosts().length;

    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(container.querySelector('.react-flow__node[data-id="web"]')!);

    await waitFor(() => expect(selectionPosts().length).toBeGreaterThan(before));
    const [, init] = selectionPosts().at(-1) as [string, { body: string }];
    const published = JSON.parse(init.body) as { revision: string; nodes: { id: string }[] };
    expect(published.revision).toBe(ENVELOPE.revision);
    expect(published.nodes.map((node) => node.id)).toEqual(["web"]);
    expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(1);
  });

  it("is shown over a sequence diagram too", async () => {
    const envelope = loadValidFixture("minimal-sequence.json") as { view: { id: string }; revision: string };
    const { container, source } = await mountAgentPresented(<PageShell />, {
      envelope,
      ready: (mounted) => {
        expect(mounted.querySelector("[aria-label='Sequence diagram canvas']")).not.toBeNull();
      },
    });

    act(() => source.emit("compile", failing(envelope.view.id, envelope.revision)));

    expect(screen.getByRole("alert")).toHaveTextContent(/no longer compiles/i);
    expect(container.querySelector("[aria-label='Sequence diagram canvas']")).not.toBeNull();
  });
});

describe("a drawing the page could not replace", () => {
  it("is not selectable, unlike one whose file merely fails to compile", async () => {
    // The other "last valid drawing" state. Here the server HAS moved on -- it
    // sent a newer envelope this page could not read -- so a selection made on
    // what is still drawn would carry a revision the server no longer serves.
    const { container, source } = await mountAgentPresented(<PageShell />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() =>
      source.emit("presentation", {
        envelope: { ...ENVELOPE, schemaVersion: 999 },
        presentation: { presentationId: "agent-run", viewId: "alpha" },
        diagnostics: [],
      }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(nodeCount(container)).toBe(2);
    const before = publishedNodeIds(selectionPosts()).length;

    fireEvent.click(container.querySelector('.react-flow__node[data-id="web"]')!);
    await settle();

    expect(publishedNodeIds(selectionPosts())).toHaveLength(before);
    expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(0);
  });
});

describe("a failed compile of some other view", () => {
  it("puts no notice over the drawing on screen, and marks the failing view's tab", async () => {
    const { source } = await mountAgentPresented(<PageShell />, { views: TWO_VIEWS });

    act(() => source.emit("compile", failing("beta")));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(fileButton(/Beta/)).toHaveAccessibleName(/does not compile/);
    expect(fileButton(/Alpha/)).not.toHaveAccessibleName(/does not compile/);

    act(() => source.emit("compile", NOTHING_FAILING));

    expect(fileButton(/Beta/)).not.toHaveAccessibleName(/does not compile/);
  });

  it("marks the tab of the view on screen as well", async () => {
    const { source } = await mountAgentPresented(<PageShell />, { views: TWO_VIEWS });

    act(() => source.emit("compile", failing("alpha")));

    expect(fileButton(/Alpha/)).toHaveAccessibleName(/does not compile/);
  });
});

describe("a view that has never compiled", () => {
  it("says so when its tab is picked, instead of leaving the other drawing up", async () => {
    const { container, source } = await mountAgentPresented(<PageShell />, { views: TWO_VIEWS });
    act(() => source.emit("compile", failing("beta", null)));
    const fetches = (): number => fetchCalls().filter((url) => url === "api/diagrams/beta").length;

    fireEvent.click(fileButton(/Beta/));

    // There is no envelope to ask for, so it does not ask.
    expect(fetches()).toBe(0);
    expect(screen.getByRole("status")).toHaveTextContent("This diagram has not compiled yet.");
    expect(screen.getByRole("alert")).toHaveTextContent(/no earlier version to show/i);
    expect(within(screen.getByRole("list", { name: "Problems" })).getByRole("listitem")).toHaveTextContent(
      "Line 2, column 9",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Beta/);
    expect(nodeCount(container)).toBe(0);

    // The file is fixed: the view is read and drawn without another click.
    act(() => source.emit("compile", NOTHING_FAILING));

    await waitFor(() => expect(fetches()).toBe(1));
    await waitFor(() => expect(nodeCount(container)).toBe(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gives way to whatever the agent presents next", async () => {
    const { container, source } = await mountAgentPresented(<PageShell />, { views: TWO_VIEWS });
    act(() => source.emit("compile", failing("beta", null)));
    fireEvent.click(fileButton(/Beta/));
    expect(nodeCount(container)).toBe(0);

    act(() =>
      source.emit("presentation", {
        envelope: ENVELOPE,
        presentation: { presentationId: "agent-again", viewId: "alpha" },
        diagnostics: [],
      }),
    );

    await waitFor(() => expect(nodeCount(container)).toBe(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Alpha/);
  });
});

describe("a failure with nothing drawn", () => {
  it("shows no notice claiming a drawing is stale when there is no drawing", async () => {
    serveOverHttp();
    stubRoutes({ compile: failing("alpha") });
    render(<PageShell />);

    // The page says what it has to say about having nothing presented...
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    // ...and does not put "this is the last version that compiled" over nothing.
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(fileButton(/Alpha/)).toHaveAccessibleName(/does not compile/));
  });
});

describe("inside an MCP host", () => {
  it("learns of the failure from the tool result that presents the view, and of the fix from the next", async () => {
    // The shell is chosen by protocol; anything that is not http(s) is a host.
    const real = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new Proxy(real, {
        get: (target, key) => (key === "protocol" ? "ui:" : Reflect.get(target, key)),
      }),
    });
    const { container } = render(<PageShell />);
    await waitFor(() => expect(appMock.toolResultHandler).toBeDefined());
    const present = (compile: unknown): void =>
      act(() =>
        appMock.toolResultHandler?.({
          structuredContent: {
            envelope: ENVELOPE,
            presentation: { presentationId: "agent-run", viewId: "alpha" },
            diagnostics: [],
            compile,
          },
        }),
      );

    present(failing("alpha"));

    await waitFor(() => expect(nodeCount(container)).toBe(2));
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer compiles/i);

    present(NOTHING_FAILING);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(nodeCount(container)).toBe(2);
  });
});
