// How long `simplifyRoutes` takes on the recorded real drawings (`tests/fixtures/route-simplify-golden.json.gz`):
// the pass that runs on the main thread after every ELK layout and every grow in place. A stopwatch, like
// `layout-bench.mjs`: it reads the median of several runs per drawing, to catch a pass gone super-linear, not a
// five percent difference. Run with `node bench/simplify-bench.mjs` from `ui/`.
//
// Options (environment):
//   ARCHER_BENCH_RUNS=9        runs per drawing (after one warm-up)
//   ARCHER_BENCH_MATCH=flow    only drawings whose name contains this

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.env.ARCHER_BENCH_RUNS ?? 9);
const match = process.env.ARCHER_BENCH_MATCH ?? "";
const cases = JSON.parse(
  gunzipSync(readFileSync(resolve(root, "tests/fixtures/route-simplify-golden.json.gz"))).toString("utf8"),
).filter((c) => c.name.includes(match));

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const { simplifyRoutes } = await server.ssrLoadModule("/src/layout/route-simplify.ts");
  console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${runs} runs`);
  console.log("");
  console.log("| drawing                                  | nodes | wires |  median ms |");
  console.log("|------------------------------------------|------:|------:|-----------:|");
  let total = 0;
  for (const c of cases) {
    const options = c.walls === undefined ? {} : { walls: c.walls };
    simplifyRoutes(c.input, options); // warm-up
    const times = [];
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      simplifyRoutes(c.input, options);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    total += median;
    const name = c.name.length > 40 ? `${c.name.slice(0, 37)}...` : c.name;
    console.log(
      `| ${name.padEnd(40)} | ${String(c.input.nodes.length).padStart(5)} | ${String(c.input.edges.length).padStart(5)} | ${median.toFixed(1).padStart(10)} |`,
    );
  }
  console.log(`| ${"all, summed".padEnd(40)} |       |       | ${total.toFixed(1).padStart(10)} |`);
} finally {
  await server.close();
}
