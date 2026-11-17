// @vitest-environment jsdom
// The project page frame: a project's own page leads with its title section
// (the gear in place of Archive project) and README card; every browser offers
// Folders, Diagrams and Notes tabs, each counted, the shared search and filters
// applying to all three, the chosen tab reported as part of the address.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "../src/app/SearchPage";
import { EMPTY_SEARCH, type SearchState } from "../src/app/file-index";
import { forgetProjectCatalogs } from "../src/app/project-directory";

afterEach(() => {
  cleanup();
  forgetProjectCatalogs();
  window.localStorage.clear();
});

const views = [
  {
    id: "checkout",
    title: "Checkout",
    kind: "sequence",
    registration: "durable" as const,
    sourcePath: "flows/checkout.mmd",
    modifiedAt: "2026-10-10T10:00:00Z",
  },
  {
    id: "context",
    title: "Context",
    kind: "c4",
    registration: "durable" as const,
    sourcePath: "context.mmd",
    modifiedAt: "2026-10-09T10:00:00Z",
  },
];
const notes = [{ path: "notes/operations.md", title: "Operations", viewIds: [], modifiedAt: "2026-10-08T10:00:00Z" }];
const slug = "shop-a1234567";
const json = (value: unknown, status = 200): Response =>
  ({ ok: status === 200, status, json: async () => value }) as Response;
const catalogEntry = (extra: Record<string, unknown> = {}) => ({
  slug,
  name: "Shop",
  description: "An online shop.",
  views,
  notes,
  ...extra,
});
const other = { slug: "desk-b1234567", name: "Desk", views: [views[0]], notes: [] };

function page(
  over: Partial<ComponentProps<typeof SearchPage>> & {
    readonly state?: SearchState;
    readonly entry?: Record<string, unknown>;
  } = {},
) {
  const onChange = vi.fn();
  const { entry, ...rest } = over;
  const fetchImpl = vi.fn(async (url: string) =>
    url === "api/browser-projects"
      ? json({ schemaVersion: 1, projects: [catalogEntry(entry), other] })
      : url.includes("api/documents/content")
        ? json({ source: { path: "README.md" }, markdown: "# Shop\n\nThe shop's readme." })
        : url.endsWith("api/compile")
          ? json({ schemaVersion: 1, failures: [] })
          : json({ schemaVersion: 1, targets: {} }),
  );
  const props: ComponentProps<typeof SearchPage> = {
    state: { ...EMPTY_SEARCH, projects: [slug] },
    onChange,
    currentSlug: slug,
    currentName: "Shop",
    views,
    notes,
    serverSearch: false,
    baseUrl: `http://localhost/projects/${slug}/`,
    now: Date.parse("2026-10-11T12:00:00Z"),
    onOpen: vi.fn(),
    onOpenMatch: vi.fn(),
    fetchImpl,
    ...rest,
  };
  const mounted = render(<SearchPage {...props} />);
  return {
    ...props,
    onChange,
    fetchImpl,
    rerender: (next: Partial<ComponentProps<typeof SearchPage>>) =>
      mounted.rerender(<SearchPage {...props} {...next} />),
  };
}
const tab = (name: string): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Project content" })).getByRole("tab", { name: new RegExp(`^${name}`) });

