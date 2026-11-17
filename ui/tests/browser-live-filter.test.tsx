// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SearchPage } from "../src/app/SearchPage";
import { EMPTY_SEARCH, type SearchState } from "../src/app/file-index";
import { forgetProjectCatalogs } from "../src/app/project-directory";
const first = {
  slug: "alpha-12345678",
  name: "Alpha",
  views: [],
  notes: [
    { path: "notes/guide.md", title: "Guide", viewIds: [] },
    { path: "notes/deep/setup.md", title: "Setup", viewIds: [] },
  ],
};
const second = {
  slug: "beta-12345678",
  name: "Beta",
  views: [],
  notes: [{ path: "notes/other.md", title: "Other", viewIds: [] }],
};
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
afterEach(() => {
  cleanup();
  forgetProjectCatalogs();
  localStorage.clear();
});
function mount(initial: SearchState = EMPTY_SEARCH, extras: Partial<Parameters<typeof SearchPage>[0]> = {}) {
  const changes = vi.fn();
  const fetchImpl = vi.fn(async (url: string) =>
    response(
      url === "api/browser-projects"
        ? { schemaVersion: 1, projects: [first, second] }
        : url.includes("api/browser-search")
          ? { query: new URL(url, "http://test/").searchParams.get("q"), results: [] }
          : { schemaVersion: 1, targets: {}, failures: [] },
    ),
  );
  function Harness() {
    const [state, setState] = useState(initial);
    return (
      <SearchPage
        state={state}
        onChange={(next) => {
          changes(next);
          setState(next);
        }}
        currentSlug={first.slug}
        currentName={first.name}
        views={[]}
        notes={first.notes}
        serverSearch={false}
        baseUrl={"http://localhost/p/" + first.slug + "/"}
        now={0}
        onOpen={() => {}}
        onOpenMatch={() => {}}
        fetchImpl={fetchImpl}
        {...extras}
      />
    );
  }
  render(<Harness />);
  return { changes, fetchImpl };
}
it("filters immediately while typing, preserving the search input and caret focus", async () => {
  mount();
  await screen.findByRole("button", { name: "Other" });
  const input = screen.getByRole("searchbox", { name: "Search projects and files" });
  input.focus();
  fireEvent.change(input, { target: { value: "Setup" } });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Guide" })).toBeNull());
  expect(screen.getByRole("button", { name: "Setup" })).toBeInTheDocument();
  expect(input).toHaveFocus();
});
it("clearing the project also clears its folder without discarding the query", async () => {
  const { changes } = mount(
    { ...EMPTY_SEARCH, query: "Guide", projects: [first.slug], folder: "notes" },
    { globalOverview: true },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Clear project filter" }));
  expect(changes).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, query: "Guide" });
});
it("names no project chip on that project's own page, keeping the folder chip", async () => {
  mount({ ...EMPTY_SEARCH, projects: [first.slug], folder: "notes" });
  expect(await screen.findByRole("button", { name: "Clear folder filter" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Clear project filter" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Search all projects" })).toBeNull();
});
it("offers to widen a typed search from the project page to all projects, keeping the query", async () => {
  const { changes } = mount({ ...EMPTY_SEARCH, query: "Guide", projects: [first.slug], folder: "notes" });
  fireEvent.click(await screen.findByRole("button", { name: "Search all projects" }));
  expect(changes).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, query: "Guide" });
});
it("project headings navigate separately from editing scope", async () => {
  const onOpenProject = vi.fn();
  const { changes } = mount({ ...EMPTY_SEARCH, query: "Guide" }, { onOpenProject });
  fireEvent.click(await screen.findByRole("link", { name: "Alpha" }));
  expect(onOpenProject).toHaveBeenCalledWith(first.slug);
  expect(changes).not.toHaveBeenCalled();
});
it("shows the matched files with their ancestor folders open, keeping the query", async () => {
  mount({ ...EMPTY_SEARCH, projects: [first.slug], query: "Setup" });
  const deep = await screen.findByRole("button", { name: /^(Expand|Collapse) deep$/ });
  expect(deep).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /^(Expand|Collapse) notes$/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Setup" })).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toHaveValue("Setup");
  expect(screen.queryByRole("button", { name: "Guide" })).toBeNull();
});
it("only requests content search from the selected project", async () => {
  const { fetchImpl } = mount({ ...EMPTY_SEARCH, projects: [first.slug], query: "Setup" }, { serverSearch: true });
  await waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => url.includes("api/browser-search"))).toBe(true));
  expect(fetchImpl.mock.calls.filter(([url]) => url.includes("api/browser-search")).map(([url]) => url)).toEqual([
    "api/browser-search?q=setup",
  ]);
});
it("reports an incomplete configured listing without exposing excluded legacy files", async () => {
  const incomplete = {
    ...first,
    documents: {
      documents: [],
      complete: false,
      diagnostics: [{ code: "file_limit", path: ".archer", message: "Too many files" }],
    },
  };
  mount(
    { ...EMPTY_SEARCH, projects: [first.slug] },
    {
      fetchImpl: async (url: string) =>
        response(
          url === "api/browser-projects"
            ? { schemaVersion: 1, projects: [incomplete] }
            : { schemaVersion: 1, failures: [], targets: {} },
        ),
    },
  );
  await screen.findByText(/documentation listing incomplete/i);
  expect(screen.queryByRole("button", { name: "Guide" })).toBeNull();
});
it("does not flash legacy files while the authoritative configured catalog is loading", () => {
  mount(
    { ...EMPTY_SEARCH, projects: [first.slug] },
    {
      baseUrl: "http://localhost/p/" + first.slug + "/browse/",
      fetchImpl: async () => new Promise<Response>(() => {}),
    },
  );
  expect(screen.queryByRole("button", { name: "Guide" })).toBeNull();
});
it("waits for the URL state to be applied before restoring a browser position", async () => {
  history.replaceState(
    { archerBrowserPosition: { scrollTop: 120, row: first.slug + "\0note:notes/guide.md", search: false } },
    "",
  );
  const fetcher = async () => response({ schemaVersion: 1, projects: [first] });
  function Harness() {
    const [ready, setReady] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setReady(true)}>
          Apply URL state
        </button>
        <div className="archer-contents-panel">
          <SearchPage
            positionReady={ready}
            state={EMPTY_SEARCH}
            onChange={() => {}}
            currentSlug={first.slug}
            currentName={first.name}
            views={[]}
            notes={first.notes}
            serverSearch={false}
            baseUrl={"http://localhost/p/" + first.slug + "/"}
            now={0}
            onOpen={() => {}}
            onOpenMatch={() => {}}
            fetchImpl={fetcher}
          />
        </div>
      </>
    );
  }
  try {
    render(<Harness />);
    const guide = await screen.findByRole("button", { name: "Guide" });
    await waitFor(() => expect(document.querySelector(".archer-search-summary")).not.toHaveTextContent("listing"));
    expect(guide).not.toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Apply URL state" }));
    await waitFor(() => expect(guide).toHaveFocus());
  } finally {
    history.replaceState(null, "");
  }
});
