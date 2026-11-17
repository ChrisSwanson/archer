// The state profile: what it reads, and each construct it refuses, at the
// place it is written, with what to write instead.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { located } from "./support/compile-helpers.ts";
import { refusals } from "./support/refusals.ts";

const S = (body: string) => `stateDiagram-v2\n${body}\n`;
const AB = "  state A\n  state B\n";

describe("refused", () => {
  refusals([
    {
      name: "a state that is never declared",
      source: S("  state A\n  A --> B"),
      errors: ["undeclared_state@3:9"],
      says: "`state B`",
    },
    {
      name: "a state named both inside and outside a composite",
      source: S("  state C {\n    a : A\n  }\n  x : X\n  x --> a"),
      errors: ["state_scope@6:9"],
      says: "inside the composite state 'C'",
    },
    {
      name: "a comment after a transition",
      source: S(`${AB}  A --> B : go %% why`),
      errors: ["unsupported_construct@4:16"],
      hint: "  %% why\n  A --> B : go",
    },
    {
      name: "a concurrent region",
      source: S("  state C {\n    a : A\n    --\n    b : B\n  }"),
      errors: ["unsupported_construct@4:5"],
    },
    {
      name: "a state ID Mermaid reads with a `;`",
      source: S("  state A\n  A --> B;"),
      errors: ["invalid_id@3:9", "unsupported_construct@3:10"],
    },
    { name: "a state ID outside ASCII", source: S("  state état"), errors: ["invalid_id@2:9"], says: "ASCII" },
    {
      name: "a state named as Mermaid names a scope's start",
      source: S("  state root_start"),
      errors: ["reserved_id@2:9"],
      says: "`[*]`",
    },
    { name: "a composite never closed", source: S("  state C {\n    a : A"), errors: ["unclosed_block@2:9"] },
    { name: "a `}` that closes nothing", source: S("  A : Alpha\n  }"), errors: ["unexpected_token@3:3"] },
    {
      name: "HTML in a label",
      source: S('  state "<b>x</b>" as A'),
      errors: ["unsupported_construct@2:10"],
      says: "HTML",
    },
    {
      name: "a note over several lines",
      source: S("  A : Alpha\n  note left of A\n    two\n  end note"),
      errors: ["unsupported_construct@3:3"],
      says: "one line",
    },
    {
      name: "a second note on one state",
      source: S("  A : Alpha\n  note left of A : one\n  note right of A : two"),
      errors: ["duplicate_note@4:17"],
    },
    {
      name: "a second label for one state",
      source: S('  state "One" as A\n  A : Two'),
      errors: ["duplicate_declaration@3:7"],
    },
    { name: "an empty event after `:`", source: S(`${AB}  A --> B :`), errors: ["expected_label@4:11"] },
    {
      name: "direction inside a composite",
      source: S("  state C {\n    direction LR\n    a : A\n  }"),
      errors: ["unsupported_construct@3:5"],
    },
    { name: "an unknown pseudo-state kind", source: S("  state A <<history>>"), errors: ["unsupported_construct@2:3"] },
    { name: "a floating note", source: S('  note "free" as N1'), errors: ["unsupported_construct@2:3"] },
    {
      name: "a state only declared, which Mermaid does not draw",
      source: S(`${AB}  state C\n  A --> B`),
      errors: ["undrawn_state@4:9"],
      says: "`C : Label`",
    },
    { name: "a line that is no statement", source: S("  A"), errors: ["unsupported_construct@2:3"] },
    {
      name: "a short ID after `as` is pointed at itself",
      source: S('  state C {\n    a : A\n  }\n  state "X" as a'),
      errors: ["state_scope@5:16"],
    },
    {
      name: "a short ID after `of` is pointed at itself",
      source: S("  t : T\n  note right of t : x\n  note left of t : y"),
      errors: ["duplicate_note@4:16"],
    },
    {
      name: "direction TD, which Mermaid's state grammar does not have",
      source: S("  direction TD\n  A : A"),
      errors: ["unsupported_construct@2:3"],
    },
    { name: "hide empty description", source: S("  hide empty description"), errors: ["unsupported_construct@2:3"] },
  ]);
});

describe("read", () => {
  test("`stateDiagram` is read as `stateDiagram-v2`", async () => {
    const result = await compile("stateDiagram\n  state A\n  [*] --> A\n");
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      type: "state-machine",
      states: [{ id: "A" }, { id: "root_start", kind: "initial" }],
    });
  });

  test("`Id : Label` declares a state with a label", async () => {
    const result = await compile(S("  Idle : Waiting for work"));
    expect(result.model).toEqual({
      type: "state-machine",
      states: [{ id: "Idle", label: "Waiting for work" }],
      transitions: [],
    });
  });

  test("styling is accepted, left out of the model and noted once", async () => {
    const result = await compile(
      S("  A : Alpha\n  state B:::hot\n  A --> B:::hot\n  classDef hot fill:#f00\n  class A hot\n  style A fill:#0f0"),
    );
    expect(result.model).toEqual({
      type: "state-machine",
      states: [
        { id: "A", label: "Alpha" },
        { id: "B", label: "B" },
      ],
      transitions: [{ id: "A--B", source: "A", target: "B" }],
    });
    expect(located(result.diagnostics)).toEqual(["ignored_styling@3:3"]);
    expect(result.diagnostics[0]?.severity).toBe("info");
  });

  test("a composite's [*] is its own start and end", async () => {
    const result = await compile(S("  state C {\n    state x\n    [*] --> x\n    x --> [*]\n  }\n  [*] --> C"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      transitions: [
        { id: "C_start--x", source: "C_start", target: "x" },
        { id: "x--C_end", source: "x", target: "C_end" },
        { id: "root_start--C", source: "root_start", target: "C" },
      ],
    });
  });

  test("a state may be declared below its first use", async () => {
    const result = await compile(S("  A --> B\n  state A\n  state B"));
    expect(result.diagnostics).toEqual([]);
  });

  test("entity codes are decoded into the characters Mermaid draws", async () => {
    const result = await compile(S("  state A\n  state B\n  A --> B : say #quot;hi#quot;"));
    expect(result.model).toMatchObject({ transitions: [{ label: 'say "hi"' }] });
  });
});
