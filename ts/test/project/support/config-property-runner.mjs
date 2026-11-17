import assert from "node:assert/strict";
import { historicalRegistry, MAX_VIEWS } from "../../../src/project/project.ts";
import { ProjectError } from "../../../src/project/errors.ts";
import { TomlError } from "../../../src/project/toml.ts";
let seed = 177;
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const vocabulary = [
  "version = 1\n",
  "[service]\n",
  'name = "courierdesk"\n',
  'host = "localhost"\n',
  "[[views]]\n",
  'id = "diagram"\n',
  'kind = "freeform"\n',
  'title = "Diagram"\n',
  'source = ".archer/diagram.mmd"\n',
  'covers = ["src/**"]\n',
  '__proto__ = "unknown"\n',
  "# comment\n",
];
const valid =
  'version = 1\n[service]\nname = "courierdesk"\n[[views]]\nid = "diagram"\nkind = "freeform"\ntitle = "Diagram"\nsource = ".archer/diagram.mmd"\ncovers = ["src/**"]\n';
let cases = 0;
function check(text) {
  cases++;
  let model;
  try {
    model = historicalRegistry(text, "/tmp/archer-config-property");
  } catch (error) {
    assert(error instanceof TomlError || (error instanceof ProjectError && error.code === "manifest_error"));
    return;
  }
  assert(model.serviceName === undefined || /^[a-z0-9][a-z0-9-]{0,31}$/.test(model.serviceName));
  assert(Array.isArray(model.views) && model.views.length <= MAX_VIEWS);
  assert(Array.isArray(model.problems));
  assert.equal(new Set(model.views.map((view) => view.id)).size, model.views.length);
  for (const view of model.views) {
    assert(typeof view.title === "string");
    assert(typeof view.source === "string" && !view.source.startsWith("/") && !view.source.split("/").includes(".."));
  }
}
check(valid);
for (let round = 0; round < 1000; round++) {
  check(Array.from({ length: next() % 500 }, () => String.fromCharCode(next() % 65536)).join(""));
  check(Array.from({ length: next() % 60 }, () => vocabulary[next() % vocabulary.length]).join(""));
  const at = next() % valid.length;
  check(valid.slice(0, at) + vocabulary[next() % vocabulary.length] + valid.slice(at + (next() % 4)));
}
console.log(`project outcomes refused or valid: ${cases}`);
