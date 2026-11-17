// @vitest-environment jsdom
//
// The walkthrough's page-level keys (ADR 0034 §6): F toggles Follow steps (not while typing), and the
// ? sheet lists the stepping keys only while a walkthrough is open. The real `App` over a stubbed host.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";

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
  code: [],
  ...over,
});
const CALLS = { edges: [{ id: "calls", source: "web", target: "api", label: "calls" }] };
const WALKS = [
  {
    id: "ask",
    title: "Ask the API",
    revision: 1,
    modelRevision: REV,
    author: "agent",
    writtenAt: "2026-10-23T09:00:00Z",
    steps: [step("The request", CALLS), step("The API answers", CALLS)],
  },
];
const payload = {
  schemaVersion: 1,
  viewId: "alpha",
  walkthroughs: WALKS,
  resolution: [{ id: "ask", status: "current", outOfDate: [], changed: [], steps: [] }],
  deadCode: [],
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

async function openWalk(): Promise<void> {
  // The side panel's Explore section lists them (0.6.4, D5): no entry button to press first.
  await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Walkthroughs on this diagram" })).getByRole("button", {
      name: /Ask the API/,
    }),
  );
}
const follow = () => screen.getByRole("button", { name: "Follow steps" });

describe("F", () => {
  it("toggles Follow steps, but not while typing", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload });
    await openWalk();
    await waitFor(() => expect(follow()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(window, { key: "f" });
    expect(follow()).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(window, { key: "F" });
    expect(follow()).toHaveAttribute("aria-pressed", "true");
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "f" });
    expect(follow()).toHaveAttribute("aria-pressed", "true");
    input.remove();
  });
});

describe("the ? sheet", () => {
  it("lists the walkthrough's keys only while one is open", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload });
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    fireEvent.keyDown(window, { key: "?" });
    expect(within(await screen.findByRole("dialog")).queryByText("Walkthrough")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openWalk();
    fireEvent.keyDown(window, { key: "?" });
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("Walkthrough")).toBeInTheDocument();
    expect(await within(sheet).findByText("Follow the steps with the camera, or stop following")).toBeInTheDocument();
  });
});
