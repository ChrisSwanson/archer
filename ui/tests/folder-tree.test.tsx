// @vitest-environment jsdom
// The Folders tab: folders open and close by real disclosure buttons, the
// choice is remembered per project, headers sort files within each folder,
// and a search or filter opens every folder with a match.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderTree } from "../src/app/FolderTree";
import { fileRows, type FileRow, type Sort } from "../src/app/file-index";
import { longDate, shortDate } from "../src/app/file-facts";
import {
  buildFolderTree,
  FOLDER_TREE_KEY,
  readFolderChoices,
  readTreeColumns,
  TREE_COLUMNS,
  TREE_COLUMNS_KEY,
  withFolderChoice,
} from "../src/app/project-tree";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const NOW = Date.parse("2026-10-11T12:00:00Z");
const view = (id: string, sourcePath: string, title: string, modifiedAt: string, kind = "flowchart") => ({
  id,
  title,
  kind,
  registration: "durable" as const,
  sourcePath,
  modifiedAt,
});
const rows: FileRow[] = fileRows({
  slug: "demo",
  name: "Demo",
  current: true,
  views: [
    view("ctx", "diagrams/overview/context.mmd", "System context", "2026-10-10T10:00:00Z", "c4"),
    view("api", "diagrams/flows/api.mmd", "API flow", "2026-10-01T10:00:00Z", "sequence"),
    view("boot", "diagrams/flows/boot.mmd", "Boot", "2026-10-09T10:00:00Z", "sequence"),
  ],
  notes: [
    { path: "notes/start.md", title: "Start here", viewIds: [], modifiedAt: "2026-10-08T10:00:00Z" },
    { path: "README.md", title: "Readme", viewIds: [], modifiedAt: "2026-10-07T10:00:00Z" },
  ],
});
const byName: Sort = { key: "folder", dir: "asc" };

function tree(over: Partial<ComponentProps<typeof FolderTree>> = {}) {
  const onSort = vi.fn(),
    onOpen = vi.fn();
  const props: ComponentProps<typeof FolderTree> = {
    rows,
    sort: byName,
    onSort,
    columns: TREE_COLUMNS,
    filtering: false,
    now: NOW,
    onOpen,
    ...over,
  };
  const mounted = render(<FolderTree {...props} />);
  return {
    ...props,
    ...mounted,
    rerender: (next: Partial<ComponentProps<typeof FolderTree>>) =>
      mounted.rerender(<FolderTree {...props} {...next} />),
  };
}
const grid = (): HTMLElement => screen.getByRole("treegrid", { name: "Project files" });
const fileNames = (): string[] =>
  [...grid().querySelectorAll(".archer-folder-tree-file-name")].map((node) => node.textContent ?? "");