describe("a project's own page", () => {
  it("leads with the title section and the gear, and has no Archive project button", async () => {
    page({ onOpenSettings: vi.fn() });
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeInTheDocument();
    await screen.findByText("An online shop.");
    expect(screen.getByRole("button", { name: "Project settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive project/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /README/ })).toBeNull();
  });

  it("shows the README card only when the catalog names a root README", async () => {
    page({
      entry: {
        readme: { path: "README.md" },
        facts: { projectFolder: "~/code/shop", git: { branch: "main", commit: "abcdef1234" } },
      },
    });
    const card = await screen.findByRole("region", { name: /README/ });
    expect(await within(card).findByText("The shop's readme.")).toBeInTheDocument();
    expect(screen.getByLabelText("Project facts")).toHaveTextContent("~/code/shop");
    expect(screen.getByLabelText("Project facts")).toHaveTextContent("mainabcdef1");
  });

  it("calls the settings hook from the gear", async () => {
    const onOpenSettings = vi.fn();
    page({ onOpenSettings });
    fireEvent.click(await screen.findByRole("button", { name: "Project settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("has no title section on a folder of the project, on the search across projects, or on the overview", async () => {
    const mounted = page({ state: { ...EMPTY_SEARCH, projects: [slug], folder: "flows" } });
    await screen.findByRole("tablist", { name: "Project content" });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    mounted.rerender({ state: { ...EMPTY_SEARCH, query: "check" } });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    cleanup();
    page({ globalOverview: true, currentSlug: null, currentName: "", views: [], notes: [], state: EMPTY_SEARCH });
    await screen.findByRole("tablist", { name: "Project content" });
    expect(screen.queryByRole("button", { name: "Project settings" })).toBeNull();
  });
});

describe("the tabs", () => {
  it("opens on Folders, counts each tab, and reports a tab choice as a state change", async () => {
    const mounted = page();
    await waitFor(() => expect(tab("Folders")).toHaveTextContent("3"));
    expect(tab("Folders")).toHaveAttribute("aria-selected", "true");
    expect(tab("Diagrams")).toHaveTextContent("2");
    expect(tab("Notes")).toHaveTextContent("1");
    expect(screen.getByRole("tabpanel")).toContainElement(screen.getByRole("treegrid", { name: "Project files" }));
    fireEvent.click(tab("Diagrams"));
    expect(mounted.onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: [slug], tab: "diagrams" });
  });

  it("lists the root README in Folders only: Notes are the Archer folder's notes, as the facts line counts them", async () => {
    const caps = { read: true, sourceWrite: false, comments: false, emphasis: false };
    page({
      entry: {
        readme: { path: "README.md" },
        documents: {
          complete: true,
          documents: [
            ...views.map((view) => ({
              source: { path: `.archer/${view.sourcePath}` },
              kind: "mermaid",
              title: view.title,
              capabilities: caps,
              legacy: { viewId: view.id },
            })),
            {
              source: { path: ".archer/notes/operations.md" },
              kind: "markdown",
              title: "Operations",
              capabilities: caps,
              legacy: { notePath: "notes/operations.md" },
            },
            { source: { path: "README.md" }, kind: "markdown", title: "Shop", capabilities: caps },
          ],
        },
      },
    });
    await waitFor(() => expect(tab("Folders")).toHaveTextContent("4"));
    expect(tab("Notes")).toHaveTextContent("1");
  });

  it("moves between tabs with the arrow keys", async () => {
    const mounted = page();
    await screen.findByRole("tablist", { name: "Project content" });
    fireEvent.keyDown(tab("Folders"), { key: "ArrowLeft" });
    expect(mounted.onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: [slug], tab: "notes" });
  });

  it("applies the shared search to every tab", async () => {
    const state: SearchState = { ...EMPTY_SEARCH, projects: [slug], query: "check" };
    const mounted = page({ state });
    await waitFor(() => expect(tab("Diagrams")).toHaveTextContent("1"));
    expect(tab("Notes")).toHaveTextContent("0");
    mounted.rerender({ state: { ...state, tab: "diagrams" } });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("button", { name: "Checkout" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Context" })).toBeNull();
    mounted.rerender({ state: { ...state, tab: "notes" } });
    expect(within(screen.getByRole("tabpanel")).getByText(/^Nothing here matches/)).toBeInTheDocument();
  });

  it("remembers a folder closed on the project page: its own scope is not a filter", async () => {
    page();
    const flows = await screen.findByRole("button", { name: /^(Expand|Collapse) flows$/ });
    fireEvent.click(flows);
    expect(flows).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem("archer.folderTree.v1")!)).toEqual({ [slug]: { flows: false } });
  });

  it("keeps the tab and the page's own project when the filters are cleared (O94)", async () => {
    const mounted = page({ state: { ...EMPTY_SEARCH, projects: [slug], tab: "notes", kinds: ["diagram"] } });
    await screen.findByRole("tablist", { name: "Project content" });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mounted.onChange).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, projects: [slug], tab: "notes" });
  });

  it("across projects, Diagrams name each file's project and Folders roots each project", async () => {
    const mounted = page({
      globalOverview: true,
      currentSlug: null,
      currentName: "",
      views: [],
      notes: [],
      state: EMPTY_SEARCH,
    });
    const grid = await screen.findByRole("treegrid", { name: "Project files" });
    await waitFor(() =>
      expect(within(grid).getByRole("button", { name: /^(Expand|Collapse) Shop$/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(await within(grid).findByRole("button", { name: /^(Expand|Collapse) Desk$/ })).toBeInTheDocument();
    expect(within(grid).getByRole("link", { name: "Desk" })).toBeInTheDocument();
    mounted.rerender({ state: { ...EMPTY_SEARCH, tab: "diagrams" } });
    expect(
      within(screen.getByRole("tabpanel")).getAllByText(/^(Shop|Desk)$/, { selector: ".archer-project-view-project" }),
    ).toHaveLength(3);
  });
});

describe("while the page's own listings are still answering (PF-6)", () => {
  // The catalog lists each note as its source file too: shown before the notes listing, those rows (`.archer/notes/…`)
  // stood for a moment where the note rows then came, and the tree under them moved.
  const documents = [
    {
      kind: "markdown",
      source: { path: ".archer/notes/operations.md" },
      title: "Operations",
      legacy: { notePath: "notes/operations.md" },
    },
    { kind: "mermaid", source: { path: "flows/checkout.mmd" }, title: "Checkout", legacy: { viewId: "checkout" } },
  ];
  const rowNames = (): string[] => screen.queryAllByRole("row").map((row) => row.textContent ?? "");

  it("shows no file rows until they have, then the note rows and never the notes' source files", async () => {
    const mounted = page({ entry: { documents }, notes: [], filesSettling: true });
    await screen.findByRole("tablist", { name: "Project content" });
    await waitFor(() => expect(mounted.fetchImpl).toHaveBeenCalledWith("api/browser-projects", expect.anything()));
    expect(rowNames().some((name) => /operations\.md|checkout\.mmd/.test(name))).toBe(false);
    mounted.rerender({ notes, filesSettling: false });
    await waitFor(() => expect(rowNames().some((name) => name.includes("operations.md"))).toBe(true));
    expect(screen.queryByText(".archer")).toBeNull();
  });
});
