// @vitest-environment jsdom
// Diagrams embedded in notes are rows of the page's lists (note diagrams ticket, decisions 3 to 6):
// the card's title is the heading or the name, its subtitle the address, "in <note>" links the note,
// one combined count with an "In notes" filter, and the row opens the canonical address.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileRows, type FileRow } from "../src/app/file-index";
import { FolderTree } from "../src/app/FolderTree";
import { DiagramsView } from "../src/app/project-views/DiagramsView";
import { TREE_COLUMNS } from "../src/app/project-tree";
import type { DiagramView } from "../src/app/inventory";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const NOW = Date.parse("2026-10-11T12:00:00Z");
const rev = `sha256:${"b".repeat(64)}`;
const views: DiagramView[] = [
  {
    id: "overview",
    title: "Overview",
    kind: "c4",
    registration: "durable",
    sourcePath: "diagrams/overview.mmd",
    modifiedAt: "2026-10-10T10:00:00Z",
  },
  {
    id: "notes/auth.md#login",
    title: "Auth",
    kind: "sequence",
    registration: "embedded",
    sourcePath: "notes/auth.md",
    note: "notes/auth.md",
    name: "login",
    modelRevision: rev,
    modifiedAt: "2026-10-09T10:00:00Z",
  },
  {
    id: "notes/auth.md#logout",
    title: "Auth",
    kind: "sequence",
    registration: "embedded",
    sourcePath: "notes/auth.md",
    note: "notes/auth.md",
    name: "logout",
    modelRevision: rev,
    modifiedAt: "2026-10-09T10:00:00Z",
  },
];
const rows: FileRow[] = fileRows({
  slug: "demo",
  name: "Demo",
  current: true,
  views,
  notes: [{ path: "notes/auth.md", title: "How auth works", viewIds: [], modifiedAt: "2026-10-08T10:00:00Z" }],
});
const diagrams = rows.filter((row) => row.kind === "diagram");

function gallery(over: Partial<React.ComponentProps<typeof DiagramsView>> = {}) {
  const onOpen = vi.fn();
  render(<DiagramsView rows={diagrams} now={NOW} onOpen={onOpen} {...over} />);
  return { onOpen };
}
const card = (name: string): HTMLElement => screen.getByRole("article", { name });

describe("the Diagrams gallery", () => {
  it("shows an embedded diagram as a card: its title, its address as the subtitle, and its note", () => {
    gallery();
    const login = card("Auth, login");
    expect(within(login).getByRole("button", { name: "Auth, login" })).toBeInTheDocument();
    expect(within(login).getByText("notes/auth.md#login")).toHaveClass("archer-diagram-card-address");
    const note = within(login).getByRole("link", { name: "in How auth works" });
    expect(note).toHaveAttribute("href", "/projects/demo/notes/auth.md");
    expect(card("Auth, logout")).toBeInTheDocument();
    expect(within(card("Overview")).queryByText(/#/)).toBeNull();
    expect(within(card("Overview")).queryByRole("link")).toBeNull();
  });

  it("opens the canonical address from the title, and the note from its link", () => {
    const { onOpen } = gallery();
    fireEvent.click(within(card("Auth, login")).getByRole("button", { name: "Auth, login" }));
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "diagram", id: "notes/auth.md#login", slug: "demo" }),
    );
    fireEvent.click(within(card("Auth, login")).getByRole("link", { name: "in How auth works" }));
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "note", id: "notes/auth.md", slug: "demo", title: "How auth works" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("counts every diagram in All, files and blocks alike, and filters to those in notes", () => {
    gallery();
    expect(screen.getByRole("button", { name: "All, 3 diagrams" })).toHaveAttribute("aria-pressed", "true");
    const inNotes = screen.getByRole("button", { name: "In notes, 2 diagrams" });
    fireEvent.click(inNotes);
    expect(inNotes).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("article", { name: "Overview" })).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "All, 3 diagrams" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("keeps the In notes chip off a project that has no diagram in a note", () => {
    gallery({ rows: diagrams.filter((row) => row.embedded === undefined) });
    expect(screen.queryByRole("button", { name: /^In notes/ })).toBeNull();
  });

  it("asks for each embedded card's thumbnail by its address, like a standalone one", () => {
    const renderPreview = vi.fn((row: FileRow) => <span data-testid="preview">{row.id}</span>);
    gallery({ renderPreview });
    expect(screen.getAllByTestId("preview").map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["notes/auth.md#login", "notes/auth.md#logout"]),
    );
  });
});

describe("the Folders tree and folder pages", () => {
  it("lists an embedded diagram under its note's folder, named by its address, and opens it from its title", () => {
    const onOpen = vi.fn();
    render(
      <FolderTree
        rows={rows}
        sort={{ key: "folder", dir: "asc" }}
        onSort={vi.fn()}
        columns={TREE_COLUMNS}
        filtering={false}
        now={NOW}
        onOpen={onOpen}
      />,
    );
    const grid = screen.getByRole("treegrid", { name: "Project files" });
    expect(within(grid).getByRole("link", { name: "notes/" })).toBeInTheDocument();
    const names = [...grid.querySelectorAll(".archer-folder-tree-file-name")].map((node) => node.textContent);
    expect(names).toEqual(expect.arrayContaining(["auth.md", "auth.md#login", "auth.md#logout"]));
    const row = grid.querySelector<HTMLElement>('[data-target="view:notes/auth.md#login"]')!;
    expect(row).toHaveAttribute("data-kind", "diagram");
    fireEvent.click(within(row).getByRole("button", { name: "Auth, login" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "notes/auth.md#login" }));
  });
});
