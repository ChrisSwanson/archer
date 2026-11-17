// The graph models the terminal tests draw: golden flowchart models in
// fixtures/flowchart/*.json and self-contained JSON snapshots in this directory
// under fixtures/. The docs/diagrams model-name prefix is historical, not a path.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readGraphInput, type GraphInput } from "../../src/terminal/input.ts";

export const REPO = join(import.meta.dirname, "..", "..", "..");
const GOLDEN = join(REPO, "fixtures", "flowchart");
const LOCAL = join(import.meta.dirname, "fixtures");

const jsonIn = (dir: string, prefix: string): [string, string][] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [`${prefix}/${f.slice(0, -5)}`, join(dir, f)]);

/** Every model by name ("fixtures/flowchart/shapes", "docs/diagrams/system-context") and path. */
export const MODEL_FILES: [string, string][] = [
  ...jsonIn(GOLDEN, "fixtures/flowchart"),
  ...jsonIn(LOCAL, "docs/diagrams"),
];

export const loadModel = (path: string): GraphInput => readGraphInput(JSON.parse(readFileSync(path, "utf8")));

export const modelNamed = (name: string): GraphInput => {
  const found = MODEL_FILES.find(([n]) => n === name);
  if (!found) throw new Error(`no test model ${name}`);
  return loadModel(found[1]);
};
