import { test, expect } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { exportDiagram } from "../../src/export/index.ts";
import type { ExportOptions } from "../../src/export/index.ts";
import { testResources } from "./resources.ts";
async function input() {
  const source = "flowchart LR\n a[Customer]:::external\n b[Shop]\n a buys@--> b\n";
  return {
    schemaVersion: 2,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id: "shop", kind: "freeform", title: "Shop" },
    model: (await compile(source)).model!,
  };
}
test("diagram and presentation modes remain selectable with current string caption and emphasis", async () => {
  const envelope = await input(),
    resources = await testResources(),
    presentation = {
      annotation: "UI review <pending> & current",
      emphases: [
        {
          id: "review",
          viewId: "shop",
          groups: [
            {
              id: "customer",
              style: "highlight" as const,
              palette: "coral" as const,
              state: "proposed" as const,
              label: "Customer review",
              nodes: ["a"],
              edges: [],
            },
          ],
        },
      ],
    };
  const plain = new TextDecoder().decode(
    (await exportDiagram(envelope, { resources, mode: "diagram", presentation })).bytes,
  );
  expect(plain).not.toContain("data-emphasis");
  expect(plain).not.toContain("Diagram Key");
  expect(plain).not.toContain("UI review");
  const shown = new TextDecoder().decode(
    (await exportDiagram(envelope, { resources, mode: "presentation", presentation })).bytes,
  );
  expect(shown).toContain('data-emphasis="review"');
  // ADR 0030: a proposed group is not drawn dashed; its label says so.
  expect(shown).not.toContain("stroke-dasharray:5 3");
  expect(shown).toContain("UI review &lt;pending&gt; &amp; current");
  expect(shown).toContain("Customer review");
  expect(shown).toContain("Diagram Key");
});
test("last-good export requires explicit opt in and reports actual revision and current failures", async () => {
  const envelope = await input(),
    resources = await testResources(),
    source = {
      revision: `sha256:${"b".repeat(64)}`,
      diagnostics: [
        {
          code: "parse_error",
          message: "Current source is invalid",
          span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          severity: "error" as const,
        },
      ],
    };
  const options = { resources, source } as ExportOptions;
  await expect(exportDiagram(envelope, options)).rejects.toMatchObject({ code: "export_last_good_requires_opt_in" });
  const result = await exportDiagram(envelope, { ...options, allowLastGood: true } as ExportOptions);
  expect(result).toMatchObject({
    revision: envelope.revision,
    sourceRevision: source.revision,
    lastGood: true,
    diagnostics: source.diagnostics,
  });
});
test("active emphasis uses the incumbent first-group treatment and supports explicit dismissal", async () => {
  const envelope = await input(),
    resources = await testResources(),
    emphases = [
      {
        id: "first",
        viewId: "shop",
        groups: [
          {
            id: "amber",
            style: "highlight" as const,
            palette: "coral" as const,
            state: "existing" as const,
            nodes: ["a"],
            edges: [],
          },
          {
            id: "violet",
            style: "highlight" as const,
            palette: "violet" as const,
            state: "existing" as const,
            nodes: ["a"],
            edges: [],
          },
        ],
      },
      {
        id: "newest",
        viewId: "shop",
        groups: [
          {
            id: "teal",
            style: "highlight" as const,
            palette: "teal" as const,
            state: "existing" as const,
            nodes: ["b"],
            edges: [],
          },
        ],
      },
    ];
  const explicit = await exportDiagram(envelope, {
    resources,
    mode: "presentation",
    presentation: { emphases, activeEmphasisId: "first" },
  });
  const text = new TextDecoder().decode(explicit.bytes);
  expect(explicit.activeEmphasisId).toBe("first");
  expect(text.match(/data-emphasis="first"/g)).toHaveLength(1);
  expect(text).not.toContain('data-emphasis="newest"');
  const dismissed = await exportDiagram(envelope, {
    resources,
    mode: "presentation",
    presentation: { emphases, activeEmphasisId: null },
  });
  expect(dismissed.activeEmphasisId).toBeNull();
  expect(new TextDecoder().decode(dismissed.bytes)).not.toContain("data-emphasis=");
  const newest = await exportDiagram(envelope, { resources, mode: "presentation", presentation: { emphases } });
  expect(newest.activeEmphasisId).toBe("newest");
  await expect(
    exportDiagram(envelope, {
      resources,
      mode: "presentation",
      presentation: { emphases, activeEmphasisId: "missing" },
    }),
  ).rejects.toMatchObject({ code: "export_presentation_invalid" });
});
test("missing current source keeps null provenance and cannot silently borrow the last-good hash", async () => {
  const envelope = await input(),
    resources = await testResources(),
    source = { revision: null, diagnostics: [] };
  await expect(exportDiagram(envelope, { resources, source } as unknown as ExportOptions)).rejects.toMatchObject({
    code: "export_last_good_requires_opt_in",
  });
  const result = await exportDiagram(envelope, { resources, source, allowLastGood: true } as unknown as ExportOptions);
  expect(result).toMatchObject({ sourceRevision: null, lastGood: true, revision: envelope.revision });
});
test("an emphasis id is written as text, never read as a replacement pattern (C-12)", async () => {
  const envelope = await input(),
    resources = await testResources();
  const escapeAttribute = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const painted = async (id: string): Promise<string> => {
    const emphases = [
      {
        id,
        viewId: "shop",
        groups: [
          {
            id: "g",
            style: "highlight" as const,
            palette: "coral" as const,
            state: "existing" as const,
            nodes: ["a"],
            edges: ["buys"],
          },
        ],
      },
    ];
    return new TextDecoder().decode(
      (await exportDiagram(envelope, { resources, mode: "presentation", presentation: { emphases } })).bytes,
    );
  };
  const plain = await painted("plain");
  for (const id of ["$&", "$1", "$$", "$'", "$`", "$<x>", "a$&b$$c"]) {
    const text = await painted(id);
    expect(
      [...text.matchAll(/data-emphasis="([^"]*)"/g)].map((match) => match[1]),
      id,
    ).toEqual([escapeAttribute(id), escapeAttribute(id)]);
    // Nothing of the drawing was pasted in: the same document as with a plain id, but for the id itself.
    const asPlain = text
      .split(`data-emphasis="${escapeAttribute(id)}"`)
      .join('data-emphasis="plain"')
      .split(`activeEmphasisId&quot;:&quot;${escapeAttribute(id)}&quot;`)
      .join("activeEmphasisId&quot;:&quot;plain&quot;");
    expect(asPlain, id).toBe(plain);
  }
});
