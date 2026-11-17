// A scan that stopped at a nesting bound is the whole answer: Mermaid is not asked to parse
// what the profile already refused (server review S1, defence behind the pre-check).

import { beforeEach, expect, test, vi } from "vitest";

const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/mermaid/engine.ts", async (original) => {
  const engine = await original<typeof import("../../src/mermaid/engine.ts")>();
  return {
    ...engine,
    parseWithMermaid: (...args: Parameters<typeof engine.parseWithMermaid>) => {
      parsed.count += 1;
      return engine.parseWithMermaid(...args);
    },
  };
});

const { compile } = await import("../../src/mermaid/index.ts");
const { MAX_NESTING_DEPTH } = await import("../../src/mermaid/limits.ts");

beforeEach(() => {
  parsed.count = 0;
});

const nested = (open: (level: number) => string, close: string, header: string, body: string) => {
  const depth = MAX_NESTING_DEPTH + 5;
  return [
    header,
    ...Array.from({ length: depth }, (_, level) => open(level)),
    body,
    ...Array.from({ length: depth }, () => close),
  ].join("\n");
};

test.each([
  ["flowchart", nested((l) => `subgraph g${l}[G]`, "end", "flowchart LR", "  a[A]"), "subgraph_nesting_too_deep"],
  [
    "sequence",
    nested((l) => `loop l${l}`, "end", "sequenceDiagram\n  participant a as A", "  a->>a: x"),
    "fragment_nesting_too_deep",
  ],
  ["state", nested((l) => `state s${l} {`, "}", "stateDiagram-v2", "  a"), "nesting_too_deep"],
  ["c4", nested((l) => `Boundary(b${l}, "B") {`, "}", "C4Context", '  Person(p, "P")'), "nesting_too_deep"],
])("%s: refused by the scan without a Mermaid parse", async (_family, source, code) => {
  const result = await compile(source);
  expect(result.model).toBeNull();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
  expect(parsed.count).toBe(0);
});

test("a source within the bounds is still parsed by Mermaid", async () => {
  await compile("flowchart LR\n  a[A]\n");
  expect(parsed.count).toBe(1);
});
