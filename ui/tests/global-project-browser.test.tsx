// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener() {}
    close = async () => {};
    connect = async () => {};
  },
}));
import { MockEventSource } from "./app-harness";
import { App } from "../src/app/App";
import { forgetProjectCatalogs } from "../src/app/project-directory";
const real = Object.getOwnPropertyDescriptor(window, "location")!;
const connection = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  semanticSchemaVersion: 2,
  serverEpoch: "12345678-1234-4234-9234-123456789abc",
  applicationVersion: "0.3.0",
  capabilities: ["heartbeat", "instance-settings"],
  heartbeatIntervalMs: 15000,
};
const reply = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "");
  Object.defineProperty(window, "location", real);
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
});
it("restores project and kind filters from a canonical URL without a text query", async () => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost/projects/?project=alpha-12345678&kind=note"),
  });
  const projects = [
    {
      slug: "alpha-12345678",
      name: "Alpha",
      views: [{ id: "system", title: "System", kind: "freeform", registration: "durable" }],
      notes: [{ path: "notes/guide.md", title: "Guide", viewIds: [] }],
      lifecycle: { state: "inactive", visibility: "hidden", reason: "manual" },
    },
    {
      slug: "beta-12345678",
      name: "Beta",
      views: [],
      notes: [{ path: "notes/other.md", title: "Other note", viewIds: [] }],
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      reply(
        url.endsWith("api/connection")
          ? connection
          : url.endsWith("api/browser-projects")
            ? { schemaVersion: 1, projects }
            : url.endsWith("api/compile")
              ? { schemaVersion: 1, failures: [] }
              : { schemaVersion: 1, targets: {} },
      ),
    ),
  );
  render(<App />);
  const main = within(document.querySelector("main")!);
  const inactive = await main.findByRole("group", { name: "Inactive projects (1)" });
  await waitFor(() => expect(inactive).toHaveAttribute("open"));
  expect(within(inactive).getByRole("button", { name: "Guide" })).toBeVisible();
  expect(main.queryByRole("button", { name: "System" })).toBeNull();
  expect(main.queryByRole("button", { name: "Other note" })).toBeNull();
});
it("renders a real empty global overview without making project bootstrap requests", async () => {
  Object.defineProperty(window, "location", { configurable: true, value: new URL("http://localhost/projects/") });
  vi.stubGlobal("EventSource", MockEventSource);
  const fetch = vi.fn(async (url: string) =>
    reply(url.endsWith("api/connection") ? connection : { schemaVersion: 1, projects: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  await screen.findByRole("searchbox", { name: "Search projects and files" });
  await screen.findByRole("button", { name: "Archer settings" });
  const requested = fetch.mock.calls.map(([url]) => url);
  expect(requested).toEqual(
    expect.arrayContaining(["http://localhost/api/browser-projects", "http://localhost/api/connection"]),
  );
  expect(
    requested.every(
      (url) => url === "http://localhost/api/browser-projects" || url === "http://localhost/api/connection",
    ),
  ).toBe(true);
  expect(requested.some((url) => url.includes("/p/") || url.endsWith("api/bootstrap"))).toBe(false);
  expect(screen.getByText("No diagrams or notes yet.")).toBeInTheDocument();
});

it("does not invent a project entry while the global catalog is loading", () => {
  Object.defineProperty(window, "location", { configurable: true, value: new URL("http://localhost/projects/") });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Promise<Response>(() => {})),
  );
  render(<App />);
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
});
it("opening a recent document saves the current browser position before navigation", async () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: Object.assign(new URL("http://localhost/projects/"), { assign }),
  });
  localStorage.setItem(
    "archer.recent.v1",
    JSON.stringify([
      {
        slug: "alpha-12345678",
        projectName: "Alpha",
        kind: "note",
        id: "notes/guide.md",
        title: "Guide",
        at: Date.now(),
      },
    ]),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      reply(url.endsWith("api/connection") ? connection : { schemaVersion: 1, projects: [] }),
    ),
  );
  render(<App />);
  const panel = document.querySelector<HTMLElement>(".archer-contents-panel")!;
  panel.scrollTop = 284;
  fireEvent.click(await screen.findByRole("button", { name: /^Guide/ }));
  expect(assign).toHaveBeenCalled();
  expect(window.history.state?.archerBrowserPosition?.scrollTop).toBe(284);
});
