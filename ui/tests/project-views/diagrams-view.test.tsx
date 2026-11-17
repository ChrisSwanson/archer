// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiagramsView } from "../../src/app/project-views/DiagramsView";
import { NOW, row, rows } from "./fixtures";

afterEach(cleanup);

const cards = (): HTMLElement[] => screen.queryAllByRole("article");
const names = (): string[] =>
  cards().map((card) => card.getAttribute("aria-label") ?? within(card).getByRole("heading").textContent ?? "");

it("shows only diagrams, one card each, with no folder grouping", () => {
  render(<DiagramsView rows={rows} now={NOW} onOpen={vi.fn()} />);
  expect(names().sort()).toEqual(["Agent write to live update", "Archer in its environment", "Comment round trip"]);
  expect(screen.queryByText("Page shell")).not.toBeInTheDocument();
  // No folder headings: each heading is a card's title, one level under the page's h1.
  expect(screen.queryAllByRole("heading").map((heading) => heading.closest("article"))).toEqual(cards());
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(3);
  expect(screen.getByRole("list", { name: "Diagrams" }).children).toHaveLength(3);
});

it("offers All and each kind present, with counts, and filters to the pressed kind", () => {
  render(<DiagramsView rows={rows} now={NOW} onOpen={vi.fn()} />);
  const group = screen.getByRole("group", { name: "Diagram type" });
  const chips = within(group).getAllByRole("button");
  expect(chips.map((chip) => chip.textContent)).toEqual(["All3", "C41", "Sequence2"]);
  expect(within(group).getByRole("button", { name: "All, 3 diagrams" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(group).getByRole("button", { name: "Sequence, 2 diagrams" }));
  expect(within(group).getByRole("button", { name: "Sequence, 2 diagrams" })).toHaveAttribute("aria-pressed", "true");
  expect(within(group).getByRole("button", { name: "All, 3 diagrams" })).toHaveAttribute("aria-pressed", "false");
  expect(names().sort()).toEqual(["Agent write to live update", "Comment round trip"]);
  fireEvent.click(within(group).getByRole("button", { name: "All, 3 diagrams" }));
  expect(cards()).toHaveLength(3);
});

it("keeps a pressed kind that the search has emptied, and offers to show every type", () => {
  const { rerender } = render(<DiagramsView rows={rows} now={NOW} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "C4, 1 diagram" }));
  rerender(<DiagramsView rows={rows.filter((r) => r.type !== "c4")} now={NOW} onOpen={vi.fn()} />);
  expect(screen.getByRole("button", { name: "C4, 0 diagrams" })).toHaveAttribute("aria-pressed", "true");
  expect(cards()).toHaveLength(0);
  expect(screen.getByText("No diagrams match")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show every type" }));
  expect(cards()).toHaveLength(2);
});

it("each card has a 16:9 preview, a clamped title, an italic description line and one metadata row", () => {
  render(<DiagramsView rows={rows} now={NOW} onOpen={vi.fn()} renderPreview={(r) => <span>preview of {r.id}</span>} />);
  const card = screen.getByRole("article", { name: "Comment round trip" });
  expect(card.querySelector(".archer-diagram-card-preview")).toHaveTextContent("preview of round-trip");
  expect(card.querySelector(".archer-diagram-card-title")).toHaveTextContent("Comment round trip");
  expect(card.querySelector(".archer-diagram-card-description")).toHaveTextContent(
    "A reader comment travelling to the agent",
  );
  const meta = card.querySelector(".archer-diagram-card-meta")!;
  expect(meta.querySelector(".archer-project-view-kind")).toHaveTextContent("Sequence");
  expect(meta.querySelector(".archer-project-view-folder")).toHaveTextContent("diagrams/flows");
  const threads = meta.querySelector(".archer-project-view-threads")!;
  expect(threads).toHaveTextContent("2 · 1 open");
  expect(threads).toHaveAttribute("data-open", "true");
  expect(meta.querySelector("time")).toHaveAttribute("dateTime", "2026-10-15T10:00:00Z");
});

it("reserves the description line when there is none, and draws a placeholder without a preview", () => {
  render(<DiagramsView rows={rows} now={NOW} onOpen={vi.fn()} />);
  const card = screen.getByRole("article", { name: "Agent write to live update" });
  const description = card.querySelector(".archer-diagram-card-description")!;
  expect(description).toHaveAttribute("data-empty", "true");
  expect(description).toHaveTextContent("");
  expect(card.querySelector(".archer-diagram-card-preview .archer-diagram-card-placeholder")).not.toBeNull();
  expect(card.querySelector(".archer-project-view-threads")).toBeNull();
});

it("the whole card opens the diagram, through one named button and a click anywhere on it", () => {
  const onOpen = vi.fn();
  render(<DiagramsView rows={rows} now={NOW} onOpen={onOpen} renderPreview={() => <span>thumb</span>} />);
  const card = screen.getByRole("article", { name: "Archer in its environment" });
  const links = within(card).getAllByRole("button");
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAccessibleName("Archer in its environment");
  fireEvent.click(links[0]!);
  expect(onOpen).toHaveBeenLastCalledWith(row("Archer in its environment"));
  fireEvent.click(within(card).getByText("thumb"));
  expect(onOpen).toHaveBeenCalledTimes(2);
});

it("shows the project on each card in the overview", () => {
  render(<DiagramsView rows={rows} now={NOW} onOpen={vi.fn()} showProject />);
  const card = screen.getByRole("article", { name: "Comment round trip" });
  expect(card.querySelector(".archer-project-view-project")).toHaveTextContent("Archer");
});

it("says the empty message when no diagram is given", () => {
  render(
    <DiagramsView
      rows={rows.filter((r) => r.kind === "note")}
      now={NOW}
      onOpen={vi.fn()}
      emptyMessage="No diagrams in this project yet"
    />,
  );
  expect(screen.getByText("No diagrams in this project yet")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show every type" })).not.toBeInTheDocument();
});

it("tells the previews of the first screen of cards they come first, and the rest that they do not", async () => {
  const { firstScreenCards } = await import("../../src/app/project-views/first-screen");
  // Measured: 3 columns, grid top at 200 px, 230 px cards with 16 px gaps in a 720 px window: rows 1-3 show.
  expect(firstScreenCards({ columns: 3, gridTop: 200, cardHeight: 230, viewportHeight: 720 })).toBe(9);
  // A grid below the fold has no first screen; a window too small still counts the row it starts.
  expect(firstScreenCards({ columns: 4, gridTop: 900, cardHeight: 230, viewportHeight: 720 })).toBe(0);
  expect(firstScreenCards({ columns: 2, gridTop: 0, cardHeight: 230, viewportHeight: 100 })).toBe(2);
  // Unmeasured (no layout yet): estimated from the window with the grid's 250 px tracks, never 0.
  expect(firstScreenCards({ viewportWidth: 1280, viewportHeight: 720 })).toBeGreaterThanOrEqual(6);
  expect(firstScreenCards({ viewportWidth: 360, viewportHeight: 640 })).toBeGreaterThanOrEqual(1);

  const seen: [string, boolean][] = [];
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...row("Comment round trip"),
    id: `v${i}`,
    title: `Card ${String(i).padStart(2, "0")}`,
    key: `k${i}`,
  }));
  render(
    <DiagramsView
      rows={many}
      now={NOW}
      onOpen={vi.fn()}
      renderPreview={(r, options) => {
        seen.push([r.id, options?.firstScreen === true]);
        return <span />;
      }}
    />,
  );
  const last = new Map(seen);
  const first = [...last].filter(([, high]) => high).map(([id]) => id);
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(30);
  // The first screen is the gallery's first cards, in its order.
  expect(first).toEqual(many.slice(0, first.length).map((r) => r.id));
});
