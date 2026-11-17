// @vitest-environment jsdom
//
// Walkthroughs on the page, slice 4 (ADR 0034 §6): the agent opens the panel on a step ("Presented by
// the agent"), the link remembers walkthrough and step, the page tells the host where the reader is,
// the entry is a visible button on the canvas, and the Diagram key gives the canvas back while the
// panel is open. The real `App` over a stubbed host.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { ENVELOPE, MockEventSource, mountAgentPresented, readingPosts, restoreLocation } from "./app-harness";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

// A declared kind is what earns a key row (a plain outline does not).
const KEYED = {
  ...ENVELOPE,
  model: {
    ...ENVELOPE.model,
    nodes: ENVELOPE.model.nodes.map((node) => (node.id === "web" ? { ...node, classes: ["external"] } : node)),
  },
};
const REV = `sha256:${"a".repeat(64)}`;
const step = (title: string, over: Record<string, unknown> = {}) => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: `${title} what`,
  why: `${title} why`,
  code: [`src/${title}.ts`],
  ...over,
});
const walk = (id: string, title: string, steps: unknown[]) => ({
  id,
  title,
  revision: 1,
  modelRevision: REV,
  author: "agent",
  writtenAt: "2026-10-23T09:00:00Z",
  steps,
});
const CALLS = {
  edges: [{ id: "calls", source: "web", target: "api", label: "calls" }],
  messages: [{ from: "web", to: "api", label: "x" }],
};
const API = { nodes: [{ kind: "node", id: "api", label: "API" }] };
const WALKS = [
  walk("ask", "Ask the API", [step("The request", CALLS), step("The API answers", API)]),
  walk("other", "Another one", [step("Only step", API)]),
];
const payload = (walkthroughs: unknown[]) => ({
  schemaVersion: 1,
  viewId: "alpha",
  walkthroughs,
  resolution: walkthroughs.map((w) => ({
    id: (w as { id: string }).id,
    status: "current",
    outOfDate: [],
    changed: [],
    steps: [],
  })),
  deadCode: [],
});

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  window.localStorage.removeItem("archer.diagram-key.open");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
  window.history.replaceState(null, "", "/");
});

/** The walkthrough part of the address (the page also writes `?view=` on a bare path). */
const walkParams = (): string => {
  const q = new URLSearchParams(window.location.search);
  return `${q.get("walkthrough") ?? ""}.${q.get("step") ?? ""}`;
};
const slider = () => screen.getByRole("slider", { name: "Step" });
const present = (source: MockEventSource, presentation: Record<string, unknown>) =>
  act(() => {
    source.emit("presentation", {
      envelope: ENVELOPE,
      presentation: { viewId: "alpha", ...presentation },
      diagnostics: [],
    });
  });

describe("the entry on the canvas", () => {
  it("is a visible 'Walkthroughs · N' button, pressed while the panel is open, and pressing it leaves (D3)", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    const button = await screen.findByRole("button", { name: "Walkthroughs · 2" });
    expect(button.closest(".archer-canvas-tools-menu")).toBeNull();
    // The switcher is the side panel's (0.6.4, D5).
    expect(button.closest(".archer-diagram-panel")).not.toBeNull();
    fireEvent.click(button);
    await screen.findByRole("region", { name: "Walkthrough" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".archer-walk")).toBeNull());
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    await screen.findByRole("region", { name: "Walkthrough" });
    fireEvent.click(screen.getByRole("button", { name: "Close walkthrough" }));
    await waitFor(() => expect(document.querySelector(".archer-walk")).toBeNull());
  });
  it("is not there for a diagram with none", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload([]) });
    expect(screen.queryByRole("button", { name: /^Walkthroughs · / })).toBeNull();
  });
});

describe("the Diagram key", () => {
  it("closes to its header while the panel is open, and the person's choice comes back", async () => {
    window.localStorage.setItem("archer.diagram-key.open", "true");
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS), envelope: KEYED });
    const key = await screen.findByRole("region", { name: "Diagram Key" });
    await waitFor(() => expect(key).toHaveAttribute("data-open", "true"));
    fireEvent.click(await screen.findByRole("button", { name: "Walkthroughs · 2" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Diagram Key" })).toHaveAttribute("data-open", "false"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close walkthrough" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Diagram Key" })).toHaveAttribute("data-open", "true"),
    );
    expect(window.localStorage.getItem("archer.diagram-key.open")).toBe("true");
  });
});

