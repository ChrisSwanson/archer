// @vitest-environment jsdom
// The layout worker starts once the inventory says the addressed view is a graph, with the view's own read, not after
// it is drawn (lead's call 2026-11-03: PF-5 moved the worker's start onto the graph page's critical path, +48 ms).
import { afterEach, expect, it } from "vitest";
import { addressNamesGraph } from "../src/app/layout-warmup";

const VIEWS = [
  { id: "flow-styled", kind: "flowchart", sourcePath: "diagrams/flow-styled.mmd", registration: "durable" },
  { id: "seq", kind: "sequence", sourcePath: "diagrams/seq.mmd", registration: "durable" },
  { id: "trip", kind: "journey", sourcePath: "diagrams/trip.mmd", registration: "durable" },
];
const at = (href: string) => window.history.replaceState(null, "", href);
afterEach(() => at("/"));

it("names a graph for a graph diagram's file address or ?view=, and its editor", () => {
  at("/projects/awkward/diagrams/flow-styled.mmd");
  expect(addressNamesGraph(VIEWS)).toBe(true);
  at("/projects/awkward/diagrams/flow-styled.mmd?edit");
  expect(addressNamesGraph(VIEWS)).toBe(true);
  at("/?view=flow-styled");
  expect(addressNamesGraph(VIEWS)).toBe(true);
});

it("names none for a sequence, a journey, a list, a note or a view the inventory does not hold", () => {
  for (const href of [
    "/projects/awkward/diagrams/seq.mmd",
    "/projects/awkward/diagrams/trip.mmd",
    "/projects/awkward/",
    "/projects/awkward/notes/auth.md",
    "/?view=gone",
  ]) {
    at(href);
    expect(addressNamesGraph(VIEWS), href).toBe(false);
  }
});
