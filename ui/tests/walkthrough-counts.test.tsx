// @vitest-environment jsdom
//
// A diagram's walkthrough count (ADR 0034 §6, "Entry without the agent"): read from the inventory when
// the service sends it, carried on the file row, and said in the project's file list and on its cards.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fileRows } from "../src/app/file-index";
import { FileTable } from "../src/app/FileTable";
import { parseInventory } from "../src/app/inventory";
import { DiagramsView } from "../src/app/project-views/DiagramsView";

afterEach(cleanup);
const SHAPE = { id: "flow", kind: "freeform", title: "Flow", registration: "durable" };
const inventory = (...views: unknown[]) => parseInventory({ schemaVersion: 1, views })!;
const rowOf = (walkthroughs?: number) =>
  fileRows({
    slug: "p",
    name: "P",
    current: true,
    notes: [],
    views: inventory({ ...SHAPE, ...(walkthroughs === undefined ? {} : { walkthroughs }) }),
  })[0]!;

describe("the count", () => {
  it("is read from the inventory, when it is a count", () => {
    expect(inventory({ ...SHAPE, walkthroughs: 3 })[0]).toMatchObject({ walkthroughs: 3 });
    for (const bad of [-1, 1.5, "2", null])
      expect(inventory({ ...SHAPE, walkthroughs: bad })[0]).not.toHaveProperty("walkthroughs");
  });
  it("is on the row only when there is one", () => {
    expect(rowOf(2).walkthroughs).toBe(2);
    expect(rowOf(0)).not.toHaveProperty("walkthroughs");
    expect(rowOf()).not.toHaveProperty("walkthroughs");
  });
});

describe("where it is said", () => {
  it("as a status chip in the file list, and the status is no longer empty for it", () => {
    const { container } = render(
      <FileTable
        label="Files"
        columns={["name"]}
        groups={[{ id: "files", heading: null, rows: [rowOf(2)] }]}
        now={Date.now()}
        onOpen={() => undefined}
      />,
    );
    expect(container.querySelector('[data-column="name"][role="cell"]')).toHaveTextContent("2 walkthroughs");
    cleanup();
    const one = render(
      <FileTable
        label="Files"
        columns={["name"]}
        groups={[{ id: "files", heading: null, rows: [rowOf(1)] }]}
        now={Date.now()}
        onOpen={() => undefined}
      />,
    );
    expect(one.container.querySelector('[data-column="name"][role="cell"]')).toHaveTextContent("1 walkthrough");
  });
  it("says nothing for a diagram with none", () => {
    const { container } = render(
      <FileTable
        label="Files"
        columns={["name"]}
        groups={[{ id: "files", heading: null, rows: [rowOf()] }]}
        now={Date.now()}
        onOpen={() => undefined}
      />,
    );
    expect(container.querySelector(".archer-files-chip")).toBeNull();
    expect(container).not.toHaveTextContent(/walkthrough/);
  });
  it("on the diagram's card", () => {
    render(<DiagramsView rows={[rowOf(3)]} now={Date.now()} onOpen={() => undefined} />);
    expect(screen.getByRole("article", { name: "Flow" })).toHaveTextContent("3 walkthroughs");
  });
});
