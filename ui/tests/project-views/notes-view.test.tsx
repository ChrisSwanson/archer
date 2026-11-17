// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotesView } from "../../src/app/project-views/NotesView";
import { NOW, row, rows } from "./fixtures";

afterEach(cleanup);

const titles = (): string[] =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.querySelector(".archer-notes-title")!.textContent!);
const header = (name: string): HTMLElement => screen.getByRole("columnheader", { name: new RegExp(`^${name}`) });
const sortBy = (name: string): void => {
  fireEvent.click(within(header(name)).getByRole("button"));
};

it("lists only notes, newest edit first by default, with aria-sort on Edited", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} />);
  expect(titles()).toEqual(["accuracy review", "Page shell", "Glossary"]);
  expect(header("Edited")).toHaveAttribute("aria-sort", "descending");
  expect(header("Note")).toHaveAttribute("aria-sort", "none");
  expect(screen.queryByText("Comment round trip")).not.toBeInTheDocument();
});

it("shows title with description beneath, folder, author, threads, edited and created", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} />);
  const shell = screen.getByRole("row", { name: /Page shell/ });
  const cells = within(shell).getAllByRole("cell");
  expect(cells[0]).toHaveTextContent("Page shell");
  expect(cells[0]!.querySelector(".archer-notes-description")).toHaveTextContent("Why every page shares one shell.");
  expect(cells[1]).toHaveTextContent("notes/decisions");
  expect(cells[1]!.querySelector(".archer-project-view-folder")).not.toBeNull();
  expect(cells[2]).toHaveTextContent("Agent");
  expect(cells[2]!.querySelector("[data-author='agent']")).not.toBeNull();
  expect(cells[3]).toHaveTextContent("3 · 2 open");
  expect(cells[4]!.querySelector("time")).toHaveAttribute("dateTime", "2026-10-14T10:00:00Z");
  expect(cells[5]!.querySelector("time")).toHaveAttribute("dateTime", "2026-10-01T09:00:00Z");
  const glossary = within(screen.getByRole("row", { name: /Glossary/ })).getAllByRole("cell");
  expect(glossary[1]).toHaveTextContent("Top level");
  expect(glossary[2]!.querySelector("[data-author='person']")).toHaveTextContent("Person");
  const accuracy = within(screen.getByRole("row", { name: /accuracy review/ })).getAllByRole("cell");
  expect(accuracy[2]).toHaveTextContent("Author not recorded");
});

it("sorts text A to Z first, then reverses on a second click", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} />);
  sortBy("Note");
  expect(titles()).toEqual(["accuracy review", "Glossary", "Page shell"]);
  expect(header("Note")).toHaveAttribute("aria-sort", "ascending");
  expect(header("Edited")).toHaveAttribute("aria-sort", "none");
  sortBy("Note");
  expect(titles()).toEqual(["Page shell", "Glossary", "accuracy review"]);
  expect(header("Note")).toHaveAttribute("aria-sort", "descending");
  sortBy("Folder");
  expect(titles()).toEqual(["Glossary", "accuracy review", "Page shell"]);
});

it("sorts threads by count, most first, and dates newest first", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} />);
  sortBy("Threads");
  expect(titles()[0]).toBe("Page shell");
  expect(header("Threads")).toHaveAttribute("aria-sort", "descending");
  sortBy("Threads");
  expect(titles()[2]).toBe("Page shell");
  sortBy("Created");
  expect(titles()).toEqual(["Glossary", "Page shell", "accuracy review"]);
  expect(header("Created")).toHaveAttribute("aria-sort", "descending");
  sortBy("Created");
  expect(titles()).toEqual(["accuracy review", "Page shell", "Glossary"]);
});

it("sorts by author, an unrecorded author last", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} />);
  sortBy("Author");
  expect(titles()).toEqual(["Page shell", "Glossary", "accuracy review"]);
});

it("marks only the active column with an arrow", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} />);
  expect(header("Edited").querySelector(".archer-notes-sort-arrow")).toHaveTextContent("↓");
  expect(header("Note").querySelector(".archer-notes-sort-arrow")).toBeNull();
});

it("uses a controlled sort and reports clicks instead of sorting itself", () => {
  const onSort = vi.fn();
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} sort={{ key: "name", dir: "desc" }} onSort={onSort} />);
  expect(titles()).toEqual(["Page shell", "Glossary", "accuracy review"]);
  expect(header("Note")).toHaveAttribute("aria-sort", "descending");
  sortBy("Threads");
  expect(onSort).toHaveBeenCalledWith("total");
  expect(header("Note")).toHaveAttribute("aria-sort", "descending");
  sortBy("Author");
  expect(onSort).toHaveBeenLastCalledWith("author");
});

it("opens a note from its title", () => {
  const onOpen = vi.fn();
  render(<NotesView rows={rows} now={NOW} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Glossary" }));
  expect(onOpen).toHaveBeenCalledWith(row("Glossary"));
});

it("adds a sortable Project column in the overview", () => {
  render(<NotesView rows={rows} now={NOW} onOpen={vi.fn()} showProject />);
  expect(header("Project")).toHaveAttribute("aria-sort", "none");
  expect(within(screen.getByRole("row", { name: /Glossary/ })).getAllByRole("cell")[1]).toHaveTextContent("Archer");
});

it("says the empty message when no note is given", () => {
  render(
    <NotesView
      rows={rows.filter((r) => r.kind === "diagram")}
      now={NOW}
      onOpen={vi.fn()}
      emptyMessage="No notes match"
    />,
  );
  expect(screen.getByText("No notes match")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
