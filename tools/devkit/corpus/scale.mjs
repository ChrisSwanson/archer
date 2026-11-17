// Seeded scale corpus for the count gates (docs/proposals/performance-plan.md, slice 1).
//
//   node tools/devkit/corpus/scale.mjs <S|M|L> <outdir> [--seed N]     writes the corpus; prints its summary as JSON
//
// Sizes (one corpus = a directory of projects, the shape tools/devkit/sandbox.mjs copies):
//   S  today's corpus (tools/devkit/corpus: 3 projects, 25 views); copied, not generated.
//   M  250 views, 1,000 notes, 200 comment threads, over 3 projects.
//   L  1,000 views, 4,000 notes, over 8 projects: `big` has 257 views and 2,000 threads (past the 256-view
//      limit that saved state refuses), `dense` holds one diagram of 200 nodes and 400 labelled edges.
// Deterministic: the same size and seed give the same bytes (no clock, no randomness beyond the seeded
// generator below), so a count that moves between two runs is the product moving.
//
// Views: the first REGISTERED_PER_PROJECT diagrams of a project are listed in archer.toml (the registry holds at
// most 256); the rest are discovered in the Archer folder, like an agent's unregistered diagrams.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIZES = ["S", "M", "L"];
export const DEFAULT_SEED = 20261024;
export const REGISTERED_PER_PROJECT = 100;
/** Fixed so the files never depend on the clock. */
const STAMP = "2026-01-01T00:00:00.000Z";

/** mulberry32: a small seeded generator, enough for picking words and sizes. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["Gateway", "Billing", "Catalog", "Search", "Ledger", "Queue", "Cache", "Auth", "Orders", "Stock", "Mailer", "Reports", "Sync", "Router", "Scheduler", "Audit", "Pricing", "Cart", "Session", "Webhook"];
const VERBS = ["calls", "reads", "writes", "notifies", "queues", "polls", "signs", "streams"];
const TOPICS = ["retry policy", "ownership", "rollout", "failure modes", "data retention", "capacity", "naming", "access rules"];

const pick = (next, list) => list[Math.floor(next() * list.length)];
const pad = (n, width = 4) => String(n).padStart(width, "0");

/** A flowchart of `nodes` nodes and `edges` edges; edges carry ids (required) and, when `labelled`, a label. */
export function flowchart(next, nodes, edges, labelled, title) {
  const lines = [`flowchart LR`];
  if (title) lines.unshift(`%% ${title}`);
  for (let i = 0; i < nodes; i++) lines.push(`  n${i}[${pick(next, WORDS)} ${i}]`);
  for (let e = 0; e < edges; e++) {
    // A spine first so every node is connected, then seeded extra edges.
    const from = e < nodes - 1 ? e : Math.floor(next() * nodes);
    let to = e < nodes - 1 ? e + 1 : Math.floor(next() * nodes);
    if (to === from) to = (to + 1) % nodes;
    lines.push(`  n${from} e${e}@-->${labelled ? `|${pick(next, VERBS)} ${e}|` : ""} n${to}`);
  }
  return `${lines.join("\n")}\n`;
}

function note(next, index, diagramIds, withEmbedded) {
  const about = [diagramIds[index % diagramIds.length], diagramIds[(index * 7 + 1) % diagramIds.length]];
  const topic = pick(next, TOPICS);
  const body = [`---`, `diagrams: [${[...new Set(about)].join(", ")}]`, `---`, ``, `# Note ${index}: ${topic}`, ``,
    `This note records the ${topic} for ${pick(next, WORDS)} and ${pick(next, WORDS)}, with the reasons it was chosen.`, ``,
    `- ${pick(next, WORDS)} owns the ${topic}.`, `- ${pick(next, WORDS)} follows it.`, ``];
  if (withEmbedded) body.push("```mermaid", `%% archer-id: sketch`, flowchart(next, 3, 2, false).trimEnd(), "```", ``);
  return { text: body.join("\n"), quote: `records the ${topic}` };
}

function threadFile(target, anchors, ids, next) {
  const threads = anchors.map((anchor, i) => {
    const pickStatus = next();
    const status = pickStatus < 0.5 ? "sent" : pickStatus < 0.8 ? "draft" : "answered";
    const comments = [{ id: `c${i}a`, author: "person", body: `Question ${ids.counter++} about this part: why is it done this way?`, createdAt: STAMP }];
    if (status === "answered") comments.push({ id: `c${i}b`, author: "agent", body: "It follows the retry policy decided earlier.", createdAt: STAMP });
    return { id: `thr_${pad(ids.counter++, 8)}`, target, anchor, status, revision: 1, comments };
  });
  return `${JSON.stringify({ version: 2, target, threads }, null, 2)}\n`;
}

