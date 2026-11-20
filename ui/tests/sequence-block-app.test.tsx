// @vitest-environment jsdom
// Real App and production-compiled sequence fixture: block comments stay outside selection.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/app/App";
import {
  MockEventSource,
  mountAgentPresented,
  publishedEdgeIds,
  publishedNodeIds,
  restoreLocation,
  selectionPosts,
  settleSelection,
} from "./app-harness";
import { loadModelEnvelope } from "./fixtures";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
  localStorage.clear();
});

async function mount(initialViewId = "alpha") {
  const envelope = loadModelEnvelope("sequence", "full", initialViewId);
  const mounted = await mountAgentPresented(<App />, {
    envelope: { ...envelope, view: { ...envelope.view, kind: "sequence" } },
    views: ["alpha", "beta"].map((id) => ({ id, kind: "sequence", title: `Sequence ${id}`, registration: "durable" })),
    bootstrap: { capabilities: { comments: true } },
    ready: (container) => expect(container.querySelector('[aria-label="Sequence diagram canvas"]')).not.toBeNull(),
  });
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  return mounted;
}

const discussion = () => screen.getByRole("region", { name: "Contextual discussion" });
async function expectBlockComposer() {
  await screen.findByRole("textbox", { name: "Comment" });
  expect(discussion().querySelector(".primary-floating-context")).toHaveTextContent("alt block: Valid credentials");
}

test("focused C comments on the whole block even with a child message selected, without publishing fragments", async () => {
  const { container } = await mount();
  const message = container.querySelector('[data-seq-channel="messages"][data-seq-id="msg-3"]')!;
  fireEvent.click(message);
  await settleSelection();
  expect(publishedEdgeIds(selectionPosts())).toContain("msg-3");
  const block = await screen.findByRole("button", { name: "alt block: Valid credentials" });
  act(() => block.focus());
  fireEvent.keyDown(block, { key: "c" });
  await expectBlockComposer();
  expect(message).toHaveClass("archer-seq-selected");
  expect(publishedNodeIds(selectionPosts())).not.toContain("frag-0");
  expect(publishedEdgeIds(selectionPosts())).not.toContain("frag-0");
});

for (const target of ["header", "border"]) {
  test(`right-clicking the block ${target} opens a group composer`, async () => {
    const { container } = await mount();
    const block =
      target === "header"
        ? await screen.findByRole("button", { name: "alt block: Valid credentials" })
        : container.querySelector('.archer-seq-fragment-border-hit[data-seq-id="frag-0"]');
    expect(block).not.toBeNull();
    fireEvent.contextMenu(block!, { clientX: 200, clientY: 200 });
    await expectBlockComposer();
  });
}

test("the block Enter and context-menu keys use the same composer", async () => {
  await mount();
  const block = await screen.findByRole("button", { name: "alt block: Valid credentials" });
  act(() => block.focus());
  fireEvent.keyDown(block, { key: "Enter" });
  await expectBlockComposer();
  fireEvent.click(within(discussion()).getByRole("button", { name: "Cancel" }));
  act(() => block.focus());
  // jsdom does not synthesize the browser’s native contextmenu event from its key.
  fireEvent.contextMenu(block);
  await expectBlockComposer();
});

