// Where Mermaid reads a sequence diagram differently from the line it looks
// like, Archer refuses the line rather than show or check something Mermaid
// would not draw. Each case below was measured against mermaid 12.1.0.

import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { applyHints, errorsOf, located } from "./support/compile-helpers.ts";

const S = (body: string) => `sequenceDiagram\n    participant a as A\n${body}\n`;

test.each([
  ["message text", S("    a->>a: issue #42 here"), "legacy_syntax@3:18", "    a->>a: issue #35;42 here"],
  ["an alias", "sequenceDiagram\n    participant a as A #1\n", "legacy_syntax@2:24", "    participant a as A #35;1"],
  ["note text", S("    Note over a: n #x"), "legacy_syntax@3:20", "    Note over a: n #35;x"],
  ["a fragment label", S("    loop l #y\n      a->>a: x\n    end"), "legacy_syntax@3:12", "    loop l #35;y"],
])("Mermaid ends %s at `#`; refused with the escaped line", async (_where, source, at, hint) => {
  const result = await compile(source);
  expect(result.model).toBeNull();
  const errors = errorsOf(result.diagnostics);
  expect(located(errors)).toEqual([at]);
  expect(errors[0]?.hint).toBe(hint);
  const fixed = await compile(applyHints(source, errors));
  expect(errorsOf(fixed.diagnostics)).toEqual([]);
});

test("an entity code is not a `#` that ends the text", async () => {
  const result = await compile(S("    a->>a: say #quot;hi#quot; #35;1"));
  expect(result.diagnostics).toEqual([]);
  expect(result.model).toMatchObject({ events: [{ label: 'say "hi" #1' }] });
});

test("Mermaid ends a statement at `;`, so a second statement hidden after one is refused", async () => {
  const result = await compile(S("    a->>a: x; a->>z: y"));
  expect(result.model).toBeNull();
  const errors = errorsOf(result.diagnostics);
  expect(located(errors)).toEqual(["unsupported_construct@3:13"]);
  expect(errors[0]?.hint).toBe("    a->>a: x#59; a->>z: y");
});

test("an activation mark may follow the arrow after a space, as Mermaid reads it", async () => {
  const result = await compile(S("    a->> +a: spaced"));
  expect(errorsOf(result.diagnostics)).toEqual([]);
  expect(result.model).toMatchObject({
    events: [
      { type: "message", to: "a" },
      { type: "activate", participant: "a" },
    ],
  });
});

test("a participant ID with a space is refused rather than read two ways", async () => {
  const result = await compile("sequenceDiagram\n    participant a b as AB\n    a b->>a b: x\n");
  expect(result.model).toBeNull();
  expect(errorsOf(result.diagnostics).length).toBeGreaterThan(0);
});

test("`#` in a flowchart label is kept, as Mermaid keeps it", async () => {
  const result = await compile('flowchart LR\n  a[issue #42] e1@-->|see #7| b["q #9 x"]\n');
  expect(result.diagnostics).toEqual([]);
  expect(result.model).toMatchObject({
    nodes: [{ label: "issue #42" }, { label: "q #9 x" }],
    edges: [{ label: "see #7" }],
  });
});
