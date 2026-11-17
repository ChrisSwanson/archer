import { fileButton } from "./support/primary-navigation";
// @vitest-environment jsdom
//
// The agent's caption (`present_diagram`'s `annotation`) is shown to the
// reader. It was stored and never drawn (adversarial review 2026-10-02, F6),
// and replacing `annotation: command.annotation` with `undefined` in the
// presentation reducer survived every test there was.
//
// These pin the rules: what counts as a caption, that it is text, that the
// live region exists before it has anything to say, and which presentation it
// is read from. Where it sits, and that it is not on the drawing, is a matter
// of layout: `tests/browser/caption.e2e.ts` (in the Rust implementation, not in this tree), in both shells.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { CAPTION_ID, CAPTION_MAX_CHARS, Caption, captionText } from "../src/app/Caption";
import { ENVELOPE, MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

describe("what counts as a caption", () => {
  it.each([
    ["no annotation", undefined],
    ["an empty one", ""],
    ["only white space", " \n\t "],
  ])("shows nothing for %s", (_name, annotation) => {
    expect(captionText(annotation)).toBeNull();
  });

  it("is the annotation, without the white space around it", () => {
    expect(captionText("  Orders settle later.\n")).toBe("Orders settle later.");
  });

  it("keeps the line breaks the agent wrote", () => {
    expect(captionText("First.\nSecond.")).toBe("First.\nSecond.");
  });

  it("is bounded at the server's limit, counted in code points", () => {
    expect(captionText("a".repeat(CAPTION_MAX_CHARS))).toBe("a".repeat(CAPTION_MAX_CHARS));
    expect(captionText("a".repeat(CAPTION_MAX_CHARS + 1))).toBe(`${"a".repeat(CAPTION_MAX_CHARS)}…`);
    // Two UTF-16 units each: counted as the server counts them, not by `length`.
    expect(captionText("𝒜".repeat(CAPTION_MAX_CHARS))).toBe("𝒜".repeat(CAPTION_MAX_CHARS));
  });
});

describe("the caption on the page", () => {
  afterEach(cleanup);

  it("keeps its live region in the page while there is nothing to say", () => {
    const { container } = render(<Caption text={null} />);

    const region = container.querySelector(".archer-caption-region");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toBeEmptyDOMElement();
  });

  it("shows the words as text, whatever they contain", () => {
    const hostile = '<img src=x onerror="window.pwned = true"> and <b>bold</b>';
    const { container } = render(<Caption text={hostile} />);

    const caption = container.querySelector(`#${CAPTION_ID}`);
    expect(caption).toHaveTextContent(hostile);
    expect(container.querySelector("img, b")).toBeNull();
  });

  it("says whose words they are", () => {
    render(<Caption text="Orders settle later." />);

    expect(screen.getByText("From the agent")).not.toBeNull();
  });

  it("is a tab stop when its words overflow the bar, never as the hidden copy the header stands for", () => {
    // jsdom lays nothing out: the box reports what a browser does for a caption taller than its room,
    // as the visually hidden copy (clipped to one pixel) always is.
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(40);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1);
    try {
      const shown = render(<Caption text="Orders settle later." />);
      expect(shown.container.querySelector(".archer-caption-box")).toHaveAttribute("tabindex", "0");
      shown.unmount();
      const hidden = render(<Caption text="Orders settle later." inHeader />);
      const box = hidden.container.querySelector(".archer-caption-box");
      expect(box).toHaveClass("archer-visually-hidden");
      expect(box).not.toHaveAttribute("tabindex");
      expect(box).not.toHaveAttribute("role");
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });
});

describe("which presentation the caption is read from", () => {
  const OTHER = {
    ...ENVELOPE,
    view: { id: "beta", kind: "data-flow", title: "Beta" },
    revision: `sha256:${"b".repeat(64)}`,
    model: { type: "data-flow-graph", nodes: [{ id: "queue", label: "Queue" }], edges: [], groups: [] },
  };
  const VIEWS = [
    { id: "alpha", kind: "data-flow", title: "Alpha", registration: "durable" },
    { id: "beta", kind: "data-flow", title: "Beta", registration: "durable" },
  ];
  const presented = (annotation?: string) => ({
    envelope: ENVELOPE,
    presentation: { presentationId: "p1", viewId: "alpha", ...(annotation === undefined ? {} : { annotation }) },
    diagnostics: [],
  });

  let bootstrap: unknown;

  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    serveOverHttp();
    bootstrap = presented("Orders settle later.");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body =
          url === "api/connection"
            ? {
                browserProtocolMajor: 1,
                supportedBrowserProtocolMajors: [1],
                serverEpoch: "12345678-1234-1234-1234-123456789abc",
                capabilities: [],
                applicationVersion: "0.1.0",
                semanticSchemaVersion: 2,
              }
            : url === "api/bootstrap"
              ? bootstrap
              : url === "api/diagrams"
                ? { schemaVersion: 1, views: VIEWS }
                : url === "api/compile"
                  ? { schemaVersion: 1, failures: [] }
                  : url === "api/diagrams/beta"
                    ? OTHER
                    : url.startsWith("api/emphasis/")
                      ? { schemaVersion: 1, viewId: url.slice("api/emphasis/".length), emphases: [] }
                      : null;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
  });

  const caption = (): HTMLElement | null => document.getElementById(CAPTION_ID);
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("shows the presented view's caption and describes the stage by it", async () => {
    render(<App />);
    queueMicrotask(() => MockEventSource.instances[0]?.onopen?.(new Event("open")));
    await screen.findByText("Web");

    expect(caption()).toHaveTextContent("Orders settle later.");
    expect(document.querySelector(".archer-stage")!).toHaveAttribute("aria-describedby", CAPTION_ID);
  });

  it("takes it away when the agent presents without one", async () => {
    render(<App />);
    queueMicrotask(() => MockEventSource.instances[0]?.onopen?.(new Event("open")));
    await screen.findByText("Web");

    await act(async () => {
      MockEventSource.instances[0].emit("presentation", presented());
      await settle();
    });

    expect(caption()).toBeNull();
    expect(document.querySelector(".archer-stage")!).not.toHaveAttribute("aria-describedby");
    // The region stays, empty, for the next caption to be announced in.
    expect(document.querySelector(".archer-caption-region")).toBeEmptyDOMElement();
  });

  it("does not show it over a tab the reader picked, and shows it again when they go back", async () => {
    render(<App />);
    queueMicrotask(() => MockEventSource.instances[0]?.onopen?.(new Event("open")));
    await screen.findByText("Web");

    await act(async () => {
      fireEvent.click(fileButton(/Beta/));
      await settle();
    });
    await screen.findByText("Queue");
    expect(caption(), "the caption was about Alpha").toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to the agent's view" }));
      await settle();
    });
    await screen.findByText("Web");
    expect(caption()).toHaveTextContent("Orders settle later.");
  });

  it("shows nothing under a notice that has replaced the drawing", async () => {
    render(<App />);
    queueMicrotask(() => MockEventSource.instances[0]?.onopen?.(new Event("open")));
    await screen.findByText("Web");

    await act(async () => {
      MockEventSource.instances[0].emit("inventory", { schemaVersion: 1, views: [VIEWS[1]] });
      await settle();
    });

    expect(await screen.findByText(/no longer registered\./)).not.toBeNull();
    expect(caption()).toBeNull();
  });
});
