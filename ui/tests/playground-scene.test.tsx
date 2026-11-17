// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PageRuntime } from "../src/app/runtime";
vi.hoisted(() => vi.resetModules());
const holder = vi.hoisted(() => ({ current: null as PageRuntime | null }));
vi.mock("../src/app/runtime", () => ({
  get runtime() {
    return holder.current;
  },
}));
vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));
import { PlaygroundScene } from "../src/playground/scene";
import { configureStaticAddress, decodeAddress, encodeAddress } from "../src/playground/address";
import { createStaticRuntime } from "../src/playground/runtime";
import { exampleSnapshot } from "./support/playground-snapshot";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { installMatchMedia } from "./match-media";
import { parseWalkthroughs } from "../src/walkthroughs/parse";

let snapshot: PlaygroundSnapshot;
beforeAll(() => {
  snapshot = exampleSnapshot();
}, 30000);
beforeEach(() => {
  installMatchMedia(false);
  configureStaticAddress({
    documentUrl: `${window.location.origin}/archer/playground/app/index.html`,
    digest: snapshot.manifest.digest,
  });
  window.history.replaceState(null, "", `${encodeAddress("/projects/archer-tour/diagrams/containers.mmd")}&scene=hero`);
  holder.current = createStaticRuntime({ snapshot, href: () => decodeAddress(window.location.href), storage: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("API network forbidden"))),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(() => {
      throw new Error("EventSource forbidden");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("draws the real compact scene with a stopped saved walk and a seeded local comment pin", async () => {
  const { container } = render(
    <PlaygroundScene snapshot={snapshot} runtime={holder.current as ReturnType<typeof createStaticRuntime>} />,
  );
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), {
    timeout: 10000,
  });
  expect(await screen.findByRole("slider", { name: "Step" })).toHaveValue("1");
  const tour = snapshot.projects.find((project) => project.slug === "archer-tour")!;
  const walk = parseWalkthroughs(tour.responses["api/walkthroughs?viewId=containers"])!.walks.find(
    (walk) => walk.status === "current",
  )!;
  expect(screen.getByText(walk.steps[0]!.what)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  // The docs frame's own chrome offers the full Playground; the scene repeats no way out.
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Archer Containers");
  expect(container.querySelector(".archer-web-shell")).toBeNull();
  const threads = await (await holder.current!.request("api/comments?target=view%3Acontainers")).json();
  expect(threads.threads).toHaveLength(1);
  expect(threads.threads[0].comments[0].body).toContain("Demo comment");
  expect(container.querySelector(".archer-pin")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next step" }));
  await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("2"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("3");
  expect(fetch).not.toHaveBeenCalled();
  expect(EventSource).not.toHaveBeenCalled();
}, 15000);

it("opens the real pinned thread, saves a local reply and returns focus on Escape", async () => {
  const { container } = render(
    <PlaygroundScene snapshot={snapshot} runtime={holder.current as ReturnType<typeof createStaticRuntime>} />,
  );
  await waitFor(() => expect(container.querySelector(".archer-pin")).not.toBeNull());
  const pin = container.querySelector<HTMLElement>(".archer-pin")!;
  fireEvent.click(pin);
  const close = await screen.findByRole("button", { name: "Close" });
  expect(close).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), { target: { value: "A browser-local reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  await waitFor(() =>
    expect(screen.getByText("A browser-local reply", { selector: ".archer-comment-body" })).toBeInTheDocument(),
  );
  const threads = await (await holder.current!.request("api/comments?target=view%3Acontainers")).json();
  expect(threads.threads[0].comments).toHaveLength(2);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Demo comment" })).toBeNull();
  expect(pin).toHaveFocus();
  expect(fetch).not.toHaveBeenCalled();
}, 15000);

it("opens the diagram, walkthrough and step its address names, and tells the docs page each step", async () => {
  window.history.replaceState(
    null,
    "",
    `${encodeAddress("/projects/archer-tour/diagrams/heartbeat.mmd")}&walkthrough=one-turn&step=5&scene=hero`,
  );
  const posted: unknown[] = [];
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  const { container } = render(
    <PlaygroundScene snapshot={snapshot} runtime={holder.current as ReturnType<typeof createStaticRuntime>} />,
  );
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), {
    timeout: 10000,
  });
  expect(await screen.findByRole("slider", { name: "Step" })).toHaveValue("5");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The Heartbeat Loop");
  const tour = snapshot.projects.find((project) => project.slug === "archer-tour")!;
  const walk = parseWalkthroughs(tour.responses["api/walkthroughs?viewId=heartbeat"])!.walks.find(
    (walk) => walk.id === "one-turn",
  )!;
  expect(screen.getByText(walk.steps[4]!.what)).toBeInTheDocument();
  // The seeded comment sits on the node the poster shows it on.
  const threads = await (await holder.current!.request("api/comments?target=view%3Aheartbeat")).json();
  expect(threads.threads[0].anchor.id).toBe("revise");
  await waitFor(() =>
    expect(posted).toContainEqual({ type: "archer-playground-step", walkthrough: "one-turn", step: 5 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next step" }));
  await waitFor(() =>
    expect(posted).toContainEqual({ type: "archer-playground-step", walkthrough: "one-turn", step: 6 }),
  );
  post.mockRestore();
  expect(fetch).not.toHaveBeenCalled();
}, 15000);
