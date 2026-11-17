// ADR 0012: a view id is a stable ID or a diagram address. Element ids are
// unchanged, every existing id and golden fixture stays valid, and the
// schema, the shared parser and the service agree on one grammar.
import { describe, expect, test } from "vitest";
import { DIAGRAM_ADDRESS_SOURCE, parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import { parseTarget } from "../../src/comments/store.ts";
import { isStableId, isViewId } from "../../src/model/ids.ts";
import { checkAgainst, envelopeSchema } from "../mermaid/support/schema.ts";
import { loadFixtures } from "../mermaid/support/fixtures.ts";
import { compile } from "../../src/mermaid/index.ts";

const ADDRESSES = [
  "notes/auth.md#login-flow",
  "auth.md#a",
  "deep/er/x y.md#d-1",
  "été/carte.md#plan_2",
  `${"a/".repeat(500)}n.md#x`,
];
const NOT_ADDRESSES = [
  "",
  "login-flow#",
  "notes/auth.md#",
  "notes/auth.md#a/b",
  "notes/auth.mmd#x",
  "../auth.md#x",
  "./auth.md#x",
  "notes/../x.md#a",
  ".hidden/x.md#a",
  "notes/.x.md#a",
  "/abs.md#a",
  "a//b.md#x",
  "a\\b.md#x",
  "c:/x.md#a",
  "a:b.md#x",
  "a?b.md#x",
  "a#b.md#x",
  "a\u0000.md#x",
  "a\nb.md#x",
  "a\u007f.md#x",
  `${"a/".repeat(600)}n.md#x`,
  "notes/auth.md#-x",
];

describe("the view id grammar", () => {
  test.each(ADDRESSES)("%s is a view id and an address, and never a stable (element) id", (raw) => {
    expect(isViewId(raw)).toBe(true);
    expect(isStableId(raw)).toBe(false);
    expect(parseDiagramAddress(raw)).not.toBeNull();
  });

  test.each(NOT_ADDRESSES)("%j is not an address", (raw) => {
    expect(parseDiagramAddress(raw)).toBeNull();
    expect(isViewId(raw)).toBe(isStableId(raw));
  });

  test("every stable ID is still a view id", () => {
    for (const id of ["flow", "a", "A9", "x_y-z", "0", "x".repeat(128)]) expect(isViewId(id)).toBe(true);
    expect(isViewId("x".repeat(129))).toBe(false);
  });

  test("an adversarial address is refused in well under a second", () => {
    for (const raw of [`${"a".repeat(1100)}.md`, `${"a/".repeat(590)}.mdx#a`, `${".md".repeat(399)}#`]) {
      const started = performance.now();
      isViewId(raw);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe("the envelope schema", () => {
  const viewId = (envelopeSchema["$defs"] as Record<string, { properties: Record<string, unknown> }>)["ViewMetadata"]!
    .properties["id"] as {
    anyOf: { pattern: string }[];
    maxLength: number;
  };

  test("states the view id as a stable ID or the shared address pattern, at most 1200 characters", () => {
    expect(viewId.maxLength).toBe(1200);
    expect(viewId.anyOf.map((a) => a.pattern)).toEqual(["^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", DIAGRAM_ADDRESS_SOURCE]);
  });

  test("accepts an envelope named by an address, and refuses one that escapes the folder", () => {
    const envelope = (id: string) => ({
      schemaVersion: 2,
      view: { id, kind: "freeform", title: "Login" },
      revision: `sha256:${"0".repeat(64)}`,
      model: { type: "freeform-graph", nodes: [], edges: [], groups: [] },
    });
    expect(checkAgainst("ViewMetadata", envelope("notes/auth.md#login-flow").view)).toEqual([]);
    for (const bad of NOT_ADDRESSES.filter((a) => !isStableId(a)))
      expect(checkAgainst("ViewMetadata", envelope(bad).view), bad).not.toEqual([]);
  });

  test("keeps element ids stable IDs: a node named like an address is refused", async () => {
    const { model } = await compile('flowchart LR\n  a["A"]\n');
    const graph = model as { nodes: { id: string }[] };
    graph.nodes[0]!.id = "notes/a.md#x";
    expect(checkAgainst("DiagramModel", graph)).not.toEqual([]);
  });

  test("every golden fixture's model still conforms", () => {
    for (const fixture of loadFixtures())
      expect(checkAgainst("DiagramModel", fixture.expected), fixture.name).toEqual([]);
  });
});

test("a comments target may name a view by its address", () => {
  expect(parseTarget("view:notes/auth.md#login-flow")).toBe("view:notes/auth.md#login-flow");
  expect(parseTarget("view:../auth.md#x")).toBeNull();
  expect(parseTarget("view:flow")).toBe("view:flow");
});
