// @vitest-environment jsdom
//
// Walkthroughs on the page (ADR 0034, slice 3): the entry in the graph tools, the panel in the side
// slot, a step drawn through the emphasis pipeline, stepping from the panel and from the diagram, and
// the agent's own emphasis coming back when the panel closes. The real `App` over a stubbed host.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { MockEventSource, mountAgentPresented, restoreLocation, fetchCalls } from "./app-harness";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

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
const walk = (id: string, title: string, steps: unknown[], over: Record<string, unknown> = {}) => ({
  id,
  title,
  revision: 1,
  modelRevision: REV,
  author: "agent",
  writtenAt: "2026-10-23T09:00:00Z",
  steps,
  ...over,
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
const payload = (walkthroughs: unknown[], resolution?: unknown[]) => ({
  schemaVersion: 1,
  viewId: "alpha",
  walkthroughs,
  resolution:
    resolution ??
    walkthroughs.map((w) => ({
      id: (w as { id: string }).id,
      status: "current",
      outOfDate: [],
      changed: [],
      steps: [],
    })),
  deadCode: [],
});
const emphasis = {
  id: "agent-1",
  viewId: "alpha",
  title: "Agent path",
  groups: [
    {
      id: "g1",
      style: "highlight",
      palette: "teal",
      state: "existing",
      speed: null,
      label: "The agent's",
      description: "",
      nodes: ["web"],
      edges: [],
    },
  ],
};

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
});

/**
 * The service's bootstrap names the review capabilities, so the canvas's tools menu holds its real tools (Compare,
 * Export, Accuracy) as on the live page. Without them the menu has no tools and draws no launcher.
 */
const SERVICE_BOOTSTRAP = { capabilities: { comments: true } };
const node = (c: HTMLElement, id: string) => c.querySelector(`.react-flow__node[data-id="${id}"]`);
const edge = (c: HTMLElement, id: string) => c.querySelector(`.react-flow__edge[data-id="${id}"]`);
const classes = (el: Element | null) => [...(el?.classList ?? [])];
async function openPanel(): Promise<void> {
  // The side panel's Explore section lists them (0.6.4, D5): no entry button to press first.
  await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
}
const choose = (title: RegExp) =>
  fireEvent.click(
    within(screen.getByRole("group", { name: "Walkthroughs on this diagram" })).getByRole("button", { name: title }),
  );

describe("with no walkthroughs", () => {
  it("nothing on the page changes: no entry, no panel", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload([]), bootstrap: SERVICE_BOOTSTRAP });
    fireEvent.click(
      (await screen.findByRole("button", { name: "Export, compare and more" }).catch(() => null)) ?? document.body,
    );
    expect(screen.queryByRole("button", { name: /Walkthroughs/ })).toBeNull();
    expect(document.querySelector(".archer-walk")).toBeNull();
  });
});

