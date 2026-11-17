// Two-way links and messages: Mermaid's `<-->` family in a flowchart and its
// `<<->>` / `<<-->>` in a sequence are one edge (one message) with an
// arrowhead at each end, carried in the model as `bidirectional: true`.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import type { FreeformGraph, MessageEvent, SequenceTrace } from "../../src/model/index.ts";
import { errorsOf, located } from "./support/compile-helpers.ts";
import { checkAgainst } from "./support/schema.ts";

const F = (edge: string) => `flowchart LR\n  a[A]\n  b[B]\n  ${edge}\n`;
const S = (body: string) => `sequenceDiagram\n    participant a as A\n    participant b as B\n${body}\n`;

describe("a flowchart two-way link", () => {
  test.each([
    ["a e1@<--> b", undefined],
    ["a e1@<---> b", undefined],
    ["a e1@<-.-> b", "dotted"],
    ["a e1@<-..-> b", "dotted"],
    ["a e1@<==> b", "thick"],
    ["a e1@<===> b", "thick"],
  ])("%s is one edge with an arrowhead at each end", async (edge, line) => {
    const result = await compile(F(edge));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    const model = result.model as FreeformGraph;
    expect(model.edges).toEqual([
      { id: "e1", source: "a", target: "b", bidirectional: true, ...(line === undefined ? {} : { line }) },
    ]);
    expect(checkAgainst("DiagramModel", model)).toEqual([]);
  });

  test("keeps its label", async () => {
    const result = await compile(F('a e1@<-->|"sync (both ways)"| b'));
    expect((result.model as FreeformGraph).edges[0]).toEqual({
      id: "e1",
      source: "a",
      target: "b",
      label: "sync (both ways)",
      bidirectional: true,
    });
  });

  test("a one-way link carries no bidirectional field", async () => {
    const result = await compile(F("a e1@--> b"));
    expect((result.model as FreeformGraph).edges[0]).toEqual({ id: "e1", source: "a", target: "b" });
  });

  test("still needs an edge ID", async () => {
    const result = await compile(F("a <--> b"));
    expect(result.model).toBeNull();
    expect(located(errorsOf(result.diagnostics))).toEqual(["unsupported_construct@4:5"]);
    expect(result.diagnostics[0]?.hint).toBe("  a a_b@<--> b");
  });

  test.each(["a e1@<--x b", "a e1@<--o b", "a e1@<--- b"])(
    "refuses %s, a two-way start with another end",
    async (edge) => {
      const result = await compile(F(edge));
      expect(result.model).toBeNull();
      expect(errorsOf(result.diagnostics).length).toBeGreaterThan(0);
    },
  );
});

describe("a sequence two-way message", () => {
  test.each([
    ["a<<->>b: both", "sync"],
    ["a<<-->>b: both", "reply"],
  ])("%s is one message with an arrowhead at each end", async (line, kind) => {
    const result = await compile(S(`    ${line}`));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    const model = result.model as SequenceTrace;
    expect(model.events).toEqual([
      { type: "message", id: "msg-0", from: "a", to: "b", kind, label: "both", bidirectional: true },
    ]);
    expect(checkAgainst("DiagramModel", model)).toEqual([]);
  });

  test("takes the activation shorthand", async () => {
    const result = await compile(S("    a<<->>+b: go\n    b-->>-a: done"));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    const events = (result.model as SequenceTrace).events;
    expect(events.map((event) => event.type)).toEqual(["message", "activate", "message", "deactivate"]);
    expect((events[0] as MessageEvent).bidirectional).toBe(true);
    expect((events[2] as MessageEvent).bidirectional).toBeUndefined();
  });
});