/** A folder's arrow: it only opens and closes. */
const folder = (name: string): HTMLElement =>
  within(grid()).getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${name}$`) });
/** A folder's name: a real link to its page. */
const nameLink = (name: string): HTMLElement => within(grid()).getByRole("link", { name: `${name}/` });

describe("the folder tree model", () => {
  it("puts a folder's files before its subfolders, folders alphabetical, files by the sort", () => {
    const nodes = buildFolderTree(rows, { sort: { key: "edited", dir: "desc" } });
    expect(nodes.map((node) => (node.kind === "file" ? node.row.path : `${node.path}/`))).toEqual([
      "README.md",
      "diagrams/",
      "notes/",
    ]);
    const diagrams = nodes[1]!;
    if (diagrams.kind !== "folder") throw new Error("not a folder");
    expect(diagrams.files).toBe(3);
    const flows = diagrams.children.find((node) => node.kind === "folder" && node.name === "flows");
    if (flows?.kind !== "folder") throw new Error("no flows");
    expect(flows.children.map((node) => (node.kind === "file" ? node.row.title : ""))).toEqual(["Boot", "API flow"]);
  });

  it("roots the tree at the page's folder, and across projects at each project", () => {
    expect(
      buildFolderTree(rows, { under: "diagrams", sort: byName }).map((node) =>
        node.kind === "folder" ? node.name : "",
      ),
    ).toEqual(["flows", "overview"]);
    const across = buildFolderTree(rows, {
      sort: byName,
      projects: [
        { slug: "demo", name: "Demo" },
        { slug: "empty", name: "Empty" },
      ],
    });
    expect(
      across.map((node) => (node.kind === "folder" && node.projectRoot ? `${node.name}:${node.files}` : "")),
    ).toEqual(["Demo:5", "Empty:0"]);
  });

  it("keeps the remembered folders bounded and valid, and column order complete", () => {
    let choices = {};
    for (let i = 0; i < 600; i++) choices = withFolderChoice(choices, "demo", `f${i}`, true);
    expect(Object.keys((choices as Record<string, object>).demo!)).toHaveLength(512);
    window.localStorage.setItem(FOLDER_TREE_KEY, JSON.stringify({ demo: { a: true, b: "yes" }, bad: [] }));
    expect(readFolderChoices()).toEqual({ demo: { a: true } });
    window.localStorage.setItem(TREE_COLUMNS_KEY, JSON.stringify(["edited", "nope", "title"]));
    expect(readTreeColumns()).toEqual(["edited", "title", "kind", "threads", "created"]);
  });
});

describe("the Folders tab", () => {
  it("opens every folder by default, with real disclosure buttons", () => {
    tree();
    expect(folder("diagrams")).toHaveAttribute("aria-expanded", "true");
    expect(folder("flows")).toHaveAttribute("aria-expanded", "true");
    expect(fileNames()).toEqual(["README.md", "api.mmd", "boot.mmd", "context.mmd", "start.md"]);
    expect(grid().querySelector('[data-folder="diagrams/flows"]')).toHaveAttribute("aria-level", "2");
  });

  it("toggles a folder, rotates its arrow, and remembers it per project across a remount", () => {
    const mounted = tree();
    fireEvent.click(folder("flows"));
    expect(folder("flows")).toHaveAttribute("aria-expanded", "false");
    expect(folder("flows").querySelector(".archer-folder-tree-chevron")).toHaveAttribute("data-open", "false");
    expect(folder("flows")).toHaveAccessibleName("Expand flows");
    expect(fileNames()).toEqual(["README.md", "context.mmd", "start.md"]);
    fireEvent.click(folder("notes"));
    expect(fileNames()).toEqual(["README.md", "context.mmd"]);
    expect(JSON.parse(window.localStorage.getItem(FOLDER_TREE_KEY)!)).toEqual({
      demo: { notes: false, "diagrams/flows": false },
    });
    mounted.unmount();
    tree();
    expect(folder("flows")).toHaveAttribute("aria-expanded", "false");
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(folder("notes"));
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
    expect(folder("notes").querySelector(".archer-folder-tree-chevron")).toHaveAttribute("data-open", "true");
  });

  it("opens every folder with a match while filtering, without changing the remembered choice", () => {
    window.localStorage.setItem(FOLDER_TREE_KEY, JSON.stringify({ demo: { notes: false } }));
    tree({ filtering: true });
    expect(fileNames()).toEqual(["README.md", "api.mmd", "boot.mmd", "context.mmd", "start.md"]);
    fireEvent.click(folder("diagrams"));
    expect(fileNames()).toEqual(["README.md", "start.md"]);
    expect(JSON.parse(window.localStorage.getItem(FOLDER_TREE_KEY)!)).toEqual({ demo: { notes: false } });
  });

  it("sorts from its headers, marking the active one", () => {
    const mounted = tree({ filtering: true });
    const header = (name: string): HTMLElement =>
      within(grid())
        .getAllByRole("columnheader")
        .find((cell) => cell.textContent?.startsWith(name))!;
    expect(header("Name")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(header("Edited")).getByRole("button", { name: "Edited" }));
    expect(mounted.onSort).toHaveBeenLastCalledWith("edited");
    fireEvent.click(within(header("Title")).getByRole("button", { name: "Title" }));
    expect(mounted.onSort).toHaveBeenLastCalledWith("name");
    mounted.rerender({ sort: { key: "edited", dir: "desc" } });
    expect(header("Edited")).toHaveAttribute("aria-sort", "descending");
    expect(fileNames()).toEqual(["README.md", "boot.mmd", "api.mmd", "context.mmd", "start.md"]);
  });

  it("shows the file name, aligned title, kind and dates, and the title or the row opens it", () => {
    const mounted = tree({ filtering: true });
    const row = grid().querySelector<HTMLElement>('[data-target="view:ctx"]')!;
    expect(within(row).getByText("context.mmd")).toBeInTheDocument();
    expect(within(row).getByText("C4")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "System context" }));
    expect(mounted.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "ctx" }));
    fireEvent.click(within(row).getByText("C4"));
    expect(mounted.onOpen).toHaveBeenCalledTimes(2);
  });

  it("moves a column with the arrow keys on its handle, the name staying first", () => {
    const onColumnsReorder = vi.fn();
    tree({ onColumnsReorder });
    expect(screen.queryByRole("button", { name: "Move Name column" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Kind column" }), { key: "ArrowLeft" });
    expect(onColumnsReorder).toHaveBeenLastCalledWith(["kind", "title", "threads", "edited", "created"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Title column" }), { key: "ArrowLeft" });
    expect(onColumnsReorder).toHaveBeenCalledTimes(1);
  });
});

describe("the tree's folder names and keyboard", () => {
  const primaries = (): HTMLElement[] => [...grid().querySelectorAll<HTMLElement>("[data-tree-primary]")];
  const rowOf = (el: HTMLElement): HTMLElement => el.closest<HTMLElement>('[role="row"]')!;

  it("makes a folder's name a real link to its page, apart from its arrow and its count", () => {
    const onOpenFolder = vi.fn();
    tree({ onOpenFolder });
    const link = nameLink("flows");
    expect(link).toHaveAttribute("href", "/projects/demo/diagrams/flows/");
    expect(link.contains(folder("flows"))).toBe(false);
    expect(link.textContent).toBe("flows/");
    expect(rowOf(link).querySelector(".archer-folder-tree-count")).toHaveAttribute("aria-label", "2 files");
    expect(link.closest(".archer-folder-tree-count")).toBeNull();
    fireEvent.click(folder("flows"));
    expect(onOpenFolder).not.toHaveBeenCalled();
    expect(folder("flows")).toHaveAttribute("aria-expanded", "false");
    expect(fireEvent.click(link)).toBe(false);
    expect(onOpenFolder).toHaveBeenCalledWith("demo", "diagrams/flows");
    expect(folder("flows")).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves a modified click to the browser", () => {
    const onOpenFolder = vi.fn();
    tree({ onOpenFolder });
    // The browser would follow the link; jsdom cannot, so the document stands in for it.
    const followed: boolean[] = [];
    const watch = (event: Event): void => {
      followed.push(!event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener("click", watch);
    fireEvent.click(nameLink("flows"), { ctrlKey: true });
    fireEvent.click(nameLink("flows"), { metaKey: true });
    fireEvent.click(nameLink("flows"), { button: 1 });
    document.removeEventListener("click", watch);
    expect(followed).toEqual([true, true, true]);
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("names a project root by a link and drops the Open button", () => {
    const onOpenProject = vi.fn();
    tree({
      projects: [{ slug: "demo", name: "Demo" }],
      onOpenProject,
      collapsedProjects: new Set(),
      onToggleProject: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: "Open Demo" })).toBeNull();
    const link = within(grid()).getByRole("link", { name: "Demo" });
    expect(link).toHaveAttribute("href", "/projects/demo/");
    fireEvent.click(link);
    expect(onOpenProject).toHaveBeenCalledWith("demo");
  });

  it("marks the folder the page is at", () => {
    tree({ currentFolder: { slug: "demo", path: "notes" } });
    expect(nameLink("notes")).toHaveAttribute("aria-current", "page");
    expect(nameLink("flows")).not.toHaveAttribute("aria-current");
  });

  it("marks a project's own root as the page when the page is at it, and a click there goes nowhere", () => {
    const onOpenProject = vi.fn();
    tree({
      projects: [{ slug: "demo", name: "Demo" }],
      onOpenProject,
      collapsedProjects: new Set(),
      onToggleProject: vi.fn(),
      currentFolder: { slug: "demo", path: "" },
    });
    const link = within(grid()).getByRole("link", { name: "Demo" });
    expect(link).toHaveAttribute("aria-current", "page");
    fireEvent.click(link);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("is one tab stop that roves with focus", () => {
    tree();
    const stops = primaries().filter((el) => el.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(primaries()[0]);
    act(() => primaries()[2]!.focus());
    expect(primaries().filter((el) => el.tabIndex === 0)).toEqual([primaries()[2]]);
  });

  it("moves between rows with the arrow keys, Home and End", () => {
    tree();
    const order = (): string[] => primaries().map((el) => el.textContent ?? "");
    const first = primaries()[0]!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(primaries()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(primaries().at(-1));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(primaries().at(-2));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(primaries()[0]);
    expect(order()).toHaveLength(9);
  });

  it("expands a closed folder with ArrowRight and enters an open one", () => {
    tree();
    fireEvent.click(folder("flows"));
    const link = nameLink("flows");
    act(() => link.focus());
    fireEvent.keyDown(link, { key: "ArrowRight" });
    expect(folder("flows")).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(link);
    fireEvent.keyDown(link, { key: "ArrowRight" });
    expect(rowOf(document.activeElement as HTMLElement)).toHaveAttribute("aria-level", "3");
    expect(document.activeElement?.textContent).toBe("API flow");
  });

  it("collapses an open folder with ArrowLeft, then goes to the parent from a closed folder or a file", () => {
    tree();
    const link = nameLink("flows");
    act(() => link.focus());
    fireEvent.keyDown(link, { key: "ArrowLeft" });
    expect(folder("flows")).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(link);
    fireEvent.keyDown(link, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(nameLink("diagrams"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(folder("diagrams")).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(nameLink("diagrams"));
    const file = within(grid()).getByRole("button", { name: "Start here" });
    act(() => file.focus());
    fireEvent.keyDown(file, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(nameLink("notes"));
  });

  it("Space toggles a folder without scrolling and does nothing on a file; Enter opens a file", () => {
    const onOpen = vi.fn();
    tree({ onOpen });
    const link = nameLink("flows");
    act(() => link.focus());
    expect(fireEvent.keyDown(link, { key: " " })).toBe(false);
    expect(folder("flows")).toHaveAttribute("aria-expanded", "false");
    const file = within(grid()).getByRole("button", { name: "System context" });
    act(() => file.focus());
    expect(fireEvent.keyDown(file, { key: " " })).toBe(false);
    expect(fireEvent.keyUp(file, { key: " " })).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("one folder namespace for the tree, the route and the folder filter", () => {
  // An Archer-folder file is addressed relative to the Archer folder, a configured document relative to the
  // project. Both name their folder in the same spelling, so `notes/` is one tree folder, one route
  // (`/projects/demo/notes/`) and one `under` filter, whichever file lives in which directory.
  const document = (path: string, title: string) => ({
    source: { path },
    kind: "markdown" as const,
    title,
    capabilities: { read: true as const, sourceWrite: false as const, comments: false, emphasis: false },
  });
  const mixed = fileRows({
    slug: "demo",
    name: "Demo",
    current: true,
    views: [],
    notes: [{ path: "notes/start.md", title: "Start here", viewIds: [] }],
    documents: [
      { ...document(".archer/notes/start.md", "Start here"), legacy: { notePath: "notes/start.md" } },
      document("notes/extra.md", "Extra"),
      document("docs/guide.md", "Guide"),
    ],
  });

  it("merges the Archer folder's notes/ and the project's notes/ into one folder, and docs/ stands alone", () => {
    const nodes = buildFolderTree(mixed, { sort: byName });
    const names = nodes.filter((node) => node.kind === "folder").map((node) => `${node.path}:${node.files}`);
    expect(names).toEqual(["docs:1", "notes:2"]);
    expect(mixed.map((row) => row.folder).sort()).toEqual(["docs", "notes", "notes"]);
  });

  it("links each folder to the route whose folder filter lists exactly its rows", () => {
    tree({ rows: mixed });
    expect(nameLink("notes")).toHaveAttribute("href", "/projects/demo/notes/");
    expect(nameLink("docs")).toHaveAttribute("href", "/projects/demo/docs/");
    expect(
      buildFolderTree(mixed, { under: "notes", sort: byName }).map((node) =>
        node.kind === "file" ? node.row.title : "",
      ),
    ).toEqual(["Extra", "Start here"]);
  });
});

describe("the treegrid keyboard model covers every focusable descendant (finding 14)", () => {
  const matches = new Map(
    rows
      .filter((row) => row.title === "Boot" || row.title === "API flow")
      .map((row) => [
        row.key,
        {
          matches: [
            { field: "node" as const, text: "Lexer", elementId: "lexer" },
            { field: "comment" as const, text: "why", threadId: "t-1" },
          ],
          more: 0,
        },
      ]),
  );
  const focusable = (): HTMLElement[] =>
    [...grid().querySelectorAll<HTMLElement>("a[href], button, [tabindex]")].filter(
      (el) => !el.closest(".archer-folder-tree-head"),
    );

  it("one tab stop: nothing else in the rows, search matches included, is in the tab order", () => {
    tree({ matches, onOpenMatch: vi.fn(), filtering: true });
    expect(within(grid()).getAllByRole("button", { name: /Lexer/ }).length).toBeGreaterThan(0);
    expect(focusable().filter((el) => el.tabIndex >= 0)).toHaveLength(1);
  });

  it("from a match: the arrows move between rows and back to the row's title; from a title, Right reaches its matches", () => {
    const onOpenMatch = vi.fn();
    tree({ matches, onOpenMatch, filtering: true });
    const boot = within(grid()).getByRole("button", { name: "Boot" });
    boot.focus();
    fireEvent.keyDown(boot, { key: "ArrowRight" });
    const first = document.activeElement as HTMLElement;
    expect(first).toHaveTextContent("Lexer");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toHaveTextContent("why");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(boot);
    fireEvent.keyDown(boot, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.hasAttribute("data-tree-primary")).toBe(true);
    expect(document.activeElement).not.toBe(boot);
    // Every focusable descendant answers the row keys.
    for (const el of focusable()) {
      if (el.classList.contains("archer-folder-tree-disclose")) continue;
      el.focus();
      const down = fireEvent.keyDown(el, { key: "End" });
      expect(down, el.textContent ?? "").toBe(false);
    }
  });

  it("a folder's row says whether it is open", () => {
    tree();
    const row = nameLink("diagrams").closest('[role="row"]')!;
    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(folder("diagrams"));
    expect(nameLink("diagrams").closest('[role="row"]')).toHaveAttribute("aria-expanded", "false");
  });
});

describe("light rows: few elements, the same names (perf pass 1)", () => {
  const elements = (row: Element): number => row.querySelectorAll("*").length + 1;
  const base = rows.find((row) => row.title === "Boot")!;
  const rich: FileRow = {
    ...base,
    createdAt: "2026-09-01T08:00:00Z",
    createdFrom: "git",
    totalThreads: 3,
    unresolvedThreads: 1,
    openThreads: 1,
  };
  const quiet: FileRow = {
    ...rows.find((row) => row.title === "API flow")!,
    createdAt: undefined,
    totalThreads: 0,
    unresolvedThreads: 0,
    openThreads: 0,
  };
  const cellOf = (row: Element, column: string): HTMLElement =>
    row.querySelector<HTMLElement>(`[role="gridcell"][data-column="${column}"]`)!;
  const fileRow = (title: string): HTMLElement =>
    within(grid()).getByRole("button", { name: title }).closest<HTMLElement>('[role="row"]')!;

  it("keeps a file row to at most 14 elements and a folder row to at most 12", () => {
    tree({ rows: [rich, quiet, ...rows.filter((row) => row !== base && row.title !== "API flow")] });
    expect(elements(fileRow("Boot"))).toBeLessThanOrEqual(14);
    expect(elements(fileRow("API flow"))).toBeLessThanOrEqual(14);
    expect(elements(nameLink("flows").closest('[role="row"]')!)).toBeLessThanOrEqual(12);
  });

  it("names every cell in full: dates with their provenance, threads, and the empty ones", () => {
    tree({ rows: [rich, quiet] });
    const boot = fileRow("Boot");
    expect(cellOf(boot, "edited")).toHaveAccessibleName(`Edited ${longDate(base.modifiedAt!)}`);
    expect(cellOf(boot, "created")).toHaveAccessibleName(
      `Created ${longDate("2026-09-01T08:00:00Z")}, from Git: the commit that first added the file`,
    );
    expect(cellOf(boot, "threads")).toHaveAccessibleName("3 threads, 1 open");
    const api = fileRow("API flow");
    expect(cellOf(api, "threads")).toHaveAccessibleName("No threads");
    expect(cellOf(api, "created")).toHaveAccessibleName(
      "No creation date: the file system keeps none and Git has no commit adding it",
    );
  });

  it("keeps machine-readable times and the visible short date, with Git said in sight", () => {
    tree({ rows: [rich, quiet] });
    const boot = fileRow("Boot");
    const edited = cellOf(boot, "edited");
    const time = edited.matches("time") ? edited : edited.querySelector("time");
    expect(time).toHaveAttribute("datetime", base.modifiedAt);
    expect(edited).toHaveTextContent(shortDate(base.modifiedAt!, NOW));
    expect(cellOf(boot, "created")).toHaveTextContent(/· Git$/);
    expect(cellOf(boot, "created")).toHaveAttribute(
      "title",
      `Created ${longDate("2026-09-01T08:00:00Z")}, from Git: the commit that first added the file`,
    );
  });
});

describe("D3: a large project's folders start closed", () => {
  const many = (count: number): FileRow[] =>
    fileRows({
      slug: "big",
      name: "Big",
      current: true,
      views: [],
      notes: Array.from({ length: count }, (_, i) => ({
        path: `notes/${i % 4 === 0 ? "a" : "b"}/n${i}.md`,
        title: `Note ${i}`,
        viewIds: [],
      })).concat([{ path: "README.md", title: "Readme", viewIds: [] }]),
    });

  it("closes every folder past 200 files, and leaves a smaller project open", () => {
    tree({ rows: many(200) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
    expect(within(grid()).getAllByRole("row")).toHaveLength(3);
    cleanup();
    tree({ rows: many(199) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
  });

  it("lets a stored choice win, remembers an opened folder, and never writes the default", () => {
    window.localStorage.setItem(FOLDER_TREE_KEY, JSON.stringify({ big: { "notes/a": true } }));
    const mounted = tree({ rows: many(300) });
    expect(window.localStorage.getItem(FOLDER_TREE_KEY)).toBe(JSON.stringify({ big: { "notes/a": true } }));
    fireEvent.click(folder("notes"));
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
    expect(folder("a")).toHaveAttribute("aria-expanded", "true");
    expect(folder("b")).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem(FOLDER_TREE_KEY)!)).toEqual({
      big: { notes: true, "notes/a": true },
    });
    mounted.unmount();
    tree({ rows: many(300) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
  });

  it("settles the default once per visit: crossing 200 files while mounted leaves the folders as they were", () => {
    const mounted = tree({ rows: many(199) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
    const title = within(grid()).getByRole("button", { name: "Note 4" });
    act(() => title.focus());
    mounted.rerender({ rows: many(200) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
    expect(folder("a")).toHaveAttribute("aria-expanded", "true");
    // The reader's place survives the poll: the focused file is still on screen and still focused.
    expect(within(grid()).getByRole("button", { name: "Note 4" })).toHaveFocus();
    mounted.unmount();
    // A fresh visit decides afresh.
    tree({ rows: many(200) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a large project's folders closed when it shrinks below the threshold while mounted", () => {
    const mounted = tree({ rows: many(300) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
    mounted.rerender({ rows: many(100) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
  });

  it("decides afresh for a folder page the tree is rooted at", () => {
    const split = fileRows({
      slug: "big",
      name: "Big",
      current: true,
      views: [],
      notes: Array.from({ length: 300 }, (_, i) => ({
        path: i < 150 ? `notes/a/x/n${i}.md` : `notes/b/n${i}.md`,
        title: `Note ${i}`,
        viewIds: [],
      })),
    });
    const mounted = tree({ rows: split });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
    // notes/a holds 150 of the 300: its own page opens its folders, as a visit there always has.
    mounted.rerender({ rows: split, under: "notes/a" });
    expect(folder("x")).toHaveAttribute("aria-expanded", "true");
  });

  it("decides afresh for a project that left the tree and came back under the same slug", () => {
    const mounted = tree({ rows: many(300) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
    mounted.rerender({ rows });
    mounted.rerender({ rows: many(100) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
  });

  it("decides afresh when the tree comes back to a root it showed before", () => {
    const split = (count: number): FileRow[] =>
      fileRows({
        slug: "big",
        name: "Big",
        current: true,
        views: [],
        notes: Array.from({ length: count }, (_, i) => ({
          path: i % 2 === 0 ? `notes/a/x/n${i}.md` : `notes/b/n${i}.md`,
          title: `Note ${i}`,
          viewIds: [],
        })),
      });
    const mounted = tree({ rows: split(300) });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
    mounted.rerender({ rows: split(300), under: "notes/a" });
    mounted.rerender({ rows: split(100), under: "" });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the decision while a filter narrows the rows: a filter is not a new scope", () => {
    const mounted = tree({ rows: many(300) });
    mounted.rerender({ rows, filtering: true });
    mounted.rerender({ rows: many(100), filtering: false });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens folders with a match while filtering, and keeps a project root open across projects", () => {
    tree({ rows: many(300), filtering: true });
    expect(folder("notes")).toHaveAttribute("aria-expanded", "true");
    cleanup();
    tree({ rows: many(300), projects: [{ slug: "big", name: "Big" }] });
    expect(folder("Big")).toHaveAttribute("aria-expanded", "true");
    expect(folder("notes")).toHaveAttribute("aria-expanded", "false");
  });
});
