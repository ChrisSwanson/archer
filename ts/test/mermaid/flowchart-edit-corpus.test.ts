import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { editFlowchart } from "../../src/authoring/flowchart-edit.ts";
const root = resolve(import.meta.dirname, "../../..");
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(resolve(path, e.name)) : [resolve(path, e.name)],
  );
}
const sources: { name: string; source: string }[] = [];
for (const dir of [
  "fixtures/flowchart",
  "ts/test/fixtures/flowchart",
  "ts/test/fixtures/pageturner/.archer/diagrams",
  ".archer/diagrams",
])
  for (const path of files(resolve(root, dir)).filter((p) => p.endsWith(".mmd")))
    sources.push({ name: relative(root, path), source: readFileSync(path, "utf8") });
// Use the production compiler to discover all nodes before registering table cases.
// These are actual baseline models, never a second source parser or hand-built graph.
const collectionStarted = performance.now();
const baselines: { name: string; source: string; compiled: Awaited<ReturnType<typeof compile>> }[] = [];
for (const entry of sources) baselines.push({ ...entry, compiled: await compile(entry.source) });
const collectionMilliseconds = performance.now() - collectionStarted;
const nodeCases = baselines.flatMap(({ name, source, compiled }) => {
  const before = compiled.model;
  return before?.type === "freeform-graph" ? before.nodes.map((node) => ({ name, source, before, node })) : [];
});
const valid: string[] = [],
  excluded: { name: string; codes: string[] }[] = [],
  other: string[] = [];
let noops = 0,
  relabels = 0;
const caseDeadlineMilliseconds = 5000;
const timings: { name: string; milliseconds: number }[] = [];
test.each(baselines)(
  "actual checked-in corpus classification: $name",
  async ({ name, source, compiled: baseline }) => {
    const started = performance.now();
    try {
      const compiled = await compile(source);
      expect(compiled, name).toEqual(baseline);
      if (!compiled.model) {
        excluded.push({ name, codes: compiled.diagnostics.map((d) => d.code) });
        return;
      }
      if (compiled.model.type !== "freeform-graph") {
        other.push(name);
        return;
      }
      valid.push(name);
    } finally {
      timings.push({ name: `classification:${name}`, milliseconds: performance.now() - started });
    }
  },
  caseDeadlineMilliseconds,
);
test.each(nodeCases)(
  "actual checked-in corpus node: $name#$node.id",
  async ({ name, source, before, node }) => {
    const started = performance.now();
    try {
      expect(await editFlowchart(source, { kind: "relabel-node", id: node.id, label: node.label }), name).toEqual({
        ok: true,
        source,
      });
      noops++;
      const label = "Edited 🦉 " + node.id;
      const edited = await editFlowchart(source, { kind: "relabel-node", id: node.id, label });
      expect(edited.ok, name).toBe(true);
      expect((await compile(edited.source)).model, name).toEqual({
        ...before,
        nodes: before.nodes.map((n) => (n.id === node.id ? { ...n, label } : n)),
      });
      relabels++;
    } finally {
      timings.push({ name: `node:${name}#${node.id}`, milliseconds: performance.now() - started });
    }
  },
  caseDeadlineMilliseconds,
);
afterAll(() => {
  expect(valid.length).toBeGreaterThan(0);
  process.stdout.write(
    "SOURCE_FIDELITY_CORPUS " +
      JSON.stringify({
        sources: sources.length,
        validFlowcharts: valid,
        noops,
        relabels,
        excluded,
        otherFamilies: other.length,
        corpusOperationsNotTested: [
          "add-node",
          "connect",
          "relabel-edge",
          "change-shape",
          "delete-edge",
          "delete-node",
          "direction",
        ],
      }) +
      "\n",
  );
  const largest = [...timings].sort((a, b) => b.milliseconds - a.milliseconds)[0];
  process.stdout.write(
    "SOURCE_FIDELITY_CORPUS_TIMING " +
      JSON.stringify({
        cases: timings.length,
        classificationCases: baselines.length,
        nodeCases: nodeCases.length,
        collectionMilliseconds,
        largest,
        deadlineMilliseconds: caseDeadlineMilliseconds,
      }) +
      "\n",
  );
  expect(sources).toHaveLength(34);
  expect(baselines).toHaveLength(34);
  expect(nodeCases).toHaveLength(115);
  expect(timings).toHaveLength(149);
  expect(valid).toHaveLength(11);
  expect(excluded).toHaveLength(5);
  expect(other).toHaveLength(18);
  expect(valid.length + excluded.length + other.length).toBe(sources.length);
  expect(noops).toBe(115);
  expect(relabels).toBe(115);
});
