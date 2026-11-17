import { parentPort } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
const { gitRef, safeRelativePath } = await tsImport("../../src/accuracy/git.ts", import.meta.url);
const { coveragePatterns, coveredBy } = await tsImport("../../src/accuracy/coverage.ts", import.meta.url);
const { historicalRegistry } = await tsImport("../../src/project/project.ts", import.meta.url);
let seed = 947;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const vocabulary = [
  "src",
  "**",
  "*",
  "?",
  "/",
  ".",
  "..",
  ".git",
  "HEAD",
  "~",
  "^",
  "main",
  "--help",
  "\0",
  "\n",
  "version = 1\n",
  "[[views]]\n",
  "covers = [",
  '"src/**"',
  "]\n",
  'id = "flow"\n',
  'kind = "freeform"\n',
  'title = "Flow"\n',
  'source = ".archer/flow.mmd"\n',
];
const valid = [
  "HEAD~1",
  "main",
  "src/**",
  "src/foo.ts",
  'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\ncovers = ["src/**"]\n',
];
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
function inspect(text) {
  for (const [read, check] of [
    [gitRef, (value) => assert(value.length <= 256 && !value.startsWith("-") && !value.includes("\0"), "unsafe ref")],
    [safeRelativePath, (value) => assert(!value.split("/").includes("..") && !value.startsWith("/"), "unsafe path")],
    [
      (value) => coveragePatterns([value]),
      (value) => assert(typeof coveredBy("src/foo.ts", value) === "boolean", "invalid glob"),
    ],
    [
      (value) => historicalRegistry(value, "/tmp/project"),
      (value) =>
        assert(
          value.views.every((view) => !view.source.split("/").includes("..")),
          "unsafe historical path",
        ),
    ],
  ]) {
    try {
      check(read(text));
    } catch (error) {
      if (!["AccuracyError", "ProjectError", "TomlError"].includes(error.constructor.name)) throw error;
    }
  }
}
for (let corpus = 0; corpus < 3; corpus++)
  for (let i = 0; i < 1500; i++) {
    let text;
    if (corpus === 0)
      text = Array.from({ length: Math.floor(random() * 256) }, () =>
        String.fromCharCode(Math.floor(random() * 65536)),
      ).join("");
    else if (corpus === 1)
      text = Array.from(
        { length: Math.floor(random() * 40) },
        () => vocabulary[Math.floor(random() * vocabulary.length)],
      ).join("");
    else {
      const base = valid[Math.floor(random() * valid.length)],
        at = Math.floor(random() * base.length);
      text =
        base.slice(0, at) +
        vocabulary[Math.floor(random() * vocabulary.length)] +
        base.slice(at + Math.floor(random() * 3));
    }
    inspect(text);
  }
parentPort.postMessage({ cases: 4500, corpora: 3 });