describe("with walkthroughs", () => {
  it("lists them in the side panel, with 'Walkthroughs · N' in its switcher, and nothing emphasised", async () => {
    const { container } = await mountAgentPresented(<App />, {
      walkthroughs: payload(WALKS),
      bootstrap: SERVICE_BOOTSTRAP,
    });
    const panel = await screen.findByRole("complementary", { name: "Diagram panel" });
    expect(await within(panel).findByRole("button", { name: "Walkthroughs · 2" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Export, compare and more" }));
    expect(
      within(screen.getByRole("group", { name: "Export, compare and more" })).queryByRole("button", {
        name: /Walkthroughs/,
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
    await openPanel();
    expect(screen.getByRole("group", { name: "Walkthroughs on this diagram" })).toBeInTheDocument();
    expect(container.querySelectorAll(".archer-emph")).toHaveLength(0);
  });

  it("choosing one starts at step 1: the line is the current step's flow, the rest fades", async () => {
    const { container } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openPanel();
    choose(/Ask the API/);
    await waitFor(() => expect(classes(edge(container, "calls"))).toContain("archer-emph-style-flow"));
    // The line is drawn with the boxes at its ends.
    expect(classes(node(container, "web"))).toContain("archer-emph-style-flow");
    await waitFor(() => expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("The request"));
    // One spoken step, outside the panel so that it outlives a collapse (review F2).
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".archer-visually-hidden[aria-live]")]
          .filter((n) => /Step \d+ of/.test(n.textContent ?? ""))
          .map((n) => n.textContent),
      ).toEqual(["Ask the API. Step 1 of 2: The request. Web → API."]),
    );
    expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("1");
    // The walkthrough is the key: no emphasis legend of its own.
    expect(container.querySelector(".archer-emph-legend")).toBeNull();
  });

  it("stepping on draws earlier steps quiet, and names them for a screen reader", async () => {
    const { container } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openPanel();
    choose(/Ask the API/);
    fireEvent.click(await screen.findByRole("button", { name: "Next step" }));
    await waitFor(() => expect(classes(node(container, "api"))).toContain("archer-emph-style-flow"));
    expect(classes(edge(container, "calls"))).toEqual(
      expect.arrayContaining(["archer-emph--walked", "archer-emph-style-highlight"]),
    );
    expect(node(container, "api")?.getAttribute("aria-label")).toMatch(/, step 2, current$/);
    expect(edge(container, "calls")?.getAttribute("aria-label")).toMatch(/, walked$/);
  });

  it("pressing a graph element a step names jumps to that step, and still selects it", async () => {
    const { container } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openPanel();
    choose(/Ask the API/);
    fireEvent.click(await screen.findByRole("button", { name: "Last step" }));
    await waitFor(() => expect(classes(node(container, "api"))).toContain("archer-emph-style-flow"));
    // The hand pans; a press selects in select mode.
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
    // Step 1's line ends at the Web box, so a press on it goes back to step 1.
    fireEvent.click(node(container, "web")!);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("1"));
    // Selection keeps the node body: both voices are on it.
    await waitFor(() =>
      expect(classes(node(container, "web"))).toEqual(expect.arrayContaining(["selected", "archer-emph-style-flow"])),
    );
  });

  it("with the hand (the default pointer), a press on an element a step names jumps too, and selects nothing", async () => {
    const { container } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openPanel();
    choose(/Ask the API/);
    fireEvent.click(await screen.findByRole("button", { name: "Last step" }));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("2"));
    fireEvent.click(node(container, "web")!);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("1"));
    fireEvent.click(await screen.findByRole("button", { name: "Last step" }));
    fireEvent.click(edge(container, "calls")!);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("1"));
    expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(0);
  });

  it("closing restores the plain diagram, and the agent's emphasis comes back", async () => {
    const { container } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS), emphases: [emphasis] });
    await waitFor(() => expect(classes(node(container, "web"))).toContain("archer-emph"));
    // Highlights are up, so the panel shows them: the switcher opens the walkthroughs' list.
    fireEvent.click(await screen.findByRole("button", { name: "Walkthroughs · 2" }));
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    // While the panel is open the agent's emphasis (and its legend) give way to it.
    expect(classes(node(container, "web"))).not.toContain("archer-emph");
    choose(/Ask the API/);
    await waitFor(() => expect(classes(edge(container, "calls"))).toContain("archer-emph-style-flow"));
    fireEvent.click(screen.getByRole("button", { name: "Close walkthrough" }));
    await waitFor(() => expect(document.querySelector(".archer-walk")).toBeNull());
    expect(classes(edge(container, "calls"))).not.toContain("archer-emph-style-flow");
    await waitFor(() => expect(classes(node(container, "web"))).toContain("archer-emph"));
    expect(document.querySelector(".archer-walk-transport")).toBeNull();
  });

  it("reads them again on the walkthroughs event, and keeps the step or clamps it", async () => {
    const { source } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openPanel();
    choose(/Ask the API/);
    fireEvent.click(await screen.findByRole("button", { name: "Last step" }));
    expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("2");
    const before = fetchCalls().filter((url) => url.startsWith("api/walkthroughs?")).length;
    // The agent rewrote it with one step fewer.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(payload([walk("ask", "Ask the API", [step("The request", CALLS)]), WALKS[1]])),
        }),
      ),
    );
    act(() => source.emit("walkthroughs", { viewId: "alpha" }));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("1"));
    expect(screen.getByRole("slider", { name: "Step" })).toHaveAttribute("max", "1");
    expect(before).toBeGreaterThan(0);
  });

  it("a late answer to an earlier read does not overwrite a newer one", async () => {
    const { source } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    const pending: Array<(body: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) =>
            pending.push((body) => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })),
          ),
      ),
    );
    act(() => source.emit("walkthroughs", { viewId: "alpha" }));
    act(() => source.emit("walkthroughs", { viewId: "alpha" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]!(payload([walk("newer", "The newer one", [step("Only", API)])]));
    });
    await act(async () => {
      pending[0]!(payload(WALKS));
    });
    await openPanel();
    const list = screen.getByRole("group", { name: "Walkthroughs on this diagram" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.querySelector(".archer-walk-item-title")?.textContent),
    ).toEqual(["The newer one"]);
  });

  it("an event for another view is not a re-read", async () => {
    const { source } = await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openPanel();
    const asked = () => fetchCalls().filter((url) => url.startsWith("api/walkthroughs?")).length;
    const before = asked();
    act(() => source.emit("walkthroughs", { viewId: "elsewhere" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked()).toBe(before);
  });
});
