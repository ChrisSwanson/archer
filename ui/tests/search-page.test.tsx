// @vitest-environment jsdom
// The search page (projects-and-search.md): a table of every project's files
// with a filter rail. Carries the behaviours the sidebar's old Projects &
// files search had -- across projects, by content, no stale answers, honest
// about what could not be searched -- onto the table.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener() {}
    close = async () => {};
    connect = async () => {};
    updateModelContext = async () => ({});
  },
}));
import { App } from "../src/app/App";
import { SearchPage } from "../src/app/SearchPage";
import { EMPTY_SEARCH, type SearchState } from "../src/app/file-index";
import { MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";
import { forgetProjectCatalogs } from "../src/app/project-directory";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const view = {
  id: "checkout",
  title: "Checkout",
  kind: "sequence",
  registration: "durable" as const,
  sourcePath: "systems/checkout-flow.mmd",
  modifiedAt: "2026-10-10T10:00:00Z",
  createdAt: "2026-09-01T10:00:00Z",
  createdFrom: "git" as const,
  description: "The basket to the receipt",
};
const note = {
  path: "notes/operations.md",
  title: "Operations",
  viewIds: [],
  modifiedAt: "2026-10-09T10:00:00Z",
  description: "Running it",
};
const catalog = {
  schemaVersion: 1,
  projects: [
    {
      slug: "pageturner-a1234567",
      name: "Pageturner Books",
      description: "Independent bookshop architecture.",
      views: [view],
      notes: [note],
    },
    {
      slug: "courierdesk-b1234567",
      name: "Courierdesk",
      description: "Parcel delivery architecture.",
      views: [view],
      notes: [note],
    },
  ],
};
const activity = (totalThreads = 3, unresolvedThreads = 1) => ({
  schemaVersion: 1,
  targets: {
    "view:checkout": { totalThreads, unresolvedThreads, lastCommentedAt: "2026-10-10T12:30:00.000Z" },
    "note:notes/operations.md": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
  },
});
const json = (value: unknown, status = 200): Response =>
  ({ ok: status === 200, status, json: async () => value }) as Response;
const NOW = Date.parse("2026-10-11T12:00:00Z");

type Props = ComponentProps<typeof SearchPage>;
function page(over: Partial<Props> & { state?: SearchState } = {}) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  const onOpenMatch = vi.fn();
  const given: Props = {
    state: EMPTY_SEARCH,
    onChange,
    currentSlug: "pageturner-a1234567",
    currentName: "Pageturner Books",
    views: [view],
    notes: [note],
    serverSearch: false,
    baseUrl: "http://localhost:123/projects/pageturner-a1234567/?follow&keep=yes",
    now: NOW,
    onOpen,
    onOpenMatch,
    fetchImpl: vi.fn(async (url: string) =>
      url === "api/browser-projects"
        ? json(catalog)
        : url.endsWith("api/compile")
          ? json({ schemaVersion: 1, failures: [] })
          : url.endsWith("api/comment-activity")
            ? json(activity(url === "api/comment-activity" ? 3 : 8, url === "api/comment-activity" ? 1 : 4))
            : json({ query: "", results: [] }),
    ),
    ...over,
  };
  const rendered = render(<SearchPage {...given} />);
  return {
    ...given,
    ...rendered,
    rerender: (next: Partial<Props>) => rendered.rerender(<SearchPage {...given} {...next} />),
  };
}
const results = (): HTMLElement => screen.getByRole("region", { name: "Project documents" });
const summary = (): HTMLElement => document.querySelector<HTMLElement>(".archer-search-summary")!;
const openFilters = (): HTMLElement => {
  fireEvent.click(screen.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ }));
  return screen.getByRole("dialog", { name: "Project Filters" });
};
/** The titles of the file rows on screen, in order. */
const rowNames = (): string[] =>
  [...(screen.queryByRole("tabpanel")?.querySelectorAll<HTMLElement>("[data-browser-row]") ?? [])].map(
    (row) => row.querySelector(".archer-folder-tree-title-text")?.textContent ?? "",
  );
const fileRow = (slug: string, target: string): HTMLElement =>
  [...results().querySelectorAll<HTMLElement>("[data-browser-row]")].find(
    (row) => row.dataset.browserRow === `${slug}\0${target}`,
  )!;
