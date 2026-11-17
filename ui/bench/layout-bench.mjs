// Layout baselines: how long the two layout passes take at 10, 100 and 1000
// elements. Run with `npm run bench:ui` from the repository root.
//
// This is a stopwatch, not a benchmark framework. Its job is to catch an
// order-of-magnitude regression or a pass that has gone super-linear -- it
// prints the time per element next to each size so that the growth can be read
// straight off the table -- not to resolve a five percent difference. The
// numbers recorded from it live in docs/performance-baselines.md.
//
// It runs the production modules: Vite loads `src/layout/*.ts` exactly as the
// build would, so there is no second copy of the layout to drift from the
// first. Nothing here is imported by the app or by the test suite.
//
// Options (environment):
//   ARCHER_BENCH_SIZES=10,100,1000   element counts to measure
//   ARCHER_BENCH_NESTING=8,24,64,256 group nesting depths to measure
//   ARCHER_BENCH_JSON=path           also write the raw numbers as JSON

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sizes = (process.env.ARCHER_BENCH_SIZES ?? "10,100,1000").split(",").map(Number);
const DIRECTIONS = ["tb", "bt", "lr", "rl"];

// ---------------------------------------------------------------------------
// Corpus: a layered architecture graph with groups, and a request/response
// trace with fragments and notes. `elements` counts everything with an identity.
// ---------------------------------------------------------------------------

/** A graph of `elements` nodes, edges and groups: roughly 45% / 45% / 10%. */
function graph(elements, direction) {
  const groupCount = Math.max(1, Math.round(elements / 20));
  const nodeCount = Math.max(2, Math.round((elements - groupCount) / 2));
  const edgeCount = Math.max(1, elements - groupCount - nodeCount);
  const groups = Array.from({ length: groupCount }, (_, i) => ({
    id: `g${i}`,
    label: `Group ${i}`,
    // Every fourth group sits inside the one before it.
    parentId: i % 4 === 3 ? `g${i - 1}` : undefined,
  }));
  const shapes = ["rectangle", "rounded", "stadium", "circle", "diamond", "cylinder", "hexagon", "subroutine"];
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    label: `Service ${i} (v${i % 7})`,
    shape: shapes[i % shapes.length],
    classes: i % 3 === 0 ? ["system"] : [],
    groupId: `g${i % groupCount}`,
  }));
  const edges = Array.from({ length: edgeCount }, (_, i) => {
    const source = i % nodeCount;
    // A chain, with every other edge a longer hop, so the graph is layered
    // and has crossings to minimise.
    const target = i % 2 === 0 ? (source + 1) % nodeCount : (source * 7 + 3) % nodeCount;
    return {
      id: `e${i}`,
      source: `n${source}`,
      target: `n${target}`,
      label: i % 3 === 0 ? `calls ${i}` : undefined,
      ...(i % 5 === 0 ? { line: "dotted" } : {}),
    };
  });
  return {
    viewId: "bench",
    kind: "freeform",
    title: "Bench",
    revision: "sha256:bench",
    modelType: "freeform-graph",
    direction,
    nodes,
    edges,
    groups,
  };
}

/** A chain of `depth` groups, each inside the last, around two connected nodes. */
function nestedGraph(depth) {
  const groups = Array.from({ length: depth }, (_, i) => ({
    id: `g${i}`,
    label: `Level ${i}`,
    parentId: i === 0 ? undefined : `g${i - 1}`,
  }));
  const inner = `g${depth - 1}`;
  return {
    viewId: "bench",
    kind: "freeform",
    title: "Bench",
    revision: "sha256:bench",
    modelType: "freeform-graph",
    direction: "tb",
    nodes: [
      { id: "a", label: "A", shape: "rectangle", classes: [], groupId: inner },
      { id: "b", label: "B", shape: "rectangle", classes: [], groupId: undefined },
    ],
    edges: [{ id: "e", source: "b", target: "a", label: "calls" }],
    groups,
  };
}

/**
 * A trace of `elements` participants, messages, fragments and notes.
 *
 * `participantCount` is separate so the column pass can be measured against
 * the number of lifelines as well as against the number of messages, and
 * `everyMessageSpansTheDiagram` sends each message from the first lifeline to
 * the last, which is the worst case for that pass.
 */
