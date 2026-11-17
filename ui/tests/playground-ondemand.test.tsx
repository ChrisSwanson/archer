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
import { PlaygroundShell } from "../src/playground/shell";
import { configureStaticAddress, decodeAddress, encodeAddress } from "../src/playground/address";
import { createStaticRuntime, type StaticRuntime } from "../src/playground/runtime";
import { exampleSnapshot } from "./support/playground-snapshot";
import type { PlaygroundProject, PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { installMatchMedia } from "./match-media";
import { openInApp } from "../src/app/in-app-navigation";
import type { BrowserTool } from "../src/playground/webmcp";

// The Playground holds only the project it booted on; another project downloads when the page goes to it.
let snapshot: PlaygroundSnapshot;
let tour: PlaygroundProject;
beforeAll(() => {
  snapshot = exampleSnapshot();
  tour = snapshot.projects.find((project) => project.slug === "archer-tour")!;
}, 30000);
const DOCUMENT = "/archer/playground/app/index.html";
beforeEach(() => {
  installMatchMedia(false);
  window.history.replaceState(null, "", DOCUMENT);
  configureStaticAddress({ documentUrl: window.location.href, digest: snapshot.manifest.digest });
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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "modelContext");
});

function runtimeWith(load: (slug: string) => Promise<PlaygroundProject | undefined>): StaticRuntime {
  const runtime = createStaticRuntime({
    snapshot: { ...snapshot, projects: [tour] },
    href: () => decodeAddress(window.location.href),
    storage: null,
    load,
  });
  holder.current = runtime;
  return runtime;
}
const mount = (runtime: StaticRuntime) =>
  render(
    <PlaygroundShell
      index={{ projects: snapshot.projects.map(({ slug, name }) => ({ slug, name, data: "" })) }}
      snapshot={{ ...snapshot, projects: [tour] }}
      runtime={runtime}
    />,
  );
const project = (slug: string) => snapshot.projects.find((candidate) => candidate.slug === slug);

it("a project whose download failed after navigation says so, and Retry downloads it once more and draws it", async () => {
  let fail = true;
  const load = vi.fn(async (slug: string) => {
    if (fail) throw new Error("offline");
    return project(slug);
  });
  const runtime = runtimeWith(load);
  window.history.replaceState(null, "", encodeAddress("/projects/rfc-2324-htcpcp/diagrams/coffee-controls.mmd"));
  mount(runtime);
  const alert = await screen.findByRole("alert", {}, { timeout: 10000 });
  expect(alert).toHaveTextContent("This example could not load.");
  // The page's many reads do not each try the download again.
  expect(load).toHaveBeenCalledTimes(1);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), {
    timeout: 10000,
  });
  expect(screen.queryByText("This example could not load.")).toBeNull();
  expect(screen.queryByText("Cannot tell what Archer is showing.")).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
}, 20000);

it("registers the agent tools once a project the page went to has downloaded", async () => {
  const tools = new Map<string, BrowserTool>();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: async (tool: BrowserTool, options: { signal: AbortSignal }) => {
        tools.set(tool.name, tool);
        options.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
      },
    },
  });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = runtimeWith(async (slug) => {
    await held;
    return project(slug);
  });
  // Open on the Tour (held), then go to another project inside the page while its download is held.
  window.history.replaceState(null, "", encodeAddress("/projects/archer-tour/diagrams/containers.mmd"));
  mount(runtime);
  await screen.findByText("Agent tools available (WebMCP)", {}, { timeout: 10000 });
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  await act(async () => openInApp(encodeAddress("/projects/rfc-2324-htcpcp/diagrams/coffee-controls.mmd")));
  await waitFor(() => expect(runtime.controls?.context().projectSlug).toBe("rfc-2324-htcpcp"));
  await waitFor(() => expect(tools.size).toBe(0));
  await act(async () => release());
  await screen.findByText("Agent tools available (WebMCP)", {}, { timeout: 10000 });
  const listed = (await tools.get("list_diagrams")!.execute({}, { signal: new AbortController().signal })) as {
    diagrams?: unknown[];
  };
  expect(JSON.stringify(listed)).toContain("coffee-controls");
}, 20000);

it("the Projects page searches names locally and never asks the static runtime for a server search", async () => {
  const runtime = runtimeWith(async (slug) => project(slug));
  const request = vi.spyOn(runtime, "request");
  window.history.replaceState(null, "", encodeAddress("/projects/"));
  mount(runtime);
  const search = await screen.findByRole("searchbox", { name: "Search projects and files" }, { timeout: 10000 });
  fireEvent.change(search, { target: { value: "coffee" } });
  await waitFor(() => expect(screen.getAllByText(/Coffee/u).length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(request.mock.calls.map(([input]) => String(input)).filter((input) => input.includes("search"))).toEqual([]);
  expect(screen.queryByText(/content search (is )?unavailable/iu)).toBeNull();
}, 20000);