const projectRoot = (name: string): HTMLElement =>
  within(results()).getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${name}$`) });
const projectRows = (): string[] =>
  [...results().querySelectorAll<HTMLElement>("[data-project-root] .archer-folder-tree-folder-link")].map(
    (node) => node.textContent ?? "",
  );
const header = (name: string): HTMLElement =>
  within(screen.getByRole("treegrid", { name: "Project files" }))
    .getAllByRole("columnheader")
    .find((cell) => cell.textContent?.startsWith(name))!;

it("shows catalog descriptions for this project and the other projects", async () => {
  page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  expect(results().querySelector('[data-browser-project="pageturner-a1234567"]')).toHaveTextContent(
    "Independent bookshop architecture.",
  );
  expect(results().querySelector('[data-browser-project="courierdesk-b1234567"]')).toHaveTextContent(
    "Parcel delivery architecture.",
  );
});

it("a selected project removes unselected project roots, and clearing it restores all projects", async () => {
  const { onChange, rerender } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  fireEvent.click(within(results()).getByRole("link", { name: "Courierdesk" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: ["courierdesk-b1234567"] });
  rerender({ state: { ...EMPTY_SEARCH, projects: ["courierdesk-b1234567"] } });
  expect(projectRows()).toEqual([]);
  expect(rowNames()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear project filter" }));
  expect(onChange).toHaveBeenLastCalledWith(EMPTY_SEARCH);
  rerender({ state: EMPTY_SEARCH });
  expect(projectRows()).toEqual(["Pageturner Books", "Courierdesk"]);
  expect(rowNames()).toHaveLength(4);
  openFilters();
  expect(screen.queryByRole("group", { name: "Project" })).toBeNull();
});

it("offers no Cards/Table toggle and no card or column pickers: the tabs replace them", async () => {
  page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  expect(screen.queryByRole("button", { name: /^View:/ })).toBeNull();
  const dialog = openFilters();
  expect(within(dialog).queryByRole("button", { name: "Card Details" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Table Columns" })).toBeNull();
});

it("clicking a project's Open navigates unfiltered while preserving presentation sort", async () => {
  const state = { ...EMPTY_SEARCH, query: "checkout", kinds: ["diagram" as const] };
  const { onChange } = page({ state });
  await waitFor(() => expect(rowNames()).toHaveLength(2));
  fireEvent.click(within(results()).getByRole("link", { name: "Courierdesk" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: ["courierdesk-b1234567"], sort: state.sort });
});

it("the tree retains source matches, metadata and project-qualified opening", async () => {
  const match = { field: "node", text: "Gateway needle", elementId: "gateway" };
  const fetchImpl = vi.fn(async (url: string) =>
    url === "api/browser-projects"
      ? json(catalog)
      : url.endsWith("api/compile")
        ? json({ schemaVersion: 1, failures: [] })
        : url.endsWith("api/comment-activity")
          ? json(activity())
          : json({
              query: "needle",
              results: [{ target: "view:checkout", title: "Checkout", where: ["diagram"], matches: [match] }],
            }),
  );
  const { onOpen, onOpenMatch } = page({ fetchImpl, serverSearch: true, state: { ...EMPTY_SEARCH, query: "needle" } });
  await waitFor(() => expect(rowNames()).toHaveLength(2));
  expect(
    within(screen.getByRole("treegrid", { name: "Project files" }))
      .getAllByRole("columnheader")
      .map((heading) => heading.textContent),
  ).toEqual(["Name", "Title", "Kind", "Threads", "Edited", "Created"]);
  const row = fileRow("courierdesk-b1234567", "view:checkout");
  expect(row).toHaveTextContent("checkout-flow.mmd");
  expect(row).toHaveTextContent("Sequence");
  fireEvent.click(within(row).getByRole("button", { name: "Node · Gateway needle" }));
  expect(onOpenMatch).toHaveBeenCalledWith(
    expect.objectContaining({ slug: "courierdesk-b1234567", target: "view:checkout" }),
    match,
  );
  fireEvent.click(within(row).getByRole("button", { name: "Checkout" }));
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ slug: "courierdesk-b1234567", current: false }));
});

it("tree headers update the shared sort state while keeping the search field mounted", async () => {
  const state: SearchState = {
    ...EMPTY_SEARCH,
    query: "checkout",
    projects: ["courierdesk-b1234567"],
    sort: { key: "name", dir: "asc" },
  };
  const { onChange, rerender } = page({ state });
  await waitFor(() => expect(rowNames()).toHaveLength(1));
  const input = screen.getByRole("searchbox", { name: "Search projects and files" });
  expect(header("Title")).toHaveAttribute("aria-sort", "ascending");
  fireEvent.click(within(header("Edited")).getByRole("button", { name: "Edited" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...state, sort: { key: "edited", dir: "desc" } });
  rerender({ state: { ...state, sort: { key: "edited", dir: "desc" } } });
  expect(header("Edited")).toHaveAttribute("aria-sort", "descending");
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(input);
  expect(input).toHaveValue("checkout");
});

it("keeps the search field, Search and Filters in one bar, with the shared ordering in Filters", async () => {
  const { onChange, rerender } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  const input = screen.getByRole("searchbox", { name: "Search projects and files" });
  const bar = input.closest(".archer-search-bar") as HTMLElement;
  expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
  let dialog = openFilters();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Sort by" }), { target: { value: "name:asc" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, sort: { key: "name", dir: "asc" } });
  rerender({ state: { ...EMPTY_SEARCH, sort: { key: "name", dir: "asc" } } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close filters" }));
  expect(within(bar).getByRole("button", { name: "Filters" })).toBeInTheDocument();
  expect(within(bar).getByRole("button", { name: "Search" })).toBeInTheDocument();
  dialog = openFilters();
  expect(within(dialog).getByRole("combobox", { name: "Sort by" })).toHaveValue("name:asc");
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(input);
});

it("tree sorting and submitted queries update the canonical address without replacing the input or filters", async () => {
  serveOverHttp();
  window.history.replaceState(
    null,
    "",
    "/projects/pageturner-a1234567/?follow&q=checkout&kind=diagram&project=courierdesk-b1234567&sort=name",
  );
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = new URL(url, window.location.href).pathname.split("/api/")[1];
      return json(
        route === "bootstrap"
          ? { capabilities: { notes: false }, project: { name: "Pageturner Books" }, diagnostics: [] }
          : route === "diagrams"
            ? { schemaVersion: 1, views: [view] }
            : route === "browser-projects"
              ? catalog
              : route === "compile"
                ? { schemaVersion: 1, failures: [] }
                : route === "browser-search"
                  ? { query: "checkout", results: [] }
                  : null,
      );
    }),
  );
  try {
    render(<App />);
    await screen.findByRole("treegrid", { name: "Project files" });
    const input = screen.getByRole("searchbox", { name: "Search projects and files" });
    await waitFor(() => expect(input).toHaveValue("checkout"));
    expect(header("Title")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(header("Title")).getByRole("button", { name: "Title" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("sort")).toBe("-name"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("q")).toBe("checkout");
    expect(params.get("kind")).toBe("diagram");
    expect(params.get("project")).toBe("courierdesk-b1234567");
    expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(input);
    expect(input).toHaveValue("checkout");
    expect(header("Title")).toHaveAttribute("aria-sort", "descending");
    fireEvent.change(input, { target: { value: "operations" } });
    expect(new URLSearchParams(window.location.search).get("q")).toBe("operations");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("q")).toBe("operations"));
    const submitted = new URLSearchParams(window.location.search);
    expect(submitted.get("sort")).toBe("-name");
    expect(submitted.get("kind")).toBe("diagram");
    expect(submitted.get("project")).toBe("courierdesk-b1234567");
    expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(input);
  } finally {
    cleanup();
    restoreLocation();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    forgetProjectCatalogs();
  }
});

it("lists every project's files with their details, the same id in two projects as two rows", async () => {
  const { onOpen } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  const courier = fileRow("courierdesk-b1234567", "view:checkout");
  expect(courier).toHaveTextContent("Checkout");
  expect(courier).toHaveTextContent("Sequence");
  expect(courier).toHaveTextContent("checkout-flow.mmd");
  expect(
    within(courier).getByRole("gridcell", { name: /^Created .*from Git: the commit that first added the file$/ }),
  ).toHaveTextContent(/· Git$/);
  fireEvent.click(within(courier).getByRole("button", { name: "Checkout" }));
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ slug: "courierdesk-b1234567", id: "checkout", current: false }),
  );
});

it("offers every supported sort through the shared-address sort control", async () => {
  const { onChange } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  const sort = within(openFilters()).getByRole("combobox", { name: "Sort by" });
  expect(sort).toHaveValue("edited:desc");
  expect(within(sort).getAllByRole("option")).toHaveLength(20);
  fireEvent.change(sort, { target: { value: "name:asc" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, sort: { key: "name", dir: "asc" } });
  fireEvent.change(sort, { target: { value: "edited:asc" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, sort: { key: "edited", dir: "asc" } });
});

it.each([
  ["asc", ["Courierdesk", "Pageturner Books"]],
  ["desc", ["Pageturner Books", "Courierdesk"]],
] as const)("sorts the project roots %s", async (dir, names) => {
  page({ state: { ...EMPTY_SEARCH, sort: { key: "project", dir } } });
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  expect(projectRows()).toEqual(names);
});

it("filters from the rail, each control labelled, each choice counted", async () => {
  const { onChange, rerender } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  const rail = openFilters();
  const kind = within(rail).getByRole("group", { name: "Kind" });
  expect(within(kind).getByRole("checkbox", { name: /Notes/ })).not.toBeChecked();
  expect(within(kind).getAllByLabelText("2 files", { selector: "span" })).toHaveLength(2);
  fireEvent.click(within(kind).getByRole("checkbox", { name: /Notes/ }));
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, kinds: ["note"] });
  rerender({ state: { ...EMPTY_SEARCH, kinds: ["note"] } });
  expect(rowNames()).toEqual(["Operations", "Operations"]);
  expect(within(rail).getByRole("combobox", { name: "Folder" })).toBeInTheDocument();
  const edited = within(rail).getByRole("group", { name: "Edited" });
  expect(within(rail).getByRole("group", { name: "Created" })).toBeInTheDocument();
  expect(within(rail).getByRole("group", { name: "Commented" })).toBeInTheDocument();
  fireEvent.change(within(edited).getByRole("combobox", { name: "Edited" }), { target: { value: "between" } });
  fireEvent.change(within(edited).getByLabelText("From"), { target: { value: "2026-10-01" } });
  expect(onChange).toHaveBeenCalledTimes(1);
  fireEvent.change(within(edited).getByLabelText("To"), { target: { value: "2026-10-10" } });
  expect(onChange).toHaveBeenLastCalledWith({
    ...EMPTY_SEARCH,
    kinds: ["note"],
    edited: { from: "2026-10-01", to: "2026-10-10" },
  });
  fireEvent.click(within(rail).getByRole("button", { name: "Clear filters" }));
  expect(onChange).toHaveBeenLastCalledWith(EMPTY_SEARCH);
});

it("keeps every filter group visible as a permanent section", async () => {
  page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  const dialog = openFilters();

  for (const title of ["Files", "Discussions", "Dates"]) {
    const section = within(dialog).getByRole("heading", { name: title }).closest("section")!;
    expect(section).toBeInTheDocument();
    expect(section.querySelector("summary")).toBeNull();
    expect(section.querySelector(".archer-filter-section-grid")).toBeVisible();
  }
});

it("organizes file, discussion and date filters into permanent sections and removes the project checklist", async () => {
  page({
    state: {
      ...EMPTY_SEARCH,
      projects: ["courierdesk-b1234567"],
      unresolvedThreads: { min: 2 },
      edited: { preset: "7d" },
    },
  });
  await waitFor(() => expect(rowNames()).toHaveLength(0));
  const dialog = openFilters();
  const files = within(dialog)
    .getByRole("heading", { name: /^Files(?:\s*\d+ active)?$/ })
    .closest("section");
  const discussions = within(dialog)
    .getByRole("heading", { name: /^Discussions(?:\s*\d+ active)?$/ })
    .closest("section");
  const dates = within(dialog)
    .getByRole("heading", { name: /^Dates(?:\s*\d+ active)?$/ })
    .closest("section");
  expect(files).toBeVisible();
  expect(discussions).toBeVisible();
  expect(dates).toBeVisible();
  expect(discussions).toHaveTextContent("1 active");
  expect(dates).toHaveTextContent("1 active");
  expect(within(dialog).queryByRole("group", { name: "Project" })).toBeNull();
  expect(screen.getByRole("button", { name: "Clear project filter" })).toHaveTextContent("Courierdesk");
});

it("commits count operators only when their local draft is valid, then resyncs external state", async () => {
  const { onChange, rerender } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  const dialog = openFilters();
  const total = within(dialog).getByRole("group", { name: "Total threads" });
  const operator = within(total).getByRole("combobox", { name: "Total threads condition" });
  fireEvent.change(operator, { target: { value: "between" } });
  const minimum = within(total).getByRole("spinbutton", { name: "Minimum" });
  const maximum = within(total).getByRole("spinbutton", { name: "Maximum" });
  fireEvent.change(minimum, { target: { value: "9" } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(maximum, { target: { value: "4" } });
  expect(onChange).not.toHaveBeenCalled();
  expect(within(total).getByRole("alert")).toHaveTextContent("Minimum cannot exceed maximum");
  fireEvent.change(maximum, { target: { value: "12" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, totalThreads: { min: 9, max: 12 } });

  rerender({ state: { ...EMPTY_SEARCH, totalThreads: { min: 5, max: 5 } } });
  expect(operator).toHaveValue("equals");
  expect(within(total).getByRole("spinbutton", { name: "Count" })).toHaveValue(5);
  fireEvent.change(operator, { target: { value: "any" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, totalThreads: null });
});

it("counts date choices with the other filters applied, updating when kind changes", async () => {
  const { rerender } = page({ state: { ...EMPTY_SEARCH, kinds: ["diagram"], edited: { preset: "1d" } } });
  openFilters();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Edited" })).toContainHTML("Past week (2)"));
  const edited = screen.getByRole("combobox", { name: "Edited" });
  const created = screen.getByRole("combobox", { name: "Created" });
  expect(within(edited).getByRole("option", { name: "Any time (2)" })).toHaveValue("");
  expect(within(edited).getByRole("option", { name: "Past day (0)" })).toHaveValue("1d");
  expect(within(created).getByRole("option", { name: "Past year (0)" })).toHaveValue("365d");
  rerender({ state: { ...EMPTY_SEARCH, kinds: ["note"] } });
  expect(within(edited).getByRole("option", { name: "Past week (2)" })).toHaveValue("7d");
  expect(within(created).getByRole("option", { name: "Any time (2)" })).toHaveValue("");
  expect(within(created).getByRole("option", { name: "Past year (0)" })).toHaveValue("365d");
});

it("searches each project's contents after a pause, and a match opens where it is", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url === "api/browser-projects") return json(catalog);
    if (url.endsWith("api/compile")) return json({ schemaVersion: 1, failures: [] });
    const results = url.includes("courierdesk")
      ? [
          {
            target: "note:notes/operations.md",
            title: "Operations",
            where: ["note"],
            matches: [{ field: "note", text: "the quasar runbook", notePath: "notes/operations.md" }],
          },
        ]
      : [];
    return json({ query: "quasar", results });
  });
  const { onOpenMatch } = page({ fetchImpl, serverSearch: true, state: { ...EMPTY_SEARCH, query: "quasar" } });
  expect(summary()).toHaveTextContent(/searching diagrams, notes and comments/);
  await waitFor(() => expect(rowNames()).toEqual(["Operations"]));
  const row = fileRow("courierdesk-b1234567", "note:notes/operations.md");
  expect(row).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: /the quasar runbook/ }));
  expect(onOpenMatch).toHaveBeenCalledWith(
    expect.objectContaining({ slug: "courierdesk-b1234567" }),
    expect.objectContaining({ field: "note" }),
  );
});

it("never lets an older answer stand for a newer query", async () => {
  const pending = new Map<string, (response: Response) => void>();
  const fetchImpl = vi.fn((url: string) =>
    url === "api/browser-projects"
      ? Promise.resolve(json(catalog))
      : url.endsWith("api/compile")
        ? Promise.resolve(json({ schemaVersion: 1, failures: [] }))
        : new Promise<Response>((resolve) => pending.set(url, resolve)),
  );
  const { rerender } = page({ fetchImpl, serverSearch: true, state: { ...EMPTY_SEARCH, query: "oldneedle" } });
  await waitFor(() => expect(pending.size).toBe(2));
  rerender({ fetchImpl, serverSearch: true, state: { ...EMPTY_SEARCH, query: "newneedle" } });
  await waitFor(() => expect(pending.size).toBe(4));
  for (const [url, resolve] of pending)
    if (url.includes("newneedle"))
      resolve(
        json({
          query: "newneedle",
          results: [
            {
              target: "view:checkout",
              title: "Checkout",
              where: ["diagram"],
              matches: [{ field: "node", text: "newneedle", elementId: "pay" }],
            },
          ],
        }),
      );
  await waitFor(() => expect(rowNames()).toEqual(["Checkout", "Checkout"]));
  for (const [url, resolve] of pending)
    if (url.includes("oldneedle")) resolve(json({ query: "oldneedle", results: [] }));
  await waitFor(() => expect(rowNames()).toEqual(["Checkout", "Checkout"]));
});

it("does not say nothing matches before the projects are listed and their services have answered", async () => {
  let resolveCatalog!: (response: Response) => void;
  let resolveCourier!: (response: Response) => void;
  const fetchImpl = vi.fn((url: string) => {
    if (url === "api/browser-projects") return new Promise<Response>((resolve) => (resolveCatalog = resolve));
    if (url.endsWith("api/compile")) return Promise.resolve(json({ schemaVersion: 1, failures: [] }));
    if (url.endsWith("api/comment-activity")) return Promise.resolve(json(activity()));
    if (url.includes("courierdesk")) return new Promise<Response>((resolve) => (resolveCourier = resolve));
    return Promise.resolve(json({ query: "quasar", results: [] }));
  });
  page({ fetchImpl, serverSearch: true, state: { ...EMPTY_SEARCH, query: "quasar" } });
  await waitFor(() => expect(summary()).toHaveTextContent(/listing the other projects/));
  expect(screen.queryByText(/Nothing matches/)).toBeNull();
  resolveCatalog(json(catalog));
  await waitFor(() => expect(resolveCourier).toBeDefined());
  expect(screen.queryByText(/Nothing matches/)).toBeNull();
  resolveCourier(
    json({
      query: "quasar",
      results: [
        {
          target: "note:notes/operations.md",
          title: "Operations",
          where: ["note"],
          matches: [{ field: "note", text: "the quasar runbook", notePath: "notes/operations.md" }],
        },
      ],
    }),
  );
  await waitFor(() => expect(rowNames()).toEqual(["Operations"]));
});

it("loads aggregate comment activity once per project and exposes count and Commented filters", async () => {
  const fetchImpl = vi.fn(async (url: string) =>
    url === "api/browser-projects"
      ? json(catalog)
      : url.endsWith("api/compile")
        ? json({ schemaVersion: 1, failures: [] })
        : url.endsWith("api/comment-activity")
          ? json(activity(url === "api/comment-activity" ? 3 : 8, url === "api/comment-activity" ? 1 : 4))
          : json({ query: "", results: [] }),
  );
  const { onChange } = page({ fetchImpl });
  await waitFor(() => expect(fileRow("courierdesk-b1234567", "view:checkout")).toHaveTextContent("8 · 4 open"));
  expect(
    fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("api/comment-activity")).map(([url]) => url),
  ).toEqual(["api/comment-activity", "http://localhost:123/p/courierdesk-b1234567/api/comment-activity"]);
  const dialog = openFilters();
  const total = within(dialog).getByRole("group", { name: "Total threads" });
  fireEvent.change(within(total).getByRole("combobox", { name: "Total threads condition" }), {
    target: { value: "at-least" },
  });
  fireEvent.change(within(total).getByRole("spinbutton", { name: "Minimum" }), { target: { value: "5" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, totalThreads: { min: 5 } });
  const unresolved = within(dialog).getByRole("group", { name: "Unresolved threads" });
  fireEvent.change(within(unresolved).getByRole("combobox", { name: "Unresolved threads condition" }), {
    target: { value: "at-most" },
  });
  expect(within(unresolved).getByRole("spinbutton", { name: "Maximum" })).toHaveAttribute("min", "0");
  expect(within(dialog).getByRole("combobox", { name: "Commented" })).toBeInTheDocument();
});

it("says when nothing matches, and how to widen it", async () => {
  page({ state: { ...EMPTY_SEARCH, query: "unmatchedneedle", kinds: ["note"] } });
  await waitFor(() => expect(screen.getByText("Nothing matches “unmatchedneedle” with these filters.")).toBeVisible());
  expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(0);
});

// E5 (user flows round 1, claude-05/codex-02): the empty result's next step clears what caused it. "Clear filters"
// alone kept the unmatched words, widened a project page to every project and landed on "Nothing matches" again.
const OWN = "pageturner-a1234567";
const panel = (): HTMLElement => screen.getByRole("tabpanel");
it("offers to clear the search when the words match nothing, and clearing it lands on the files", async () => {
  const { onChange, rerender } = page({ state: { ...EMPTY_SEARCH, projects: [OWN], query: "zzqxnotaword" } });
  await waitFor(() => expect(within(panel()).getByText("Nothing matches “zzqxnotaword”.")).toBeVisible());
  // The project page's own scope is not a filter the person set: no "with these filters", no widening step.
  expect(within(panel()).queryByRole("button", { name: "Clear filters" })).toBeNull();
  fireEvent.click(within(panel()).getByRole("button", { name: "Clear the search" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: [OWN] });
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toHaveValue("");
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toHaveFocus();
  rerender({ state: vi.mocked(onChange).mock.lastCall![0] });
  await waitFor(() => expect([...rowNames()].sort()).toEqual(["Checkout", "Operations"]));
  expect(screen.queryByText(/Nothing matches/)).toBeNull();
});

// O94: the Filters dialog's own "Clear filters" dropped a project page's scope too, widening to every project.
it("the Filters dialog's Clear filters keeps a project page's own project, and is not offered for that scope alone", async () => {
  const { onChange, rerender } = page({
    state: { ...EMPTY_SEARCH, projects: [OWN], query: "checkout", kinds: ["note"] },
  });
  fireEvent.click(within(openFilters()).getByRole("button", { name: "Clear filters" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: [OWN], query: "checkout" });
  rerender({ state: vi.mocked(onChange).mock.lastCall![0] });
  expect(
    within(screen.getByRole("dialog", { name: "Project Filters" })).queryByRole("button", { name: "Clear filters" }),
  ).toBeNull();
  // Nor counted as one: the page's own project is not "1 active".
  expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
});

it("with filters set as well, offers both, and clearing the filters keeps the words and the project", async () => {
  const { onChange } = page({ state: { ...EMPTY_SEARCH, projects: [OWN], query: "checkout", kinds: ["note"] } });
  await waitFor(() =>
    expect(within(panel()).getByText("Nothing matches “checkout” with these filters.")).toBeVisible(),
  );
  expect(within(panel()).getByRole("button", { name: "Clear the search" })).toBeVisible();
  fireEvent.click(within(panel()).getByRole("button", { name: "Clear filters" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: [OWN], query: "checkout" });
});

// O33: hiding them left a project page at "0 files" until a later catalog read succeeded.
it("lists this project's own files, coverage reported incomplete, when the first project catalog cannot be listed", async () => {
  const fetchImpl = vi.fn(async () => json(null, 500));
  page({ fetchImpl, serverSearch: true, state: { ...EMPTY_SEARCH, query: "checkout" } });
  await waitFor(() => expect(summary()).toHaveTextContent(/other projects could not be listed/));
  expect(summary()).toHaveTextContent(/Documentation listing incomplete for Pageturner Books/);
  expect(rowNames()).toEqual(["Checkout"]);
});

it("marks the other projects' diagrams that do not compile, from their own services", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url === "api/browser-projects") return json(catalog);
    if (url.includes("courierdesk") && url.endsWith("api/compile"))
      return json({
        schemaVersion: 1,
        failures: [{ viewId: "checkout", sourceRevision: "sha256:1", lastValidRevision: null, diagnostics: [] }],
      });
    return json({ schemaVersion: 1, failures: [] });
  });
  page({ fetchImpl, state: { ...EMPTY_SEARCH, status: ["failing"] } });
  await waitFor(() =>
    expect(within(results()).getByRole("button", { name: "Checkout — does not compile" })).toBeInTheDocument(),
  );
  expect(rowNames()).toHaveLength(1);
});

it("typing applies the query and Enter retains filters without opening a result", async () => {
  const state: SearchState = {
    ...EMPTY_SEARCH,
    query: "operations",
    kinds: ["note"],
    projects: ["courierdesk-b1234567"],
  };
  const { onOpen, onChange } = page({ state });
  await waitFor(() => expect(rowNames()).toEqual(["Operations"]));
  const box = screen.getByRole("searchbox", { name: "Search projects and files" });
  fireEvent.change(box, { target: { value: "checkout" } });
  expect(box).toHaveValue("checkout");
  expect(onChange).toHaveBeenLastCalledWith({ ...state, query: "checkout" });
  expect(rowNames()).toEqual(["Operations"]);
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith({ ...state, query: "checkout" });
  expect(onOpen).not.toHaveBeenCalled();
});

it("the Search button confirms the live query without opening a result", async () => {
  const state: SearchState = {
    ...EMPTY_SEARCH,
    query: "operations",
    kinds: ["note"],
    projects: ["courierdesk-b1234567"],
  };
  const { onOpen, onChange } = page({ state });
  await waitFor(() => expect(rowNames()).toEqual(["Operations"]));
  const box = screen.getByRole("searchbox", { name: "Search projects and files" });
  fireEvent.change(box, { target: { value: "checkout" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...state, query: "checkout" });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...state, query: "checkout" });
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(box);
});

it("Escape clears the draft and committed query while preserving filters", async () => {
  const state: SearchState = { ...EMPTY_SEARCH, query: "operations", kinds: ["note"] };
  const { onOpen, onChange } = page({ state });
  await waitFor(() => expect(rowNames()).toHaveLength(2));
  const box = screen.getByRole("searchbox", { name: "Search projects and files" });
  fireEvent.change(box, { target: { value: "unsubmitted" } });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(box).toHaveValue("");
  expect(onChange).toHaveBeenLastCalledWith({ ...state, query: "" });
  expect(onOpen).not.toHaveBeenCalled();
});

it("external committed queries replace the draft in the same input, while filter edits retain it", async () => {
  const { rerender } = page({ state: { ...EMPTY_SEARCH, query: "operations" } });
  await waitFor(() => expect(rowNames()).toHaveLength(2));
  const box = screen.getByRole("searchbox", { name: "Search projects and files" });
  fireEvent.change(box, { target: { value: "unsubmitted" } });
  rerender({ state: { ...EMPTY_SEARCH, query: "operations", projects: ["courierdesk-b1234567"] } });
  expect(box).toHaveValue("unsubmitted");
  rerender({ state: { ...EMPTY_SEARCH, query: "checkout", projects: ["courierdesk-b1234567"] } });
  expect(box).toHaveValue("checkout");
  expect(screen.getByRole("searchbox", { name: "Search projects and files" })).toBe(box);
});
it("a completed query filters out projects with no matching documents", async () => {
  page({ state: { ...EMPTY_SEARCH, query: "parcel" } });
  await waitFor(() => expect(rowNames()).toHaveLength(2));
  expect(projectRows()).toEqual(["Courierdesk"]);
});

it("keeps a collapsed project root closed across tabs without changing the query", async () => {
  const { onChange, rerender } = page();
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  fireEvent.click(projectRoot("Pageturner Books"));
  expect(projectRoot("Pageturner Books")).toHaveAttribute("aria-expanded", "false");
  expect(rowNames()).toHaveLength(2);
  rerender({ state: { ...EMPTY_SEARCH, tab: "notes" } });
  rerender({ state: EMPTY_SEARCH });
  expect(projectRoot("Pageturner Books")).toHaveAttribute("aria-expanded", "false");
  expect(onChange).not.toHaveBeenCalled();
});

it("a sidebar project request expands its project and collapses the other roots without filtering them out", async () => {
  const browser = page({ projectExpansion: { slug: "courierdesk-b1234567" } });
  await waitFor(() => expect(projectRoot("Pageturner Books")).toHaveAttribute("aria-expanded", "false"));
  expect(projectRoot("Courierdesk")).toHaveAttribute("aria-expanded", "true");
  expect(browser.onChange).not.toHaveBeenCalled();
  fireEvent.click(projectRoot("Pageturner Books"));
  browser.rerender({ projectExpansion: { slug: "courierdesk-b1234567" } });
  await waitFor(() => expect(projectRoot("Pageturner Books")).toHaveAttribute("aria-expanded", "false"));
  browser.rerender({ projectExpansion: { slug: null } });
  await waitFor(() => expect(projectRoot("Pageturner Books")).toHaveAttribute("aria-expanded", "true"));
  expect(projectRoot("Courierdesk")).toHaveAttribute("aria-expanded", "true");
});

it("searches configured document bodies independently of legacy note capability", async () => {
  serveOverHttp();
  window.history.replaceState(null, "", "/projects/pageturner-a1234567/?q=needle");
  vi.stubGlobal("EventSource", MockEventSource);
  const fetcher = vi.fn(async (url: string) => {
    const route = new URL(url, window.location.href).pathname.split("/api/")[1];
    if (route === "bootstrap")
      return json({ capabilities: { notes: false }, project: { name: "Pageturner Books" }, diagnostics: [] });
    return json(
      route === "browser-projects"
        ? {
            schemaVersion: 1,
            projects: [
              {
                slug: "pageturner-a1234567",
                name: "Pageturner Books",
                views: [],
                notes: [],
                documents: {
                  documents: [
                    {
                      source: { path: "docs/guide.md" },
                      kind: "markdown",
                      title: "Guide",
                      capabilities: { read: true, sourceWrite: false, comments: false, emphasis: false },
                    },
                  ],
                  complete: true,
                  diagnostics: [],
                },
              },
            ],
          }
        : route === "browser-search"
          ? {
              query: "needle",
              results: [
                {
                  target: "source:docs/guide.md",
                  title: "Guide",
                  where: ["note"],
                  matches: [{ field: "note", text: "Hidden needle" }],
                },
              ],
            }
          : route === "diagrams"
            ? { schemaVersion: 1, views: [] }
            : route === "compile"
              ? { schemaVersion: 1, failures: [] }
              : route === "documents/content"
                ? {
                    source: { path: "docs/guide.md" },
                    kind: "markdown",
                    text: "# Guide",
                    markdown: "# Guide",
                    revision: "sha256:a",
                  }
                : null,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<App />);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("api/browser-search"))).toBe(true));
    await screen.findByRole("button", { name: "Guide" });
  } finally {
    cleanup();
    restoreLocation();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    forgetProjectCatalogs();
  }
});

it("puts the project's diagram actions at the end of the tab row on every tab, outside the tablist", async () => {
  const own = { ...EMPTY_SEARCH, projects: ["pageturner-a1234567"] };
  const { rerender } = page({ state: own, diagramActions: <button type="button">New</button> });
  for (const tab of ["folders", "diagrams", "notes"] as const) {
    rerender({ state: { ...own, tab } });
    const tabs = await screen.findByRole("tablist", { name: "Project content" });
    const action = screen.getByRole("button", { name: "New" });
    expect(tabs).not.toContainElement(action);
    expect(screen.getByRole("tabpanel")).not.toContainElement(action);
    expect(tabs.parentElement).toContainElement(action);
  }
});

it("a project page asks nothing about the projects it is not showing until the search is widened (perf #7)", async () => {
  forgetProjectCatalogs();
  const fetchImpl = vi.fn(async (url: string) =>
    url === "api/browser-projects"
      ? json(catalog)
      : url.endsWith("api/compile")
        ? json({ schemaVersion: 1, failures: [] })
        : url.endsWith("api/comment-activity")
          ? json(activity())
          : json({ query: "", results: [] }),
  );
  const own = { ...EMPTY_SEARCH, projects: ["pageturner-a1234567"] };
  const { rerender } = page({ fetchImpl, state: own });
  await waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => url === "api/comment-activity")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const other = (): string[] =>
    fetchImpl.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("courierdesk"));
  expect(other()).toEqual([]);
  rerender({ fetchImpl, state: EMPTY_SEARCH });
  await waitFor(() =>
    expect(other().sort()).toEqual([
      "http://localhost:123/p/courierdesk-b1234567/api/comment-activity",
      "http://localhost:123/p/courierdesk-b1234567/api/compile",
    ]),
  );
});

it("lists the good projects and names the one it cannot list, with a plain reason", async () => {
  const mixed = {
    schemaVersion: 1,
    projects: [
      catalog.projects[0],
      {
        slug: "huge-c1234567",
        name: "Huge Repo",
        views: [view],
        notes: Array.from({ length: 50_001 }, (_, i) => ({ ...note, path: `notes/n${i}.md` })),
      },
      { slug: "odd-d1234567", name: "Odd Repo", views: "nope", notes: [] },
      catalog.projects[1],
    ],
  };
  const fetchImpl = vi.fn(async (url: string) =>
    url === "api/browser-projects"
      ? json(mixed)
      : url.endsWith("api/compile")
        ? json({ schemaVersion: 1, failures: [] })
        : url.endsWith("api/comment-activity")
          ? json(activity())
          : json({ query: "", results: [] }),
  );
  page({ fetchImpl });
  await waitFor(() => expect(within(results()).getByRole("link", { name: "Courierdesk" })).toBeInTheDocument());
  const unavailable = screen.getByRole("list", { name: "Not listed:" });
  expect(within(unavailable).getByText("Huge Repo")).toBeVisible();
  expect(within(unavailable).getByText("Too large to list here")).toBeVisible();
  expect(within(unavailable).getByText("Odd Repo")).toBeVisible();
  expect(within(unavailable).getByText("Could not be read")).toBeVisible();
  expect(summary()).not.toHaveTextContent(/could not be listed/);
});

it("an identical catalog on the 15 s poll commits nothing", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    const onRender = vi.fn();
    const fetchImpl = vi.fn(async (url: string) =>
      url === "api/browser-projects"
        ? json(catalog)
        : url.endsWith("api/compile")
          ? json({ schemaVersion: 1, failures: [] })
          : url.endsWith("api/comment-activity")
            ? json(activity())
            : json({ query: "", results: [] }),
    );
    const base: Props = {
      state: EMPTY_SEARCH,
      onChange: vi.fn(),
      currentSlug: "pageturner-a1234567",
      currentName: "Pageturner Books",
      views: [view],
      notes: [note],
      serverSearch: false,
      baseUrl: "http://localhost:123/projects/pageturner-a1234567/?follow&keep=yes",
      now: NOW,
      onOpen: vi.fn(),
      onOpenMatch: vi.fn(),
      fetchImpl,
    };
    render(
      <Profiler id="search" onRender={onRender}>
        <SearchPage {...base} />
      </Profiler>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const settled = onRender.mock.calls.length;
    expect(fetchImpl.mock.calls.filter(([url]) => url === "api/browser-projects").length).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(fetchImpl.mock.calls.filter(([url]) => url === "api/browser-projects").length).toBe(2);
    // React may note the poll's setState and bail out at once (a zero-cost pass); a rebuilt tree would cost time.
    expect(onRender.mock.calls.slice(settled).filter((call) => call[2] > 0.5)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
