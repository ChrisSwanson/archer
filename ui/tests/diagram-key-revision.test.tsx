// @vitest-environment jsdom
/** The key follows the model actually drawn while a real ELK layout is delayed. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener(event: string, callback: (result: unknown) => void): void {
      if (event === "toolresult") layouts.toolResult = callback;
    }
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));
const layouts = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  started: 0,
  toolResult: undefined as ((result: unknown) => void) | undefined,
}));
vi.mock("../src/layout/elk-adapter", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/layout/elk-adapter")>();
  return {
    ...real,
    computeLayout: async (...args: Parameters<typeof real.computeLayout>) => {
      layouts.started += 1;
      const hold = layouts.hold;
      const result = await real.computeLayout(...args);
      await hold;
      return result;
    },
  };
});
import { PageShell } from "../src/app/page-shell";
import { ENVELOPE, MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";
beforeEach(() => {
  layouts.hold = null;
  layouts.started = 0;
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
});

// A declared kind is what earns a key row (a plain outline does not).
const KEYED = {
  ...ENVELOPE,
  model: {
    ...ENVELOPE.model,
    nodes: ENVELOPE.model.nodes.map((node) => (node.id === "web" ? { ...node, classes: ["external"] } : node)),
  },
};

it("keeps the old revision's key until the new revision is drawn", async () => {
  const { container, source } = await mountAgentPresented(<PageShell />, { envelope: KEYED });
  fireEvent.click(screen.getByRole("button", { name: "Diagram Key" }));
  const key = () => screen.getByRole("region", { name: "Diagram Key" });
  expect(key().textContent).toContain("External");
  expect(key().textContent).not.toContain("Database");
  let release = (): void => {};
  layouts.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const edited = {
    ...ENVELOPE,
    revision: `sha256:${"c".repeat(64)}`,
    model: {
      ...ENVELOPE.model,
      nodes: ENVELOPE.model.nodes.map((node) =>
        node.id === "web" ? { ...node, shape: "cylinder", classes: ["database"] } : node,
      ),
    },
  };
  act(() =>
    source.emit("presentation", {
      envelope: edited,
      presentation: { presentationId: "agent-run", viewId: "alpha" },
      diagnostics: [],
    }),
  );
  await waitFor(() => expect(layouts.started).toBe(2));
  expect(container.querySelector('.react-flow__node[data-id="web"]')?.classList.contains("archer-shape-cylinder")).toBe(
    false,
  );
  expect(key().textContent).toContain("External");
  expect(key().textContent).not.toContain("Database");
  await act(async () => {
    release();
  });
  await waitFor(() =>
    expect(
      container.querySelector('.react-flow__node[data-id="web"]')?.classList.contains("archer-shape-cylinder"),
    ).toBe(true),
  );
  expect(key().textContent).toContain("Database");
});

it("opens the notation key in the production MCP shell", async () => {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? "ui:" : Reflect.get(target, key)),
    }),
  });
  const { container } = render(<PageShell />);
  await waitFor(() => expect(layouts.toolResult).toBeDefined());
  act(() =>
    layouts.toolResult!({
      structuredContent: { envelope: KEYED, presentation: { presentationId: "mcp", viewId: "alpha" }, diagnostics: [] },
    }),
  );
  const button = await screen.findByRole("button", { name: "Diagram Key" });
  expect(container.querySelector(".archer-mcp-shell")?.contains(button)).toBe(true);
  fireEvent.click(button);
  expect(screen.getByRole("region", { name: "Diagram Key" }).textContent).toContain("External");
});
