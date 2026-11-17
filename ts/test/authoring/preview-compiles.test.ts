// An edit request compiles each source text once: the edit's verifying compile is the preview's envelope,
// and the next edit's starting point. A 150-node flowchart costs ~100-300 ms per compile.
import { expect, test, vi } from "vitest";

const compiled = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("../../src/mermaid/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mermaid/index.ts")>();
  return {
    ...actual,
    compile: (text: string, ...rest: unknown[]) => {
      compiled.texts.push(text);
      return (actual.compile as (...a: unknown[]) => ReturnType<typeof actual.compile>)(text, ...rest);
    },
  };
});
const { previewAuthoring } = await import("../../src/authoring/preview.ts");

const SOURCE = "flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n";

test("an edit compiles the edited source once, and the next edit starts from that compile", async () => {
  compiled.texts.length = 0;
  const first = (await previewAuthoring(
    { source: SOURCE, edit: { kind: "relabel-node", id: "a", label: "Alpha" } },
    true,
  )) as { ok: true; source: string; envelope: { model: unknown } | null };
  expect(first.ok).toBe(true);
  expect(first.envelope).not.toBeNull();
  const counts = (text: string) => compiled.texts.filter((t) => t === text).length;
  expect(counts(SOURCE)).toBe(1);
  expect(counts(first.source)).toBe(1);
  const second = (await previewAuthoring(
    { source: first.source, edit: { kind: "relabel-node", id: "b", label: "Beta" } },
    true,
  )) as { ok: true; source: string };
  expect(second.ok).toBe(true);
  expect(counts(first.source)).toBe(1);
  expect(counts(second.source)).toBe(1);
});

test("a preview without an edit is the same answer as before", async () => {
  const preview = (await previewAuthoring({ source: SOURCE })) as {
    envelope: { model: { type: string } };
    diagnostics: unknown[];
  };
  expect(preview.envelope.model.type).toBe("freeform-graph");
  expect(preview.diagnostics).toEqual([]);
});