function sequence(
  elements,
  participantCount = Math.min(20, Math.max(2, Math.round(elements / 10))),
  everyMessageSpansTheDiagram = false,
) {
  const participants = Array.from({ length: participantCount }, (_, i) => ({
    id: `p${i}`,
    label: `Participant ${i}`,
    ...(i % 5 === 0 ? { kind: "actor" } : {}),
  }));
  let remaining = Math.max(1, elements - participantCount);
  let message = 0;
  let fragment = 0;
  let note = 0;
  const nextMessage = () => {
    const from = everyMessageSpansTheDiagram ? 0 : message % participantCount;
    // Mostly neighbours, with every seventh message spanning the diagram.
    const to = everyMessageSpansTheDiagram
      ? participantCount - 1
      : message % 7 === 0
        ? (from + participantCount - 1) % participantCount
        : (from + 1) % participantCount;
    remaining -= 1;
    return {
      type: "message",
      id: `msg-${message++}`,
      from: `p${from}`,
      to: `p${to}`,
      label: `request ${message} /resource?id=${message}`,
      kind: message % 3 === 0 ? "reply" : "sync",
    };
  };
  const events = [];
  while (remaining > 0) {
    if (message % 10 === 9 && remaining > 4) {
      remaining -= 1;
      events.push({
        type: "fragment",
        id: `frag-${fragment++}`,
        kind: fragment % 2 === 0 ? "alt" : "loop",
        label: `while condition ${fragment}`,
        sections: [{ label: `while condition ${fragment}`, events: [nextMessage(), nextMessage(), nextMessage()] }],
      });
    } else if (message % 15 === 14 && remaining > 1) {
      remaining -= 1;
      events.push({
        type: "note",
        id: `note-${note++}`,
        position: "over",
        participants: [`p${message % participantCount}`],
        text: `note ${note}, the cache is warm here`,
      });
      events.push(nextMessage());
    } else {
      events.push(nextMessage());
    }
  }
  return {
    viewId: "bench",
    kind: "sequence",
    title: "Bench",
    revision: "sha256:bench",
    modelType: "sequence-trace",
    participants,
    events,
    autonumber: true,
  };
}

// ---------------------------------------------------------------------------
// Stopwatch.
// ---------------------------------------------------------------------------

/**
 * The median wall time of `run`, in milliseconds.
 *
 * One untimed call first, so module initialisation and the JIT's first pass
 * are not charged to the smallest size. Then as many timed calls as fit in
 * about a second, at least three and at most fifty.
 */
async function measure(run) {
  await run();
  const samples = [];
  const started = performance.now();
  while (samples.length < 3 || (samples.length < 50 && performance.now() - started < 1000)) {
    const before = performance.now();
    await run();
    samples.push(performance.now() - before);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], min: samples[0], runs: samples.length };
}

const results = [];
function report(name, elements, timing, extra = "") {
  const perElement = (timing.median * 1000) / elements;
  results.push({ name, elements, medianMs: timing.median, minMs: timing.min, runs: timing.runs });
  console.log(
    `| ${name.padEnd(34)} | ${String(elements).padStart(8)} | ${timing.median.toFixed(3).padStart(10)} | ${perElement
      .toFixed(1)
      .padStart(12)} | ${String(timing.runs).padStart(4)} |${extra}`,
  );
}

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const { computeLayout } = await server.ssrLoadModule("/src/layout/elk-adapter.ts");
  const { computeSequenceLayout } = await server.ssrLoadModule("/src/layout/sequence-layout.ts");

  console.log(`node ${process.version}, ${process.platform}/${process.arch}`);
  console.log("");
  console.log("| layout                             | elements |  median ms | us / element | runs |");
  console.log("|------------------------------------|----------|------------|--------------|------|");

  // ELK is a large module and the first few layouts pay for compiling it.
  // Without this the first direction measured looks slower than the others.
  for (let warmUp = 0; warmUp < 5; warmUp += 1) {
    await computeLayout(graph(100, "tb"));
  }

  for (const direction of DIRECTIONS) {
    for (const size of sizes) {
      const view = graph(size, direction);
      report(`graph (ELK), direction ${direction}`, size, await measure(() => computeLayout(view)));
    }
  }

  for (const size of sizes) {
    const trace = sequence(size);
    report("sequence", size, await measure(async () => computeSequenceLayout(trace)));
  }

  // The column pass walks every lifeline a message crosses, so its cost is
  // messages x lifelines in the worst case. Hold the messages still, send
  // every one across the whole diagram, and grow the lifelines to see that
  // factor on its own.
  for (const participants of [10, 100, 1000]) {
    const trace = sequence(1000 + participants, participants, true);
    report(
      `sequence, 1000 msgs across ${participants}`,
      1000 + participants,
      await measure(async () => computeSequenceLayout(trace)),
    );
  }

  // Group nesting is recursion: in ELK and in the adapter's own walk. The
  // parser bounds how deep a source may nest; this is what that bound buys.
  for (const depth of (process.env.ARCHER_BENCH_NESTING ?? "8,24,64,256").split(",").map(Number)) {
    const view = nestedGraph(depth);
    try {
      report(`graph (ELK), ${depth} nested groups`, depth + 3, await measure(() => computeLayout(view)));
    } catch (error) {
      console.log(`| graph (ELK), ${depth} nested groups: ${String(error).slice(0, 80)}`);
      results.push({ name: `graph (ELK), ${depth} nested groups`, error: String(error) });
    }
  }

  if (process.env.ARCHER_BENCH_JSON) {
    writeFileSync(process.env.ARCHER_BENCH_JSON, `${JSON.stringify(results, null, 2)}\n`);
  }
} finally {
  await server.close();
}
