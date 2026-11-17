// The architecture-beta profile: what it reads, and each construct it refuses,
// at the place it is written, with what to write instead.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { located } from "./support/compile-helpers.ts";
import { refusals } from "./support/refusals.ts";

const A = (body: string) => `architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n${body}\n`;

describe("refused", () => {
  refusals([
    { name: "an edge to an ID never declared", source: A("  a:L -- R:c"), errors: ["undeclared_element@4:3"] },
    {
      name: "an icon from an icon pack",
      source: A("  service c(logos:aws-s3)[C]"),
      errors: ["unsupported_construct@4:13"],
      says: "built-in",
    },
    { name: "a second service with one ID", source: A("  service a(disk)[Again]"), errors: ["duplicate_id@4:11"] },
    { name: "an edge with an unknown side", source: A("  a:Q -- R:b"), errors: ["unsupported_construct@4:3"] },
    {
      name: "a service in a group never declared",
      source: A("  service c(disk)[C] in nowhere"),
      errors: ["undeclared_group@4:11"],
    },
    {
      name: "an edge to a group",
      source: A("  group g(cloud)[G]\n  a:L -- R:g"),
      errors: ["unsupported_construct@5:3"],
    },
    { name: "a service with no label", source: A("  service c(disk)"), errors: ["unsupported_construct@4:3"] },
    {
      name: "HTML in a label",
      source: A("  service c(disk)[<b>C</b>]"),
      errors: ["unsupported_construct@4:19"],
      says: "HTML",
    },
    {
      name: "a `{group}` edge between services of one group, which Mermaid refuses",
      source:
        "architecture-beta\n  group g(cloud)[G]\n  service a(server)[A] in g\n  service b(server)[B] in g\n  a{group}:L -- R:b\n",
      errors: ["invalid_diagram@1:1"],
      says: "group boundary",
    },
    {
      name: "a comment after a statement",
      source: A("  a:L -- R:b %% why"),
      errors: ["unsupported_construct@4:14"],
      hint: "  %% why\n  a:L -- R:b",
    },
  ]);
});

describe("read", () => {
  test("arrows at either end, and a label", async () => {
    const result = await compile(A("  a:B <-[calls]-> T:b"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      edges: [
        { id: "a--b", sourceSide: "bottom", targetSide: "top", sourceArrow: true, targetArrow: true, label: "calls" },
      ],
    });
  });

  test("a service with no icon, and a quoted label", async () => {
    const result = await compile('architecture-beta\n  service c["Client (web)"]\n');
    expect(result.model).toMatchObject({ services: [{ id: "c", label: "Client (web)" }] });
    expect(located(result.diagnostics)).toEqual([]);
  });

  test("a Mermaid parse error is located from its message", async () => {
    const result = await compile("architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  a:L - R:b\n");
    expect(located(result.diagnostics)[0]).toMatch(/@4:/);
  });
});
