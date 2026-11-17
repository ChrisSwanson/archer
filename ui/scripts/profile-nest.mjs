#!/usr/bin/env node
// Profiles one press of the nested view and prints where the time goes, as text an agent can read.
//
//   node scripts/profile-nest.mjs <diagram> <open> [from,from] [--strategy grow2] [--repeat 10] [--close] [--out dir]
//   e.g. node scripts/profile-nest.mjs tools/devkit/corpus/awkward/.archer/diagrams/flow-large.mmd g1 g0
//
// Bundles `profile-nest-run.mts` with esbuild (unminified, with a source map, packages left
// external) into node_modules/.cache/profile-nest/, runs it under `node --cpu-prof`, maps every
// frame back to its TypeScript file:line, then writes to --out (default
// $TMPDIR/profile-nest-<time>):
//   press.cpuprofile  open in https://speedscope.app or Chrome DevTools (Performance) as a flame graph
//   folded.txt        collapsed stacks ("a;b;c <µs>"), for flamegraph.pl or speedscope
//   summary.txt       the press's spans and counters, then the top 20 functions by self and by total time
// and prints summary.txt. Diagram paths are relative to the repository root.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceMap } from "node:module";
import { build } from "esbuild";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(ui, "..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt < 0 ? join(tmpdir(), `profile-nest-${Date.now()}`) : resolve(args[outAt + 1]);
const runArgs = outAt < 0 ? args : args.filter((_, i) => i !== outAt && i !== outAt + 1);
mkdirSync(out, { recursive: true });
rmSync(join(out, "press.cpuprofile"), { force: true });

const cache = join(ui, "node_modules/.cache/profile-nest");
const bundle = join(cache, "run.mjs");
await build({
  entryPoints: [join(ui, "scripts/profile-nest-run.mts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  sourcemap: "external",
  outfile: bundle,
  logLevel: "error",
  banner: {
    js: 'import { createRequire as __profileRequire } from "node:module"; const require = __profileRequire(import.meta.url);',
  },
});
const map = new SourceMap(JSON.parse(readFileSync(`${bundle}.map`, "utf8")));
const bundleUrl = pathToFileURL(bundle).href;

const run = spawnSync(
  process.execPath,
  [
    "--cpu-prof",
    "--cpu-prof-interval",
    "250",
    "--cpu-prof-dir",
    out,
    "--cpu-prof-name",
    "press.cpuprofile",
    bundle,
    ...runArgs,
  ],
  {
    cwd: ui,
    encoding: "utf8",
  },
);
if (run.status !== 0) {
  process.stderr.write(run.stderr || run.stdout);
  process.exit(run.status ?? 1);
}
const file = "press.cpuprofile";
const profile = JSON.parse(readFileSync(join(out, file), "utf8"));

const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const where = (frame) => {
  if (frame.url === bundleUrl) {
    const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
    if (entry?.originalSource)
      return `${resolve(cache, entry.originalSource.replace(/^file:\/\//, "")).replace(`${repo}/`, "")}:${entry.originalLine + 1}`;
  }
  const url = frame.url.replace(/^file:\/\//, "").replace(`${repo}/`, "");
  return url === "" ? "" : `${url}:${frame.lineNumber + 1}`;
};
const label = (node) => {
  const frame = node.callFrame;
  const at = where(frame);
  return `${frame.functionName || "(anonymous)"}${at ? ` ${at}` : ""}`;
};
const self = new Map();
const total = new Map();
const folded = new Map();
let sampled = 0;
profile.samples.forEach((id, index) => {
  // timeDeltas[i] is the interval that ends at samples[i].
  const dt = profile.timeDeltas[index] ?? 0;
  sampled += dt;
  const leaf = byId.get(id);
  self.set(label(leaf), (self.get(label(leaf)) ?? 0) + dt);
  const stack = [];
  const seen = new Set();
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const node = byId.get(at);
    if (node.callFrame.functionName === "(root)") break;
    const name = label(node);
    stack.push(name);
    if (!seen.has(name)) {
      seen.add(name);
      total.set(name, (total.get(name) ?? 0) + dt);
    }
  }
  const key = stack.reverse().join(";");
  folded.set(key, (folded.get(key) ?? 0) + dt);
});
writeFileSync(
  join(out, "folded.txt"),
  [...folded].map(([stack, us]) => `${stack} ${Math.round(us)}`).join("\n") + "\n",
);

const ms = (us) => (us / 1000).toFixed(1).padStart(8);
const pct = (us) => `${((us / sampled) * 100).toFixed(1).padStart(5)}%`;
const top = (map) =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, us]) => `${ms(us)} ms ${pct(us)}  ${name}`);
const summary = [
  run.stdout.trim(),
  "",
  `sampled ${(sampled / 1000).toFixed(0)} ms (setup included once; the press repeated)`,
  "",
  "top 20 by self time:",
  ...top(self),
  "",
  "top 20 by total time (inclusive):",
  ...top(total),
  "",
  `files: ${join(out, file)} (flame graph: speedscope.app or Chrome DevTools), ${join(out, "folded.txt")}`,
].join("\n");
writeFileSync(join(out, "summary.txt"), `${summary}\n`);
console.log(summary);
