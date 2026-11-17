// @vitest-environment jsdom
//
// The nested view on the reading page (ADR 0029; plan T6, T17, T19): a diagram with containers
// opens nested, "+" grows a box into its frame, "−" gives the same picture back, and what the
// reader selects reaches the agent in model ids: a bundle as its member edges, never a lifted end.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { MockEventSource, mountAgentPresented, restoreLocation, selectionPosts, settle } from "./app-harness";
import { loadModelEnvelope, loadValidFixture } from "./fixtures";
import { edgeElement } from "./support/draw-envelope";
import { installReducedMotion } from "./match-media";
import { resetNestLayout } from "../src/nesting/nest-layout";

const SHOP = loadModelEnvelope("c4", "nested");
const SEQUENCE = loadValidFixture("minimal-sequence.json") as { view: { id: string } };

beforeEach(() => {
  installReducedMotion(false);
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  resetNestLayout();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

const mount = () =>
  mountAgentPresented(<App />, {
    nestMode: "nested",
    envelope: SHOP,
    views: [
      { id: SHOP.view.id, kind: "c4", title: "Shop", registration: "durable" },
      { id: SEQUENCE.view.id, kind: "sequence", title: "Hello", registration: "durable" },
    ],
    ready: (mounted) => expect(mounted.querySelectorAll(".react-flow__node").length).toBe(3),
  });

const drawnIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".react-flow__node")].map((node) => node.dataset.id).sort();

describe("the nested view on the page", () => {
  it("opens at the top level, opens a box one level, and closing gives the same picture back", async () => {
    const { container } = await mount();
    expect(drawnIds(container)).toEqual(["customer", "payments", "shop"]);
    const before = container.querySelector<HTMLElement>(".react-flow__node[data-id='payments']")!.style.transform;
    fireEvent.click(screen.getByRole("button", { name: "Open Web shop" }));
    await screen.findByRole("button", { name: "Close Web shop" });
    await waitFor(() => expect(drawnIds(container)).toEqual(["api", "customer", "orders", "payments", "shop", "web"]));
    fireEvent.click(screen.getByRole("button", { name: "Close Web shop" }));
    await screen.findByRole("button", { name: "Open Web shop" });
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>(".react-flow__node[data-id='payments']")!.style.transform).toBe(
        before,
      ),
    );
  });

  it("the key lists only what is drawn: a closed boundary's insides join it when it opens", async () => {
    await mount();
    const key = () => screen.getByRole("region", { name: "Diagram Key" }).textContent ?? "";
    expect(key()).not.toContain("Database");
    expect(key()).not.toContain("Component");
    fireEvent.click(screen.getByRole("button", { name: "Open Web shop" }));
    await screen.findByRole("button", { name: "Close Web shop" });
    await waitFor(() => expect(key()).toContain("Database"));
  });

  it("a bundle selected reaches the agent as its member edges", async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Web shop" }));
    await screen.findByRole("button", { name: "Open API" });
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    await waitFor(() => expect(edgeElement(container, "bundle:api~web")).not.toBeNull());
    fireEvent.click(edgeElement(container, "bundle:api~web")!);
    await settle();
    const posts = selectionPosts();
    const [, init] = posts[posts.length - 1] as [string, { body: string }];
    const body = JSON.parse(init.body) as { nodes: unknown[]; edges: { id: string }[] };
    expect(body.edges.map((edge) => edge.id).sort()).toEqual(["web--catalog", "web--checkout"]);
    expect(body.nodes).toEqual([]);
  });

  it("the switch says what is drawn: it changes when the new drawing does, not before (G15)", async () => {
    const { container } = await mount();
    const toggle = () => screen.getByRole("button", { name: "Nested view" });
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle());
    // The nested drawing is still the one on screen while the whole model is laid out.
    expect(container.querySelector(".react-flow__node[data-id='checkout']")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(toggle()).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(container.querySelector(".react-flow__node[data-id='checkout']")).not.toBeNull());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(toggle()).not.toHaveAttribute("aria-busy");
  });

  it("the switch draws the whole model, and back", async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Nested view" }));
    await waitFor(() => expect(container.querySelector(".react-flow__node[data-id='checkout']")).not.toBeNull());
    expect(container.querySelector("[data-nest-toggle]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Nested view" }));
    await waitFor(() => expect(drawnIds(container)).toEqual(["customer", "payments", "shop"]));
  });

  it("a sequence opened after a nested graph selects its own participants", async () => {
    const { container, source } = await mount();
    act(() => {
      source.emit("presentation", {
        envelope: SEQUENCE,
        presentation: { presentationId: "agent-run-2", viewId: SEQUENCE.view.id },
        diagnostics: [],
      });
    });
    await screen.findByText("Server");
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(screen.getByText("Server"));
    await waitFor(() =>
      expect(container.querySelectorAll(".archer-seq-selected[data-seq-id='server']").length).toBe(1),
    );
  });
});
