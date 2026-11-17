// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DateCell, FileTable } from "../src/app/FileTable";
import { fileRows } from "../src/app/file-index";
import { shortDate } from "../src/app/file-facts";
afterEach(cleanup);
const iso = new Date(2026, 9, 11, 14, 35).toISOString();
const row = fileRows({
  slug: "p",
  name: "P",
  current: true,
  notes: [],
  views: [
    {
      id: "flow",
      title: "Flow",
      kind: "freeform",
      registration: "durable",
      description: "A request reaches the gateway.",
      descriptionFrom: "comment",
      threads: { draft: 0, sent: 1, read: 0, answered: 0, resolved: 0 },
    },
  ],
})[0]!;

it("reserves a title marker column and marks only rows with unresolved discussion", () => {
  const unresolved = { ...row, key: "open", unresolvedThreads: 2, totalThreads: 4 };
  const resolvedOnly = {
    ...row,
    key: "resolved",
    id: "resolved",
    title: "Resolved",
    unresolvedThreads: 0,
    totalThreads: 4,
  };
  const unknown = { ...row, key: "unknown", id: "unknown", title: "Unknown" };
  const { container } = render(
    <FileTable
      label="Files"
      columns={["name"]}
      groups={[{ id: "files", heading: null, rows: [unresolved, resolvedOnly, unknown] }]}
      now={Date.now()}
      onOpen={vi.fn()}
    />,
  );
  const markers = container.querySelectorAll(".archer-files-activity-indicator");
  expect(markers).toHaveLength(3);
  expect(markers[0]).toHaveAttribute("data-active", "true");
  expect(markers[0]).toHaveAttribute("role", "img");
  expect(markers[0]).toHaveAccessibleName("2 unresolved discussion threads");
  expect(markers[1]).not.toHaveAttribute("data-active");
  expect(markers[1]).toHaveAttribute("aria-hidden", "true");
  expect(markers[2]).not.toHaveAttribute("data-active");
  expect(markers[2]).toHaveAttribute("aria-hidden", "true");
});

it("keeps the existing combined name details when no picker overrides them", () => {
  const { container } = render(
    <FileTable
      label="Files"
      columns={["name"]}
      groups={[{ id: "files", heading: null, rows: [row] }]}
      now={Date.now()}
      onOpen={vi.fn()}
    />,
  );
  expect(container.querySelector('[data-column="name"][role="cell"]')).toHaveTextContent(row.description!);
  expect(container.querySelector('[data-column="name"][role="cell"]')).toHaveTextContent("1 open thread");
});

it("DateCell shows the automatic short date", () => {
  const { container } = render(<DateCell iso={iso} now={Date.parse(iso)} label="Edited" />);
  expect(container.querySelector('time [aria-hidden="true"]')).toHaveTextContent(shortDate(iso, Date.parse(iso)));
});

it("default folder rows still open on body clicks with no disclosure", () => {
  const onOpen = vi.fn();
  render(
    <FileTable
      label="Files"
      columns={["name", "type"]}
      groups={[{ id: "files", heading: null, rows: [row] }]}
      now={Date.now()}
      onOpen={onOpen}
    />,
  );
  expect(screen.queryByRole("button", { name: "Details for Flow" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Flow" }).closest("tr")!);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(row);
});
