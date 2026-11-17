// @vitest-environment jsdom
//
// Round 1 pass 6, fixer C (F23's V5 fixtures, P3.offline and P7.loading).
// - A note whose event stream drops says so, as the diagram page does ("Reconnecting to Archer…"), and stops saying
//   so once the stream is back.
// - The project review does not claim "No discussions yet" while its first comment-activity read is still out.
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
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
import { ReviewPanel } from "../src/comments/ReviewPanel";
import { createReviewEvents } from "../src/comments/events";
import { useReview, type ReviewModel } from "../src/comments/useReview";
import type { TargetRef } from "../src/comments/contract";
import { resources } from "../src/app/resources";
import { CONNECTION, MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";
import { memoryTransport } from "./support/memory-transport";
import { installMatchMedia } from "./match-media";
import { NO_CAPABILITIES } from "../src/comments/contract";

afterEach(() => {
  cleanup();
  resources.forget();
  window.history.replaceState(null, "", "/");
  restoreLocation();
  vi.unstubAllGlobals();
});

describe("P3.offline: a note says when its page is no longer live", () => {
  const VIEW = { id: "system", kind: "freeform", title: "System", registration: "durable", sourcePath: "system.mmd" };
  const ENVELOPE = {
    schemaVersion: 2,
    view: { id: "system", kind: "freeform", title: "System" },
    revision: `sha256:${"2".repeat(64)}`,
    model: { type: "freeform-graph", nodes: [{ id: "a", label: "A" }], edges: [], groups: [] },
  };
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

  it("shows the reconnect cue over a note when the stream drops, once, and withdraws it when the page is current again", async () => {
    serveOverHttp();
    window.history.replaceState(null, "", "/projects/p/notes/auth.md");
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn((requested: string) => {
        const route = requested.replace(/^.*?(?=api\/)/, "").split("?")[0]!;
        const body =
          route === "api/connection"
            ? CONNECTION
            : route === "api/bootstrap"
              ? { capabilities: { comments: true, notes: true }, project: { name: "p" } }
              : route === "api/diagrams"
                ? { schemaVersion: 1, views: [VIEW] }
                : route === "api/diagrams/system"
                  ? ENVELOPE
                  : route === "api/compile"
                    ? { schemaVersion: 1, failures: [] }
                    : route.startsWith("api/emphasis/")
                      ? { schemaVersion: 1, viewId: "system", emphases: [] }
                      : route === "api/notes/all"
                        ? { notes: [{ path: "notes/auth.md", title: "Auth", diagrams: [], viewIds: [] }] }
                        : route === "api/notes/content"
                          ? {
                              path: "notes/auth.md",
                              frontMatter: {},
                              markdown: "# Auth\n\nThe login prose.\n",
                              revision: "r1",
                              diagrams: [],
                            }
                          : route === "api/comments"
                            ? { schemaVersion: 2, target: "note:notes/auth.md", threads: [] }
                            : route === "api/comments/pending"
                              ? { total: 0, targets: [] }
                              : route === "api/comment-activity"
                                ? { schemaVersion: 1, targets: {} }
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
    await screen.findByText("The login prose.");
    expect(screen.queryByText(/Reconnecting to Archer/)).toBeNull();

    await act(async () => {
      MockEventSource.instances.at(-1)!.onerror?.(new Event("error"));
    });

    const cue = await screen.findByText(/Reconnecting to Archer/);
    expect(cue).toHaveAttribute("role", "status");
    expect(cue).toHaveAttribute("data-connection", "lost");
    expect(cue.textContent).toMatch(/This note may be out of date/);
    // One status, not one per region: the note's own live regions do not repeat it.
    expect(screen.getAllByText(/Reconnecting to Archer/)).toHaveLength(1);
    // The note stays readable under it.
    expect(screen.getByText("The login prose.")).toBeVisible();

    // The tab back in front asks again; the stream reopens and the page re-reads what it missed.
    const before = MockEventSource.instances.length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(before), { timeout: 5000 });
    await act(async () => {
      MockEventSource.instances.at(-1)!.onopen?.(new Event("open"));
    });
    await waitFor(() => expect(screen.queryByText(/Reconnecting to Archer|Synchronizing with Archer/)).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.getByText("The login prose.")).toBeVisible();
  });
});

describe("P7.loading: the project review waits for its first answer before saying it is empty", () => {
  const targets: readonly TargetRef[] = ["view:system", "note:notes/auth.md"];
  function hold(): { release(body: unknown): void } {
    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    return { release: (body) => release(new Response(JSON.stringify(body), { status: 200 })) };
  }

  it("useReview reports the inbox as loading until comment activity answers (none: empty)", async () => {
    const held = hold();
    const transport = memoryTransport(),
      events = createReviewEvents();
    const { result } = renderHook(() =>
      useReview({
        transport,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: null,
        events,
        targets,
      }),
    );
    await waitFor(() => expect(result.current.inboxLoading).toBe(true));
    await act(async () => {
      held.release({ schemaVersion: 1, targets: {} });
    });
    await waitFor(() => expect(result.current.inboxLoading).toBe(false));
  });

  it("useReview keeps loading until the threads the activity names have arrived", async () => {
    const held = hold();
    const transport = memoryTransport();
    transport.store.create({ target: "note:notes/auth.md", anchor: { kind: "view" }, body: "Is this right?" });
    const events = createReviewEvents();
    const { result } = renderHook(() =>
      useReview({
        transport,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: null,
        events,
        targets,
      }),
    );
    await waitFor(() => expect(result.current.inboxLoading).toBe(true));
    const seen: [boolean | undefined, number][] = [];
    await act(async () => {
      held.release({
        schemaVersion: 1,
        targets: {
          "note:notes/auth.md": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: "2026-10-30T10:00:00.000Z" },
        },
      });
    });
    await waitFor(() => {
      seen.push([result.current.inboxLoading, result.current.threads.get("note:notes/auth.md")?.length ?? 0]);
      expect(result.current.inboxLoading).toBe(false);
    });
    expect(result.current.threads.get("note:notes/auth.md")).toHaveLength(1);
    expect(seen.filter(([loading, count]) => loading === false && count === 0)).toEqual([]);
  });

  it('the review shows a quiet busy status, not "No discussions yet", while loading', () => {
    installMatchMedia(false);
    const model: ReviewModel = {
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
      viewId: "system",
      viewTarget: "view:system",
      threads: new Map(),
      notes: { status: "ready", notes: [] },
      noteContents: new Map(),
      pending: 0,
      pendingTargets: [],
      announcement: null,
      error: null,
      submitting: false,
      inboxLoading: true,
      actions: {
        create: vi.fn(async () => null),
        reply: vi.fn(async () => true),
        edit: vi.fn(async () => true),
        remove: vi.fn(async () => true),
        resolve: vi.fn(async () => true),
        dismiss: vi.fn(async () => true),
        submitAll: vi.fn(async () => {}),
        openNote: vi.fn(),
        dismissError: vi.fn(),
      },
    };
    const props = {
      mode: "floating" as const,
      open: true,
      compose: null,
      onClose: () => {},
      onCompose: () => {},
      onComposeEnd: () => {},
      diagramChoices: [],
    };
    const { rerender } = render(<ReviewPanel {...props} model={model} />);
    const review = screen.getByRole("region", { name: "Project Review" });
    expect(review.textContent).not.toMatch(/No discussions yet/);
    const loading = screen.getByText("Loading discussions…");
    expect(loading).toHaveAttribute("role", "status");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-busy", "true");

    rerender(<ReviewPanel {...props} model={{ ...model, inboxLoading: false }} />);
    expect(screen.queryByText("Loading discussions…")).toBeNull();
    expect(screen.getByRole("tabpanel")).not.toHaveAttribute("aria-busy", "true");
    expect(review.textContent).toMatch(/No discussions yet/);
  });
});

describe("P7.loading follow-up: the review's tabs claim no count before the first answer", () => {
  it("shows the tab names without counts while loading, and the counts once loaded", () => {
    installMatchMedia(false);
    const model: ReviewModel = {
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
      viewId: "system",
      viewTarget: "view:system",
      threads: new Map(),
      notes: { status: "ready", notes: [] },
      noteContents: new Map(),
      pending: 0,
      pendingTargets: [],
      announcement: null,
      error: null,
      submitting: false,
      inboxLoading: true,
      actions: {
        create: vi.fn(async () => null),
        reply: vi.fn(async () => true),
        edit: vi.fn(async () => true),
        remove: vi.fn(async () => true),
        resolve: vi.fn(async () => true),
        dismiss: vi.fn(async () => true),
        submitAll: vi.fn(async () => {}),
        openNote: vi.fn(),
        dismissError: vi.fn(),
      },
    };
    const props = {
      mode: "floating" as const,
      open: true,
      compose: null,
      onClose: () => {},
      onCompose: () => {},
      onComposeEnd: () => {},
      diagramChoices: [],
    };
    const { rerender } = render(<ReviewPanel {...props} model={model} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["All", "Unread", "Answered"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-label") ?? tab.textContent)).toEqual(["All", "Unread", "Answered"]);
    expect(screen.getByRole("tab", { name: /^Unread/ })).toHaveAttribute("aria-selected", "false");

    rerender(<ReviewPanel {...props} model={{ ...model, inboxLoading: false }} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["All0", "Unread0", "Answered0"]);
    expect(screen.getByRole("tab", { name: "All, 0 threads" })).toBeInTheDocument();
  });
});

describe("source documents use the shared connection notice", () => {
  class Source {
    static instances: Source[] = [];
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly close = vi.fn();
    constructor(readonly url: string) {
      Source.instances.push(this);
    }
    addEventListener(): void {}
  }
  const info = {
    browserProtocolMajor: 1,
    supportedBrowserProtocolMajors: [1],
    serverEpoch: "12345678-1234-1234-1234-123456789abc",
    capabilities: [],
    applicationVersion: "0.2.0",
    semanticSchemaVersion: 2,
  };

  it("says the document may be out of date while the stream is down, once, and clears after re-reading", async () => {
    const { SourceDocumentPage } = await import("../src/app/SourceDocumentPage");
    window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
    Source.instances = [];
    vi.stubGlobal("EventSource", Source);
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api/documents/content")) reads += 1;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () =>
            url.includes("api/connection")
              ? info
              : {
                  source: { path: "docs/guide.md" },
                  kind: "markdown",
                  revision: "sha256:" + "a".repeat(64),
                  text: "# Guide",
                  markdown: "# Guide",
                  embedded: [],
                },
        };
      }),
    );
    render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
    await screen.findByRole("heading", { name: "Guide" });
    await act(async () => {
      Source.instances[0]!.onopen?.(new Event("open"));
    });
    await act(async () => {
      Source.instances.at(-1)!.onerror?.(new Event("error"));
    });

    const cue = await screen.findByText("Reconnecting to Archer. This document may be out of date.");
    expect(cue).toHaveAttribute("role", "status");
    expect(cue).toHaveClass("archer-stale-strip");
    expect(cue).toHaveAttribute("data-connection", "lost");
    expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Guide" })).toBeVisible();

    const before = reads;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(Source.instances.length).toBeGreaterThan(1), { timeout: 5000 });
    await act(async () => {
      Source.instances.at(-1)!.onopen?.(new Event("open"));
    });
    await waitFor(() => expect(screen.queryByText(/Reconnecting|Synchronizing/)).toBeNull(), { timeout: 5000 });
    expect(reads).toBeGreaterThan(before);
  });
});