/** The plan for one project: {name, files: {path: text}, counts}. Pure. */
export function planProject({ name, views, notes, threads, seed, dense = false }) {
  const next = rng(seed);
  const files = {};
  const ids = [];
  const diagramFiles = [];
  for (let i = 0; i < views; i++) {
    const id = `d${pad(i)}`;
    ids.push(id);
    const isDense = dense && i === 0;
    const nodes = isDense ? 200 : 3 + Math.floor(next() * 7);
    const edges = isDense ? 400 : nodes + Math.floor(next() * 3);
    diagramFiles.push(id);
    files[`.archer/diagrams/${id}.mmd`] = flowchart(next, nodes, edges, isDense, isDense ? "Dense diagram: 200 nodes, 400 labelled edges" : undefined);
  }
  const noteQuotes = [];
  for (let i = 0; i < notes; i++) {
    const made = note(next, i, ids, i % 10 === 5);
    files[`.archer/notes/n${pad(i)}.md`] = made.text;
    noteQuotes.push(made.quote);
  }
  // Threads spread over views and notes, a few per target, in a sidecar beside each target.
  const targets = [];
  for (let i = 0; i < views; i++) targets.push({ kind: "view", index: i });
  for (let i = 0; i < notes; i++) targets.push({ kind: "note", index: i });
  const perTarget = new Map();
  for (let t = 0; t < threads && targets.length > 0; t++) {
    const target = targets[Math.floor(next() * targets.length)];
    const key = `${target.kind}:${target.index}`;
    perTarget.set(key, [...(perTarget.get(key) ?? []), target]);
  }
  const counter = { counter: 1 };
  for (const [key, list] of [...perTarget].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const { kind, index } = list[0];
    if (kind === "view") {
      const id = ids[index];
      files[`.archer/diagrams/${id}.comments.json`] = threadFile(`view:${id}`, list.map(() => ({ kind: "view" })), counter, next);
    } else {
      files[`.archer/notes/n${pad(index)}.comments.json`] = threadFile(`note:notes/n${pad(index)}.md`, list.map(() => ({ kind: "passage", quote: noteQuotes[index], prefix: "", suffix: "" })), counter, next);
    }
  }
  const registered = Math.min(views, REGISTERED_PER_PROJECT);
  const toml = [`version = 1`, `name = "${name}"`, `folder = ".archer"`, ``];
  for (let i = 0; i < registered; i++) toml.push(`[[views]]`, `id = "${ids[i]}"`, `kind = "freeform"`, `title = "${name} diagram ${i}"`, `source = ".archer/diagrams/${ids[i]}.mmd"`, ``);
  files["archer.toml"] = toml.join("\n");
  return { name, files, counts: { views, notes, threads: [...perTarget.values()].reduce((a, l) => a + l.length, 0) } };
}

/** Project shapes per size. Seeds differ per project so each reads differently. */
export const SHAPES = {
  M: [
    { name: "alpha", views: 150, notes: 600, threads: 120 },
    { name: "beta", views: 70, notes: 300, threads: 60 },
    { name: "gamma", views: 30, notes: 100, threads: 20 },
  ],
  L: [
    { name: "big", views: 257, notes: 1000, threads: 2000 },
    { name: "dense", views: 31, notes: 100, threads: 40, dense: true },
    { name: "p1", views: 120, notes: 500, threads: 60 },
    { name: "p2", views: 120, notes: 500, threads: 60 },
    { name: "p3", views: 120, notes: 500, threads: 60 },
    { name: "p4", views: 120, notes: 500, threads: 60 },
    { name: "p5", views: 120, notes: 500, threads: 60 },
    { name: "p6", views: 112, notes: 400, threads: 60 },
  ],
};

/** The whole plan for M or L: [{name, files, counts}]. Pure and deterministic. */
export function planCorpus(size, seed = DEFAULT_SEED, { bigViews } = {}) {
  // `bigViews` shrinks L's 257-view project, for quick local runs.
  const shapes = (SHAPES[size] ?? []).map((shape) => (shape.name === "big" && bigViews !== undefined ? { ...shape, views: bigViews } : shape));
  if (shapes.length === 0) throw new Error(`no generated corpus for size ${size} (have ${Object.keys(SHAPES).join(", ")}; S is the stock corpus)`);
  return shapes.map((shape, i) => planProject({ ...shape, seed: seed + i * 7919 }));
}

/** Totals of a plan, for reports and tests. */
export function summarise(plan) {
  return { projects: plan.length, views: plan.reduce((a, p) => a + p.counts.views, 0), notes: plan.reduce((a, p) => a + p.counts.notes, 0), threads: plan.reduce((a, p) => a + p.counts.threads, 0) };
}

/** Writes the corpus for `size` into `dir` (emptied first). S copies the stock corpus. Returns its summary. */
export function writeCorpus(size, dir, seed = DEFAULT_SEED, options = {}) {
  const out = resolve(dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (size === "S") {
    for (const name of ["awkward", "journeys", "pageturner"]) cpSync(join(HERE, name), join(out, name), { recursive: true });
    return { size, projects: 3, views: 25 };
  }
  const plan = planCorpus(size, seed, options);
  for (const project of plan) {
    for (const [path, text] of Object.entries(project.files)) {
      const target = join(out, project.name, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  return { size, ...summarise(plan) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [size, dir, flag, value] = process.argv.slice(2);
  if (!SIZES.includes(size) || !dir) { process.stderr.write("usage: node tools/devkit/corpus/scale.mjs <S|M|L> <outdir> [--seed N]\n"); process.exit(2); }
  const seed = flag === "--seed" ? Number(value) : DEFAULT_SEED;
  if (!existsSync(HERE)) process.exit(2);
  process.stdout.write(`${JSON.stringify(writeCorpus(size, dir, seed))}\n`);
}
