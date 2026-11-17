// @vitest-environment jsdom
//
// The breadcrumb walks the diagram's path in the Archer folder. A folder
// segment shows that folder's diagrams, notes and subfolders on the page; it
// uses the shared live-filter header. The folder root is the project itself,
// never a segment named "Files".
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { openFile } from "./support/primary-navigation";
import { MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

const view = (id: string, title: string, sourcePath: string) => ({
  id,
  kind: "c4-context",
  title,
  registration: "durable" as const,
  sourcePath,
});

const VIEWS = [
  view("architecture", "Architecture", "architecture.mmd"),
  view("checkout", "Checkout", "diagrams/checkout.mmd"),
  view("refunds", "Refunds", "diagrams/payments/refunds.mmd"),
];

const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "data-flow", title: viewId },
  revision: `sha256:${String(VIEWS.findIndex((v) => v.id === viewId)).padEnd(64, "0")}`,
  model: { type: "data-flow-graph", nodes: [{ id: "web", label: "Web" }], edges: [], groups: [] },
});

/** Mount the page; it opens on the overview unless its address says otherwise. */
async function mount(overview = true): Promise<void> {
  serveOverHttp();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((requested: string) => {
      // A routed page asks by its project's resource base; the fixture answers by the API path.
      const url = requested.replace(/^.*?(?=api\/)/, "");
      const viewId = url.startsWith("api/diagrams/") ? url.slice("api/diagrams/".length) : null;
      if (url === "api/browser-projects" || url === "api/projects")
        return Promise.resolve({ ok: false, status: 404, json: async () => null });
      if (url === "api/compile")
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, failures: [] }) });
      const body =
        url === "api/diagrams" ? { schemaVersion: 1, views: VIEWS } : viewId !== null ? envelope(viewId) : null;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
  render(<App />);
  if (overview) await screen.findByRole("region", { name: "Project documents" });
}

/** Open a diagram from the project page, as a reader does. */
async function open(title: string): Promise<void> {
  await openFile(title);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1));
}

const breadcrumb = (): HTMLElement => screen.getByRole("navigation", { name: "Breadcrumb" });
const crumbs = (): string[] =>
  [...breadcrumb().querySelectorAll("button, [aria-current]")].map((el) => el.textContent ?? "");

beforeEach(() => {
  MockEventSource.instances = [];
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  restoreLocation();
  vi.unstubAllGlobals();
});

describe("the breadcrumb of a diagram", () => {
  it("is the project then the diagram, for a diagram at the root of the Archer folder", async () => {
    await mount();
    await open("Architecture");
    expect(crumbs()).toEqual(["Project", "Architecture"]);
    expect(breadcrumb()).not.toHaveTextContent(/files/i);
  });

  it("names every folder on the way to a nested diagram", async () => {
    await mount();
    await open("Refunds");
    expect(crumbs()).toEqual(["Project", "diagrams", "payments", "Refunds"]);
    expect(within(breadcrumb()).getByText("Refunds")).toHaveAttribute("aria-current", "page");
  });
});

describe("a folder segment", () => {
  it("shows that folder's diagrams, and its subfolders' under their own headings, on the page", async () => {
    await mount();
    await open("Refunds");
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "diagrams" }));

    // Folder navigation keeps the common live-filter header.
    expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toHaveValue("");

    const folder = await screen.findByRole("region", { name: "diagrams" });
    expect(screen.getByRole("button", { name: "Clear folder filter" })).toHaveTextContent("diagrams");
    expect(crumbs()).toEqual(["Project", "diagrams"]);
    expect(within(breadcrumb()).getByText("diagrams")).toHaveAttribute("aria-current", "page");
    expect(within(folder).getByRole("button", { name: /^(Expand|Collapse) payments$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(folder).getByRole("button", { name: /^Checkout/ })).toBeInTheDocument();
    expect(within(folder).getByRole("button", { name: /^Refunds/ })).toBeInTheDocument();
    expect(within(folder).queryByRole("button", { name: /^Architecture/ })).toBeNull();
  });

  it("opens a diagram from a subfolder in the folder's tree", async () => {
    await mount();
    await open("Checkout");
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "diagrams" }));
    const folder = await screen.findByRole("region", { name: "diagrams" });
    fireEvent.click(await within(folder).findByRole("button", { name: /^Refunds/ }));
    await waitFor(() => expect(crumbs()).toEqual(["Project", "diagrams", "payments", "Refunds"]));
    expect(screen.queryByRole("region", { name: "diagrams" })).toBeNull();
  });

  it("gives way to the overview from the project segment", async () => {
    await mount();
    await open("Checkout");
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "diagrams" }));
    await screen.findByRole("region", { name: "diagrams" });
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "Project" }));
    expect(await screen.findByRole("region", { name: "Project documents" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "diagrams" })).toBeNull();
  });
});

