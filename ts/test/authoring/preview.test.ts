import { expect, test } from "vitest";
import { previewAuthoring, parseAuthoringPreview } from "../../src/authoring/preview.ts";
import { AuthoringInputError } from "../../../shared/authoring-contract.mts";
import { revisionOf } from "../../src/project/index.ts";
import { STARTER_PREVIEW, STARTER_SOURCE } from "../../../shared/authoring-starter.mts";
import { CANVAS_LINES } from "../../src/authoring/preview-input.ts";
const source = "\ufeffflowchart LR\r\n  a[Alpha]\r\n  b[Beta]\r\n  a e1@--> b\r\n";
test("authoring preview uses the production envelope and exact source revision; edits preserve bytes", async () => {
  const result = (await previewAuthoring({ source })) as any;
  expect(result.envelope).toMatchObject({
    schemaVersion: 2,
    revision: revisionOf(Buffer.from(source)),
    model: {
      type: "freeform-graph",
      nodes: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    },
  });
  expect(result.diagnostics).toEqual([]);
  const edited = (await previewAuthoring(
    { source, edit: { kind: "relabel-node", id: "a", label: "API" } },
    true,
  )) as any;
  expect(edited.ok).toBe(true);
  expect(edited.source).toBe(source.replace("a[Alpha]", 'a["API"]'));
  expect(edited.envelope.model.nodes[0].label).toBe("API");
  const invalid = (await previewAuthoring({ source: "nonsense" })) as any;
  expect(invalid.envelope).toBeNull();
  expect(invalid.diagnostics.length).toBeGreaterThan(0);
});
test("preview request parser refuses unknown keys, invalid enum/IDs and excess source", () => {
  for (const input of [null, [], { source: 1 }, { source: "x", extra: true }, { source: "x".repeat(262145) }])
    expect(() => parseAuthoringPreview(input)).toThrow(AuthoringInputError);
  for (const edit of [
    { kind: "unknown" },
    { kind: "change-shape", id: "a", shape: "__proto__" },
    { kind: "direction", direction: "sideways" },
    { kind: "delete-node", id: "../a" },
    { kind: "relabel-node", id: "a", label: 1 },
    { kind: "connect", id: "e1", source: "a", target: "b", extra: 1 },
  ])
    expect(() => parseAuthoringPreview({ source, edit }, true)).toThrow(AuthoringInputError);
  for (const edit of [
    { kind: "relabel-node", id: "a", label: "" },
    { kind: "add-node", id: "c", label: "C" },
    { kind: "connect", id: "e2", source: "a", target: "b" },
    { kind: "relabel-edge", id: "e1", label: "uses" },
    { kind: "change-shape", id: "a", shape: "rounded" },
    { kind: "delete-edge", id: "e1" },
    { kind: "delete-node", id: "a" },
    { kind: "direction", direction: "tb" },
  ])
    expect(parseAuthoringPreview({ source, edit }, true).edit).toEqual(edit);
});

test("escaped lone surrogates refuse instead of silently replacing source or labels", async () => {
  for (const source of ["flowchart LR\n a[\ud800]\n", "flowchart LR\n a[\udc00]\n"])
    await expect(previewAuthoring({ source })).rejects.toBeInstanceOf(AuthoringInputError);
  await expect(
    previewAuthoring({ source, edit: { kind: "relabel-node", id: "a", label: "\ud800" } }, true),
  ).rejects.toBeInstanceOf(AuthoringInputError);
  expect(parseAuthoringPreview({ source: "flowchart LR\n a[😀]\n" }).source).toContain("😀");
});

test("connect line accepts every line the canvas draws and refuses anything else", () => {
  for (const line of CANVAS_LINES) {
    const edit = { kind: "connect", id: "e2", source: "a", target: "b", label: "x", line };
    expect(parseAuthoringPreview({ source, edit }, true).edit).toEqual(edit);
  }
  for (const line of ["dashed", "SOLID", "", null, 1, "__proto__"])
    expect(() =>
      parseAuthoringPreview({ source, edit: { kind: "connect", id: "e2", source: "a", target: "b", line } }, true),
    ).toThrow(AuthoringInputError);
  expect(() =>
    parseAuthoringPreview({ source, edit: { kind: "add-node", id: "c", label: "C", line: "dotted" } }, true),
  ).toThrow(AuthoringInputError);
});
test("the editor's own preview of the new-diagram starter is exactly the service's", async () => {
  expect(await previewAuthoring({ source: STARTER_SOURCE })).toEqual(STARTER_PREVIEW);
});