test("Project Review reveals an offscreen block header without selecting the fragment", async () => {
  const { container, source } = await mount();
  const thread = {
    id: "t-block-review",
    target: "view:alpha",
    anchor: { kind: "group", id: "frag-0", label: "Valid credentials" },
    status: "sent",
    revision: 1,
    comments: [
      {
        id: "c-block-review",
        author: "person",
        body: "Review the whole alternative",
        createdAt: "2026-11-12T12:00:00Z",
      },
    ],
  };
  const previousFetch = window.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("api/comments?")) {
        const target = new URL(url, "http://localhost").searchParams.get("target");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ schemaVersion: 2, target, threads: target === "view:alpha" ? [thread] : [] }),
        });
      }
      return previousFetch(url, init);
    }),
  );
  act(() => source.emit("comments", { target: "view:alpha" }));
  await screen.findByRole("button", { name: "Comment 1: sent. Open it." });
  const canvas = container.querySelector(".archer-seq-canvas")!;
  const viewport = container.querySelector(".archer-seq-viewport")!;
  fireEvent.wheel(canvas, { deltaY: 1000 });
  const panned = viewport.getAttribute("transform");
  fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  fireEvent.click(
    await within(screen.getByRole("region", { name: "Project Review" })).findByRole("button", {
      name: /alt block: Valid credentials/,
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show on diagram" }));
  await waitFor(() => expect(viewport.getAttribute("transform")).not.toBe(panned));
  expect(publishedNodeIds(selectionPosts())).not.toContain("frag-0");
  expect(publishedEdgeIds(selectionPosts())).not.toContain("frag-0");
});

test("Project Review queues a block reveal until the requested diagram is drawn", async () => {
  const { container, source } = await mount("beta");
  const previousHeader = container.querySelector<SVGElement>('.archer-seq-block-header[data-seq-id="frag-0"]')!;
  const focused: SVGElement[] = [];
  const originalFocus = SVGElement.prototype.focus;
  vi.spyOn(SVGElement.prototype, "focus").mockImplementation(function (this: SVGElement, options?: FocusOptions) {
    focused.push(this);
    originalFocus.call(this, options);
  });
  const thread = {
    id: "t-queued-block",
    target: "view:alpha",
    anchor: { kind: "group", id: "frag-0", label: "Valid credentials" },
    status: "sent",
    revision: 1,
    comments: [
      { id: "c-queued-block", author: "person", body: "Review the other diagram", createdAt: "2026-11-12T12:00:00Z" },
    ],
  };
  const previousFetch = window.fetch;
  let deliver: ((value: unknown) => void) | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("api/comments?")) {
        const target = new URL(url, "http://localhost").searchParams.get("target");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ schemaVersion: 2, target, threads: target === "view:alpha" ? [thread] : [] }),
        });
      }
      if (url.startsWith("api/diagrams/alpha")) {
        return new Promise((resolve) => {
          deliver = resolve;
        });
      }
      return previousFetch(url, init);
    }),
  );
  act(() => source.emit("comments", { target: "view:alpha" }));
  fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  fireEvent.click(
    await within(screen.getByRole("region", { name: "Project Review" })).findByRole("button", {
      name: /Group: Valid credentials/,
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show on diagram" }));
  await waitFor(() => expect(deliver).not.toBeNull());
  expect(focused.includes(previousHeader)).toBe(false);
  const envelope = loadModelEnvelope("sequence", "full", "alpha");
  await act(async () =>
    deliver!({
      ok: true,
      status: 200,
      json: async () => ({ ...envelope, view: { ...envelope.view, kind: "sequence" } }),
    }),
  );
  await waitFor(() => {
    const shown = container.querySelector<SVGElement>('.archer-seq-block-header[data-seq-id="frag-0"]');
    expect(shown !== previousHeader).toBe(true);
    expect(focused.some((header) => header === shown)).toBe(true);
  });
});

test("a deep link opens an orphan discussion without focusing the block that reused its id", async () => {
  const previousHref = window.location.href;
  window.history.replaceState({}, "", "?view=alpha&thread=t-orphan-block");
  try {
    const { container, source } = await mount();
    const header = container.querySelector<SVGElement>('.archer-seq-block-header[data-seq-id="frag-0"]')!;
    const focus = vi.spyOn(header, "focus");
    const thread = {
      id: "t-orphan-block",
      target: "view:alpha",
      anchor: { kind: "group", id: "frag-0", label: "Earlier block" },
      orphaned: true,
      identity: { version: 1, fingerprint: `sha256:${"a".repeat(64)}`, unique: true },
      status: "sent",
      revision: 1,
      comments: [
        {
          id: "c-orphan-block",
          author: "person",
          body: "Original block discussion",
          createdAt: "2026-11-12T12:00:00Z",
        },
      ],
    };
    const previousFetch = window.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith("api/comments?")) {
          const target = new URL(url, "http://localhost").searchParams.get("target");
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ schemaVersion: 2, target, threads: target === "view:alpha" ? [thread] : [] }),
          });
        }
        return previousFetch(url, init);
      }),
    );
    act(() => source.emit("comments", { target: "view:alpha" }));
    await within(await screen.findByRole("region", { name: "Contextual discussion" })).findByText(
      "Original block discussion",
    );
    expect(focus).not.toHaveBeenCalled();
  } finally {
    window.history.replaceState({}, "", previousHref);
  }
});

for (const kind of ["block", "participant", "message"] as const) {
  test(`closing a newly saved ${kind} discussion focuses its new SVG pin`, async () => {
    const { container } = await mount();
    const selector =
      kind === "block"
        ? '.archer-seq-block-header[data-seq-id="frag-0"]'
        : kind === "participant"
          ? '[data-seq-channel="participants"][role="button"]'
          : '[data-seq-channel="messages"][role="button"]';
    fireEvent.contextMenu(container.querySelector(selector)!);
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), {
      target: { value: "Keep this question" },
    });
    fireEvent.click(within(discussion()).getByRole("button", { name: "Add comment" }));
    await within(discussion()).findByText("Keep this question", { exact: true });
    // The pin is drawn for the saved thread, which can land a render after the comment's text does (O280).
    const pin = await waitFor(() => {
      const drawn = container.querySelector<SVGElement>('[data-pin-thread][role="button"]');
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    fireEvent.click(within(discussion()).getByRole("button", { name: "Close discussion" }));
    expect(pin).toHaveFocus();
  });
}