describe("the breadcrumb of the project page", () => {
  it("is Projects then the project, the project marked as the current page", async () => {
    window.history.replaceState(null, "", "/projects/demo/");
    await mount();
    expect(crumbs()).toEqual(["Projects", "demo"]);
    expect(within(breadcrumb()).getByText("demo")).toHaveAttribute("aria-current", "page");
    expect(breadcrumb()).not.toHaveTextContent("Overview");
  });

  it("names no Projects segment where the page has no service address", async () => {
    await mount();
    expect(crumbs()).toEqual(["Project"]);
  });
});

describe("legacy folder addresses and shared-browser history", () => {
  const folderParam = (): string | null => new URLSearchParams(window.location.search).get("under");

  it("opens that folder when the page loads with it", async () => {
    window.history.replaceState(null, "", "/?folder=diagrams%2Fpayments");
    await mount(false);
    const payments = await screen.findByRole("region", { name: "payments" });
    expect(crumbs()).toEqual(["Project", "diagrams", "payments"]);
    expect(await within(payments).findByRole("button", { name: /^Refunds/ })).toBeInTheDocument();
  });

  it("shows an empty shared browser for a folder that holds nothing now", async () => {
    window.history.replaceState(null, "", "/?folder=gone");
    await mount(false);
    const gone = await screen.findByRole("region", { name: "gone" });
    expect(await within(gone).findByText("No files match these filters.")).toBeInTheDocument();
    expect(within(gone).queryAllByRole("article")).toEqual([]);
  });

  it.each(["..%2Fsecrets", "%2Fetc", "diagrams%2F..%2F..%2Fetc"])(
    "takes %s, which leaves the Archer folder, for a folder that is not there",
    async (raw) => {
      window.history.replaceState(null, "", `/?folder=${raw}`);
      await mount(false);
      const unknown = await screen.findByRole("region", { name: "Unknown folder" });
      expect(await within(unknown).findByRole("status")).toHaveTextContent("moved or deleted");
      expect(within(unknown).queryAllByRole("button")).toEqual([]);
      expect(crumbs()).toEqual(["Project", "Unknown folder"]);
      expect(breadcrumb()).not.toHaveTextContent(/\.\.|etc/);
    },
  );

  it("is written as the reader walks, cleared when they open a diagram, and walked back by the history", async () => {
    await mount();
    await open("Refunds");
    expect(folderParam()).toBeNull();
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "diagrams" }));
    await screen.findByRole("region", { name: "diagrams" });
    expect(folderParam()).toBe("diagrams");
    fireEvent.click(within(screen.getByRole("region", { name: "diagrams" })).getByRole("button", { name: /^Refunds/ }));
    await waitFor(() => expect(crumbs()).toEqual(["Project", "diagrams", "payments", "Refunds"]));
    expect(folderParam()).toBeNull();

    window.history.back();
    expect(await screen.findByRole("region", { name: "diagrams" })).toBeInTheDocument();
    window.history.forward();
    await waitFor(() => expect(screen.queryByRole("region", { name: "diagrams" })).toBeNull());
    expect(crumbs()).toEqual(["Project", "diagrams", "payments", "Refunds"]);
  });

  it("brings back, going forward, a diagram first opened from a folder the page loaded on", async () => {
    // Leaving for a diagram still loading shows the overview for a moment;
    // forward must return to the diagram, not to that overview.
    window.history.replaceState(null, "", "/?folder=diagrams%2Fpayments");
    await mount(false);
    fireEvent.click(
      within(await screen.findByRole("region", { name: "payments" })).getByRole("button", { name: /^Refunds/ }),
    );
    await waitFor(() => expect(crumbs()).toEqual(["Project", "diagrams", "payments", "Refunds"]));
    // The breadcrumb names the diagram on the click; its history entry is written when it lands (O66).
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("view")).toBe("refunds"));
    window.history.back();
    expect(await screen.findByRole("region", { name: "payments" })).toBeInTheDocument();
    window.history.forward();
    await waitFor(() => expect(crumbs()).toEqual(["Project", "diagrams", "payments", "Refunds"]));
  });

  it("is cleared by going to the overview", async () => {
    await mount();
    await open("Checkout");
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "diagrams" }));
    await screen.findByRole("region", { name: "diagrams" });
    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "Project" }));
    await screen.findByRole("region", { name: "Project documents" });
    expect(folderParam()).toBeNull();
  });
});
