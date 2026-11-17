import { readFileSync } from "node:fs";
import { readExpandMenu } from "../src/expand/pieces";
import { describe, expect, test } from "vitest";
import type { DiagramView } from "../src/app/inventory";
import { descriptionExcerpt, sourceMetadata } from "../src/expand/source-metadata";

const views: DiagramView[] = [
  {
    id: "checkout",
    title: "Checkout",
    kind: "sequence",
    registration: "durable",
    description: "The full payment conversation.",
  },
  {
    id: "notes/orders.md#payment",
    note: "notes/orders.md",
    name: "payment",
    title: "Checkout",
    kind: "c4-container",
    registration: "embedded",
    description: "Where payments run.",
  },
  { id: "flow", title: "Flow", kind: "freeform", registration: "durable" },
];
describe("element-menu inventory metadata", () => {
  test("a source with no addable piece still gets its type and description", () => {
    expect(sourceMetadata("checkout", views)).toEqual({
      type: "Sequence",
      description: "The full payment conversation.",
      cue: "checkout",
    });
  });
  test("embedded IDs resolve exactly; duplicate titles get a source cue", () => {
    expect(sourceMetadata("notes/orders.md#payment", views)).toEqual({
      type: "Containers",
      description: "Where payments run.",
      cue: "notes/orders.md · payment",
    });
    expect(sourceMetadata("payment", views)).toEqual({ type: "Diagram" });
  });
  test("missing metadata stays absent; freeform uses the shared reader-facing label", () => {
    expect(sourceMetadata("flow", views)).toEqual({ type: "Flowchart" });
    expect(sourceMetadata("gone", views)).toEqual({ type: "Diagram" });
  });
  test("excerpts normalize space, keep words and Unicode intact, and leave short text whole", () => {
    expect(descriptionExcerpt("A short\n description.")).toBe("A short description.");
    expect(descriptionExcerpt("A small 😀 conversation with many people", 24)).toBe("A small 😀 conversation…");
    expect(descriptionExcerpt("שלום עולם בדיקה", 10)).toBe("שלום עולם…");
    expect(descriptionExcerpt("😀".repeat(110))).toBe(`${"😀".repeat(100)}…`);
    expect(descriptionExcerpt("<script>plain text</script>")).toBe("<script>plain text</script>");
  });
});

test("generic C4 inventory is refined by an already-returned piece, never guessed from the family", () => {
  const generic: DiagramView = { id: "c4", title: "Runtime", kind: "c4", registration: "durable" };
  const piece = readExpandMenu(JSON.parse(readFileSync("tests/fixtures/expand/menu-context-shop.json", "utf8")))!
    .diagrams.items[0]!.piece;
  expect(sourceMetadata("c4", [generic], piece)).toEqual({ type: "Containers" });
  expect(sourceMetadata("c4", [generic], null)).toEqual({ type: "Diagram" });
});

test("unrecognised kinds do not expose wire identifiers as reader-facing types", () => {
  expect(
    sourceMetadata("new", [{ id: "new", title: "New", kind: "future-wire-kind", registration: "durable" }]),
  ).toEqual({ type: "Diagram" });
});

test("excerpts keep long words and joined emoji whole when no space boundary is available", () => {
  expect(descriptionExcerpt("uninterruptedword", 6)).toBe("uninterruptedword");
  expect(descriptionExcerpt("👩‍💻👩‍💻👩‍💻", 5)).toBe("👩‍💻…");
});
