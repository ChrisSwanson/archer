// @vitest-environment jsdom
//
// Characterization of ProjectApp (`App.tsx`) before it is split into controllers (event stream, navigation, review,
// editing). These pin what the page does today, so the split can be shown to keep it:
//
// - the page holds ONE event stream for its life: a reader selecting, picking tabs and opening and closing the review
//   panel never tears it down and opens another (a dependency of the effect that owns it changing would);
// - the agent presenting while the reader has a tab picked takes the stage IN PLACE (`replaceState`, no new history
//   entry, `App.tsx` "THE PAGE'S ADDRESS"), and what the page tells the host about selection across that hand-over.
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
import { REVIEW_PANEL_ID } from "../src/comments/ReviewPanel";
import { openFile } from "./support/primary-navigation";
import { CONNECTION, MockEventSource, restoreLocation, serveOverHttp, settleSelection } from "./app-harness";

const VIEWS = [
  { id: "system-context", title: "System context" },
  { id: "delivery-handoff", title: "Delivery handoff" },
  { id: "billing", title: "Billing" },
].map((view) => ({ ...view, kind: "freeform", registration: "durable", sourcePath: `${view.id}.mmd` }));

/** Each view draws one node named after it, so what is on screen is readable. */
const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "freeform", title: viewId },
  revision: `sha256:${String(VIEWS.findIndex((v) => v.id === viewId)).padEnd(64, "0")}`,
  model: { type: "freeform-graph", nodes: [{ id: "n", label: `node of ${viewId}` }], edges: [], groups: [] },
});

/** Mounts the page over a stubbed service that may comment and read notes; the agent was presenting `standing`. */
function mount(standing = "system-context"): void {
  serveOverHttp();
  window.history.replaceState(null, "", "/");
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
                      ? { notes: [] }
                      : route === "api/notes"
                        ? { viewId: new URLSearchParams(url.split("?")[1]).get("viewId"), notes: [] }
                        : route === "api/comments"
                          ? { schemaVersion: 2, target: "view:x", threads: [] }
                          : route === "api/comments/pending"
                            ? { total: 0, targets: [] }
                            : route === "api/selection"
                              ? {}
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

const shows = async (viewId: string): Promise<void> => {
  // A long label wraps, so the words are compared without the breaks.
  await waitFor(() =>
    expect(document.querySelector(".react-flow__node")?.textContent?.replace(/\s/g, "")).toBe(`nodeof${viewId}`),
  );
};

const param = (key: string): string | null => new URLSearchParams(window.location.search).get(key);

/** What the page has told the host is selected, in order. */
const selectionPosts = (): Record<string, unknown>[] =>
  (vi.mocked(fetch).mock.calls as [string, RequestInit?][])
    .filter(([url, init]) => url === "api/selection" && init?.method === "POST")
    .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);

/** The reader selects the one node on screen, in select mode, as a person does. */
async function selectTheNode(): Promise<void> {
  const select = screen.getByRole("button", { name: "Select mode" });
  if (select.getAttribute("aria-pressed") !== "true") fireEvent.click(select);
  fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="n"]')!);
  await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="n"].selected')).not.toBeNull());
}

const reviewToggle = (): HTMLElement =>
  document.querySelector<HTMLElement>(`button[aria-controls="${REVIEW_PANEL_ID}"]`) ??
  (() => {
    throw new Error("no review toggle in the header");
  })();

async function setReviewOpen(open: boolean): Promise<void> {
  fireEvent.click(reviewToggle());
  await waitFor(() => expect(reviewToggle()).toHaveAttribute("aria-expanded", String(open)));
}

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

describe("ProjectApp's event stream", () => {
  it("is one EventSource for the life of the page, across 50 selections, tab picks and review panel toggles", async () => {
    mount();
    await shows("system-context");
    await waitFor(() => expect(reviewToggle()).toBeInTheDocument());
    expect(MockEventSource.instances).toHaveLength(1);
    const stream = MockEventSource.instances[0]!;

    const tabs = ["delivery-handoff", "billing", "system-context"];
    let changes = 0;
    for (let round = 0; changes < 50; round += 1) {
      const viewId = tabs[round % tabs.length]!;
      await openFile(VIEWS.find((view) => view.id === viewId)!.title);
      await shows(viewId);
      changes += 1;
      await selectTheNode();
      // Past the publication window (selection-sender.ts), so each selection is posted rather than superseded.
      await settleSelection();
      changes += 1;
      await setReviewOpen(true);
      expect(document.getElementById(REVIEW_PANEL_ID), "the review panel did not open").not.toBeNull();
      changes += 1;
      await setReviewOpen(false);
      changes += 1;
    }

    expect(changes).toBeGreaterThanOrEqual(50);
    expect(MockEventSource.instances, "a state change opened another stream").toHaveLength(1);
    expect(stream.close, "a state change closed the page's stream").not.toHaveBeenCalled();
    // The selections were real ones: the page published each of them while connected.
    expect(selectionPosts().filter((post) => (post.nodes as unknown[]).length > 0).length).toBeGreaterThanOrEqual(12);
  }, 60_000);
});

describe("the agent presenting while the reader has a tab picked", () => {
  it("takes the stage in place: replaceState, no new history entry, and no selection published for the turn", async () => {
    mount();
    await shows("system-context");
    await waitFor(() => expect(MockEventSource.instances[0]?.onopen).toBeTypeOf("function"));

    // The reader picks a tab of their own and selects in it.
    await openFile("Delivery handoff");
    await shows("delivery-handoff");
    expect(param("view")).toBe("delivery-handoff");
    await selectTheNode();
    await settleSelection();
    const readerPosts = selectionPosts();
    // ADR 0011: turning to a tab of their own publishes the empty selection that turn starts with, then theirs.
    expect(readerPosts.map(({ viewId, presentationId, nodes }) => ({ viewId, presentationId, nodes }))).toEqual([
      { viewId: "delivery-handoff", presentationId: "reader:delivery-handoff", nodes: [] },
      {
        viewId: "delivery-handoff",
        presentationId: "reader:delivery-handoff",
        nodes: [expect.objectContaining({ id: "n" })],
      },
    ]);

    const length = window.history.length;
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");

    // The agent presents another view, as `present_diagram` does.
    act(() => {
      MockEventSource.instances[0]!.emit("presentation", {
        envelope: envelope("billing"),
        presentation: { presentationId: "p1", viewId: "billing" },
        diagnostics: [],
      });
    });
    await shows("billing");
    await settleSelection();

    // The address follows the agent in the same entry: the reader went nowhere.
    expect(param("view")).toBe("billing");
    expect(window.history.length).toBe(length);
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(new URL(String(replace.mock.calls[0]![2]), window.location.href).searchParams.get("view")).toBe("billing");

    push.mockRestore();
    replace.mockRestore();

    // ADR 0011: a page turn the agent caused publishes nothing (the server retires the stored selection itself), so
    // the reader's selection is neither re-sent nor replaced by the page.
    expect(selectionPosts().slice(readerPosts.length), "the agent's page turn published a selection").toEqual([]);

    // The next selection the reader makes is on the agent's presentation, stamped with its id.
    await selectTheNode();
    await settleSelection();
    expect(selectionPosts().slice(readerPosts.length)).toEqual([
      expect.objectContaining({
        viewId: "billing",
        presentationId: "p1",
        nodes: [expect.objectContaining({ id: "n" })],
      }),
    ]);
  });
});
