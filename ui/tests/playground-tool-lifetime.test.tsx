// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
vi.mock("../src/app/App", () => ({ App: () => null }));
import { PlaygroundShell } from "../src/playground/shell";
import { configureStaticAddress, decodeAddress, encodeAddress } from "../src/playground/address";
import { createStaticRuntime } from "../src/playground/runtime";
import type { BrowserTool } from "../src/playground/webmcp";
import { exampleSnapshot } from "./support/playground-snapshot";
let snapshot: ReturnType<typeof exampleSnapshot>;
beforeAll(() => {
  snapshot = exampleSnapshot();
}, 30000);
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "modelContext");
});
it("restores exactly one browser-tool batch after a Back/Forward cache return", async () => {
  configureStaticAddress({
    documentUrl: `${window.location.origin}/playground/app/`,
    digest: snapshot.manifest.digest,
  });
  window.history.replaceState(null, "", encodeAddress("/projects/archer-tour/"));
  const runtime = createStaticRuntime({ snapshot, href: () => decodeAddress(window.location.href), storage: null });
  runtime.bindControls!({
    context: () => ({ projectSlug: "archer-tour" }),
    present: async () => ({}),
    controlWalk: async () => ({}),
  });
  const tools = new Map<string, BrowserTool>();
  const signals: AbortSignal[] = [];
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: async (tool: BrowserTool, { signal }: { signal: AbortSignal }) => {
        tools.set(tool.name, tool);
        signals.push(signal);
        signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
      },
    },
  });
  const { unmount } = render(<PlaygroundShell snapshot={snapshot} runtime={runtime} />);
  await screen.findByText("Agent tools available (WebMCP)");
  expect(tools.size).toBe(9);
  act(() => {
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
  });
  expect(tools.size).toBe(0);
  expect(screen.queryByText("Agent tools available (WebMCP)")).toBeNull();
  act(() => {
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await screen.findByText("Agent tools available (WebMCP)");
  expect(tools.size).toBe(9);
  expect(signals.filter((signal) => !signal.aborted)).toHaveLength(9);
  unmount();
  expect(tools.size).toBe(0);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