describe("the address", () => {
  it("opens at the walkthrough and step it names", async () => {
    window.history.replaceState(null, "", "/?walkthrough=ask&step=2");
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await screen.findByRole("region", { name: "Walkthrough" });
    await waitFor(() => expect(slider()).toHaveValue("2"));
    expect(walkParams()).toBe("ask.2");
  });

  it("ignores a walkthrough that is not there, and takes the parameters out", async () => {
    window.history.replaceState(null, "", "/?walkthrough=gone&step=2&zoom=full");
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await waitFor(() => expect(walkParams()).toBe("."));
    expect(new URLSearchParams(window.location.search).get("zoom")).toBe("full");
    expect(document.querySelector(".archer-walk")).toBeNull();
  });

  it("follows the step with replaceState (no history entries) and clears on close", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    const length = window.history.length;
    fireEvent.click(await screen.findByRole("button", { name: "Walkthroughs · 2" }));
    fireEvent.click(
      within(await screen.findByRole("group", { name: "Walkthroughs on this diagram" })).getByRole("button", {
        name: /Ask the API/,
      }),
    );
    await waitFor(() => expect(walkParams()).toBe("ask.1"));
    fireEvent.click(await screen.findByRole("button", { name: "Next step" }));
    await waitFor(() => expect(walkParams()).toBe("ask.2"));
    fireEvent.click(screen.getByRole("button", { name: "Close walkthrough" }));
    await waitFor(() => expect(walkParams()).toBe("."));
    expect(window.history.length).toBe(length);
  });
});

describe("the agent steers", () => {
  it("opens the panel on the step, with 'Presented by the agent' and the caption", async () => {
    const { source } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    present(source, {
      presentationId: "p2",
      annotation: "The answer comes back here.",
      walkthrough: { id: "ask", step: 2 },
    });
    await screen.findByRole("region", { name: "Walkthrough" });
    await waitFor(() => expect(slider()).toHaveValue("2"));
    const notice = document.querySelector(".archer-walk-presented")!;
    expect(notice).toHaveTextContent("Presented by the agent · just now — The answer comes back here.");
    await waitFor(() => expect(walkParams()).toBe("ask.2"));
    // Choosing another walkthrough is the person's: the notice goes.
    fireEvent.click(
      within(screen.getByRole("region", { name: "Walkthrough" })).getByRole("button", { name: /Ask the API/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Another one/ }));
    await waitFor(() => expect(document.querySelector(".archer-walk-presented")).toBeNull());
  });

  it("a later present moves the open panel; one without a walkthrough closes it", async () => {
    const { source } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    present(source, { presentationId: "p2", walkthrough: { id: "ask", step: 2 } });
    await waitFor(() => expect(slider()).toHaveValue("2"));
    present(source, { presentationId: "p3", walkthrough: { id: "ask", step: 1 } });
    await waitFor(() => expect(slider()).toHaveValue("1"));
    // The same presentation heard again (a live reload) does not undo the person's stepping.
    fireEvent.click(screen.getByRole("button", { name: "Last step" }));
    present(source, { presentationId: "p3", walkthrough: { id: "ask", step: 1 } });
    await waitFor(() => expect(slider()).toHaveValue("2"));
    present(source, { presentationId: "p4" });
    await waitFor(() => expect(document.querySelector(".archer-walk")).toBeNull());
  });

  const standing = {
    presentationId: "stood",
    viewId: "alpha",
    annotation: "Standing caption.",
    walkthrough: { id: "ask", step: 2 },
  };
  const bootstrap = { presentation: standing, envelope: ENVELOPE, diagnostics: [] };

  it("opens on the step of a presentation already standing when the page opens, without claiming it was just now", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS), bootstrap, presentation: standing });
    await waitFor(() => expect(slider()).toHaveValue("2"));
    expect(document.querySelector(".archer-walk-presented")).toHaveTextContent(
      /^Presented by the agent — Standing caption\.$/,
    );
  });

  it("a link that names a step is the person's: the standing presentation does not replace it", async () => {
    window.history.replaceState(null, "", "/?walkthrough=ask&step=1");
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS), bootstrap, presentation: standing });
    await waitFor(() => expect(slider()).toHaveValue("1"));
    expect(document.querySelector(".archer-walk-presented")).toBeNull();
    // A presentation made while the page is open still moves it.
    present(MockEventSource.instances[0]!, { presentationId: "later", walkthrough: { id: "ask", step: 2 } });
    await waitFor(() => expect(slider()).toHaveValue("2"));
  });
});

describe("telling the host where the reader is", () => {
  it("posts the walkthrough and step once they settle, and a null when the panel closes", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    fireEvent.click(await screen.findByRole("button", { name: "Walkthroughs · 2" }));
    fireEvent.click(
      within(await screen.findByRole("group", { name: "Walkthroughs on this diagram" })).getByRole("button", {
        name: /Ask the API/,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Next step" }));
    await waitFor(() => expect(readingPosts().at(-1)).toEqual({ viewId: "alpha", id: "ask", step: 2 }), {
      timeout: 2000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Close walkthrough" }));
    await waitFor(() => expect(readingPosts().at(-1)).toEqual({ viewId: "alpha", id: null }), { timeout: 2000 });
  });
});
