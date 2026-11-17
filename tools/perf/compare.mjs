#!/usr/bin/env node
// Archer paired timing comparison (performance rubric G4/§5 "Timing estimator"): the last release A against the
// candidate B, each served by its own fresh devkit sandbox started from its own tree, measured in pairs run back
// to back in a seeded random order, with the median of the differences B − A and a 95% bootstrap interval per
// metric. --aa runs the candidate against itself (two sandboxes from one tree) to get the floor.
//
//   node tools/perf/compare.mjs --out <dir> (--aa | --a <commit|worktree> [--b <commit|worktree>] --floor-from <aa compare.json>)
//        [--page projects] [--state cold|warm] [--profile default] [--metrics lcpMs,wallMs] [--pairs 10]
//        [--seed <n|text>] [--resamples 10000] [--floor lcpMs=20,wallMs=35] [--confirm] [--seed-fault-b <ms>]
//        [--names perf-cmp-a,perf-cmp-b] [--trees-dir <dir>] [--keep-trees] [--timeout 60000]
//
// Sides. B defaults to this worktree. A commit is checked out as a detached worktree under --trees-dir (default
// $TMPDIR/archer-perf-compare-trees/<sha12>), with `npm ci` and `npm --workspace ui run build`; a tree already
// there at that commit is reused; only a tree this run made is removed at the end (unless --keep-trees). Each side
// gets one sandbox from that tree's own tools/devkit/sandbox.mjs (fresh, the awkward corpus, the production page).
// Every run uses THIS worktree's tools/perf/page-load.mjs, so the instrument is the same on both sides:
//   page-load.mjs --base <origin> --login <link> --project awkward --pages <page> --profiles <profile> --runs 1
// and reads `results[].metrics.<name>` of <page>/<profile>/<state>. A metric missing from any run of a round is
// NOT EVALUATED. One unmeasured load per side warms the service caches first (the rubric's "cold").
// Sample size (§5): 10 pairs, +5 while a metric's interval straddles its floor, up to 30; still straddling at 30 is
// inconclusive (NOT EVALUATED). --aa runs a fixed --pairs (default 10) and writes `floors` for --floor-from.
// --confirm: when a metric regressed (or improved), the whole comparison runs again on fresh sandboxes, and only a
// repeat counts (lib/compare.mjs confirm()).
// --seed-fault-b <ms>: a seeded failing case. B's origin becomes a small local HTTP proxy in front of sandbox B
// that holds every document request (`Sec-Fetch-Dest: document`) for <ms> before forwarding; everything else
// passes straight through (streams included).
// Quiet host (§5): `ps` (other build, lab, test or agent processes), load per core and /proc/pressure/{cpu,memory,io}
// are recorded before and after. A host that is not quiet is reported, and every verdict's rubric status is then
// NOT EVALUATED (§3); the statistical verdict is still shown.
// Writes <out>/compare.json and <out>/compare.md; each run's page-load output is kept under <out>/runs/.
// Exit 0; 1 when any metric's final verdict is regressed (or a confirmed regression with --confirm); 2 on errors.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, createServer, Agent } from "node:http";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  FIRST_PAIRS,
  MAX_PAIRS,
  NOT_EVALUATED,
  assess,
  confirm,
  floorFromAA,
  mulberry32,
  pairedEstimate,
  seedOf,
} from "./lib/compare.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PAGE_LOAD = join(HERE, "page-load.mjs");
const SCHEMA = "archer-perf-compare/1";
const RUN_TIMEOUT_MS = 180_000;

/** Redacts access tokens: `token=…` query values and bare 32/64-hex runs. */
export const redact = (text) =>
  String(text)
    .replace(/(token=)[^&\s"']+/gi, "$1…")
    .replace(/\b[0-9a-f]{32}(?:[0-9a-f]{32})?\b/gi, "…");

function options() {
  const { values } = parseArgs({
    options: {
      a: { type: "string" },
      b: { type: "string" },
      aa: { type: "boolean" },
      out: { type: "string" },
      page: { type: "string", default: "projects" },
      state: { type: "string", default: "cold" },
      profile: { type: "string", default: "default" },
      metrics: { type: "string", default: "lcpMs,wallMs" },
      pairs: { type: "string" },
      seed: { type: "string" },
      resamples: { type: "string", default: "10000" },
      floor: { type: "string" },
      "floor-from": { type: "string" },
      confirm: { type: "boolean" },
      "seed-fault-b": { type: "string" },
      names: { type: "string", default: "perf-cmp-a,perf-cmp-b" },
      "trees-dir": { type: "string" },
      "keep-trees": { type: "boolean" },
      timeout: { type: "string", default: "60000" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.out || (!values.aa && !values.a)) {
    process.stderr.write(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 30)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n") + "\n",
    );
    process.exit(values.help ? 0 : 2);
  }
  if (values.aa && values.a)
    throw new Error("--aa runs the candidate (--b, default this worktree) against itself; leave out --a");
  if (!["cold", "warm"].includes(values.state)) throw new Error("--state is cold or warm");
  const names = values.names.split(",").map((n) => n.trim());
  if (names.length !== 2 || names[0] === names[1]) throw new Error("--names takes two different sandbox names");
  const metrics = values.metrics
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const fault = values["seed-fault-b"] === undefined ? 0 : Number(values["seed-fault-b"]);
  if (!(fault >= 0)) throw new Error("--seed-fault-b takes a delay in ms");
  return {
    ...values,
    metrics,
    names,
    fault,
    out: resolve(values.out),
    pairs: values.pairs === undefined ? FIRST_PAIRS : Math.max(1, Number(values.pairs) || FIRST_PAIRS),
    seed: values.seed ?? String(randomInt(1, 2 ** 31)),
    resamples: Math.max(100, Number(values.resamples) || 10000),
    treesDir: resolve(values["trees-dir"] ?? join(tmpdir(), "archer-perf-compare-trees")),
  };
}

// ---------------------------------------------------------------------------------------------------- trees

const git = (args, cwd = REPO) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

function step(label, command, args, cwd) {
  process.stderr.write(`compare: ${label} (${cwd})\n`);
  const r = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${label} failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
}

/** Where a side runs from: a worktree path as given, or a detached worktree of a commit (made or reused). */
function resolveTree(spec, treesDir) {
  if (spec === undefined) return { spec: "(this worktree)", tree: REPO, made: false };
  const asPath = resolve(spec);
  if (existsSync(join(asPath, "tools/devkit/sandbox.mjs"))) return { spec, tree: asPath, made: false };
  const sha = git(["rev-parse", "--verify", `${spec}^{commit}`]);
  const tree = join(treesDir, sha.slice(0, 12));
  let made = false;
  if (existsSync(tree)) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).stdout?.trim();
    if (head !== sha)
      throw new Error(`${tree} exists but is not a worktree at ${sha}; move it away or pass --trees-dir`);
    process.stderr.write(`compare: reusing ${tree}\n`);
  } else {
    mkdirSync(treesDir, { recursive: true });
    step(`git worktree add --detach ${sha.slice(0, 12)}`, "git", ["worktree", "add", "--detach", tree, sha], REPO);
    made = true;
  }
  if (!existsSync(join(tree, "node_modules"))) step("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], tree);
  if (!existsSync(join(tree, "ui/dist/index.html")))
    step("npm --workspace ui run build", "npm", ["--workspace", "ui", "run", "build"], tree);
  return { spec, tree, made };
}

function treeIdentity(tree) {
  const commit = git(["rev-parse", "HEAD"], tree);
  const status = git(["status", "--porcelain"], tree);
  const diff =
    spawnSync("git", ["diff", "HEAD"], { cwd: tree, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";
  const page = join(tree, "ui/dist/index.html");
  return {
    commit,
    dirtyFiles: status ? status.split("\n").length : 0,
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    pageSha256: existsSync(page) ? createHash("sha256").update(readFileSync(page)).digest("hex") : null,
  };
}

// ---------------------------------------------------------------------------------------------------- sandboxes

function sandbox(tree, args) {
  const r = spawnSync(process.execPath, [join(tree, "tools/devkit/sandbox.mjs"), ...args], {
    cwd: tree,
    encoding: "utf8",
  });
  if (r.status !== 0)
    throw new Error(`sandbox ${args.join(" ")} (${tree}): ${redact((r.stderr || r.stdout).slice(-2000))}`);
  return r.stdout;
}

function sandboxUp(tree, name) {
  const out = sandbox(tree, ["up", "--name", name]);
  const record = JSON.parse(
    out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .pop(),
  );
  return { name, tree, origin: record.origin, link: record.link, pid: record.pid, page: record.page };
}

const sandboxDown = (s) => {
  try {
    sandbox(s.tree, ["down", "--name", s.name]);
  } catch (error) {
    process.stderr.write(`compare: ${error.message}\n`);
  }
};

/**
 * A local HTTP proxy in front of `target` that holds each document request for `delayMs` (the seeded fault).
 * Host and Origin are rewritten to the target's, a Location pointing at the target is pointed back at the proxy.
 * @returns {Promise<{origin: string, close: () => Promise<void>, delayed: () => number}>}
 */
export function delayProxy(target, delayMs) {
  const t = new URL(target),
    agent = new Agent({ keepAlive: true, maxSockets: 64 });
  let delayed = 0,
    origin = "";
  const server = createServer((req, res) => {
    const forward = () => {
      const headers = { ...req.headers, host: t.host };
      if (headers.origin === origin) headers.origin = t.origin;
      if (typeof headers.referer === "string" && headers.referer.startsWith(origin))
        headers.referer = t.origin + headers.referer.slice(origin.length);
      const up = httpRequest(
        { host: t.hostname, port: t.port, method: req.method, path: req.url, headers, agent },
        (r) => {
          const out = { ...r.headers };
          if (typeof out.location === "string" && out.location.startsWith(t.origin))
            out.location = origin + out.location.slice(t.origin.length);
          res.writeHead(r.statusCode ?? 502, out);
          r.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on("close", () => up.destroy());
      req.pipe(up);
    };
    if (req.headers["sec-fetch-dest"] === "document" && delayMs > 0) {
      delayed++;
      setTimeout(forward, delayMs);
    } else forward();
  });
  return new Promise((resolveProxy) =>
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolveProxy({
        origin,
        delayed: () => delayed,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
            agent.destroy();
          }),
      });
    }),
  );
}

// ---------------------------------------------------------------------------------------------------- host evidence

const AGENT = /^(claude|codex)$/i,
  BROWSER = /^(chrome|chromium|headless_shell|chrome-headless-shell)$/i,
  SHELL = /^(ba|z|da)?sh$/;
const LAB =
  /(vitest|playwright|jest|\btsc\b|\bvite\b|esbuild|rollup|webpack|page-load\.mjs|smoke\.mjs|release-check|sandbox\.mjs|archer\.ts serve|\bcargo\b|\brustc\b|\bcc1|\bnpm (ci|run|test|exec)\b)/;

/** What kind of other load a process is (null: none): agent, browser, build/test/lab, or busy (≥ 50% CPU). */
export function loadKind({ args, pcpu }) {
  const exe = (args.split(/\s+/, 1)[0] ?? "").split("/").pop();
  if (AGENT.test(exe)) return "agent";
  if (BROWSER.test(exe)) return "browser";
  if (!SHELL.test(exe) && LAB.test(args)) return "build/test/lab";
  return pcpu >= 50 ? "busy" : null;
}

function processTable() {
  const r = spawnSync("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,etimes=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pcpu: +m[3], rssMb: Math.round(+m[4] / 1024), etimes: +m[5], args: m[6] }));
}

/** §5 quiet-host evidence. `mine` are pids this run started (sandboxes); they, their children, this process's own
 * children and its ancestors (the shell or agent that launched it) are not counted as other load. */
export function hostEvidence(mine = []) {
  const table = processTable(),
    byPid = new Map(table.map((p) => [p.pid, p]));
  const own = new Set([process.pid, ...mine]),
    ancestors = new Set();
  let grew = true; // descendants of this process and of its sandboxes
  while (grew) {
    grew = false;
    for (const p of table)
      if (!own.has(p.pid) && own.has(p.ppid)) {
        own.add(p.pid);
        grew = true;
      }
  }
  for (let p = byPid.get(process.pid)?.ppid; p && !ancestors.has(p); p = byPid.get(p)?.ppid) ancestors.add(p);
  const others = table
    .filter((p) => !own.has(p.pid) && !ancestors.has(p.pid) && !/^ps -eo/.test(p.args))
    .map((p) => ({ ...p, kind: loadKind(p) }))
    .filter((p) => p.kind);
  const kinds = {};
  for (const p of others) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  const pressure = {};
  for (const kind of ["cpu", "memory", "io"]) {
    try {
      pressure[kind] = Object.fromEntries(
        readFileSync(`/proc/pressure/${kind}`, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const [scope, ...fields] = line.split(" ");
            return [scope, Object.fromEntries(fields.map((f) => f.split("=")).map(([k, v]) => [k, Number(v)]))];
          }),
      );
    } catch {
      pressure[kind] = null;
    }
  }
  const cores = cpus().length,
    load = loadavg(),
    perCore = load.map((l) => +(l / cores).toFixed(3));
  const reasons = [];
  if (others.length)
    reasons.push(
      `other processes: ${Object.entries(kinds)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ")}`,
    );
  if (perCore[0] >= 0.5) reasons.push(`1-min load per core ${perCore[0]} ≥ 0.5`);
  if ((pressure.cpu?.some?.avg10 ?? 0) >= 5) reasons.push(`cpu pressure avg10 ${pressure.cpu.some.avg10}% ≥ 5%`);
  return {
    at: new Date().toISOString(),
    cores,
    loadavg: load,
    loadPerCore: perCore,
    pressure,
    quiet: reasons.length === 0,
    reasons,
    otherProcesses: kinds,
    sample: others
      .slice(0, 40)
      .map((p) => ({ pid: p.pid, kind: p.kind, pcpu: p.pcpu, rssMb: p.rssMb, args: redact(p.args).slice(0, 160) })),
  };
}

// ---------------------------------------------------------------------------------------------------- runs

/** One page-load run against one side; resolves to {metrics: {name: number|null}, note?}. */
function runOnce(side, opts, dir) {
  mkdirSync(dir, { recursive: true });
  const args = [
    PAGE_LOAD,
    "--base",
    side.origin,
    "--login",
    side.link,
    "--project",
    "awkward",
    "--pages",
    opts.page,
    "--profiles",
    opts.profile,
    "--runs",
    "1",
    "--out",
    dir,
    "--timeout",
    opts.timeout,
  ];
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => {
      log += d;
    });
    child.stderr.on("data", (d) => {
      log += d;
    });
    const killer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      writeFileSync(join(dir, "page-load.log"), redact(log));
      const metrics = Object.fromEntries(opts.metrics.map((m) => [m, null]));
      let report;
      try {
        report = JSON.parse(readFileSync(join(dir, "perf-report.json"), "utf8"));
      } catch {
        return resolveRun({ metrics, note: `no perf-report.json (exit ${code})` });
      }
      const row = report.results?.find(
        (r) => r.page === opts.page && r.profile === opts.profile && r.state === opts.state,
      );
      if (!row || row.error || !row.metrics)
        return resolveRun({ metrics, note: row?.error ?? `no ${opts.page}/${opts.profile}/${opts.state} row` });
      for (const m of opts.metrics)
        metrics[m] = typeof row.metrics[m] === "number" && Number.isFinite(row.metrics[m]) ? row.metrics[m] : null;
      // An incomplete row (timeout, empty page) is no valid evidence (§3): its values are kept, the note marks it.
      resolveRun({ metrics, ...(row.note ? { note: row.note } : {}), ...(code !== 0 ? { exit: code } : {}) });
    });
  });
}

/** Start both sides' sandboxes (and the fault proxy on B). */
/** Sandboxes up right now, torn down on Ctrl-C too. */
const ACTIVE = new Set();

async function startSides(trees, opts) {
  const a = sandboxUp(trees.A.tree, opts.names[0]);
  ACTIVE.add(a);
  let b;
  try {
    b = sandboxUp(trees.B.tree, opts.names[1]);
    ACTIVE.add(b);
  } catch (error) {
    sandboxDown(a);
    ACTIVE.delete(a);
    throw error;
  }
  const sides = { A: { ...a }, B: { ...b } };
  if (opts.fault > 0) {
    const proxy = await delayProxy(b.origin, opts.fault);
    sides.B = {
      ...b,
      origin: proxy.origin,
      link: b.link.replace(b.origin, proxy.origin),
      sandboxOrigin: b.origin,
      proxy,
    };
  }
  return sides;
}

async function stopSides(sides) {
  if (sides.B.proxy) await sides.B.proxy.close();
  for (const s of [sides.A, sides.B]) {
    sandboxDown(s);
    for (const x of ACTIVE) if (x.name === s.name && x.tree === s.tree) ACTIVE.delete(x);
  }
}

/** One comparison round on fresh sandboxes: warm-up, then pairs until no metric straddles (or the cap). */
async function round(index, trees, opts, floors) {
  const sides = await startSides(trees, opts);
  const host = { before: hostEvidence([sides.A.pid, sides.B.pid]) };
  const random = mulberry32(seedOf(`${opts.seed}:order:${index}`));
  const dir = join(opts.out, "runs", `round${index}`);
  const pairs = [];
  let target = opts.aa ? opts.pairs : FIRST_PAIRS,
    estimates = {};
  try {
    for (const s of ["A", "B"]) await runOnce(sides[s], opts, join(dir, `warmup-${s}`));
    for (;;) {
      while (pairs.length < target) {
        const i = pairs.length + 1,
          order = random() < 0.5 ? ["A", "B"] : ["B", "A"],
          pair = { i, order: order.join("") };
        for (const s of order)
          pair[s] = await runOnce(sides[s], opts, join(dir, `pair${String(i).padStart(2, "0")}-${s}`));
        pairs.push(pair);
        process.stderr.write(
          `compare: round ${index} pair ${i} ${pair.order} ${opts.metrics.map((m) => `${m} A=${pair.A.metrics[m]} B=${pair.B.metrics[m]}`).join(" ")}\n`,
        );
      }
      estimates = estimate(pairs, opts, floors);
      const more = Object.values(estimates)
        .map((e) => e.next)
        .filter((n) => typeof n === "number");
      if (opts.aa || more.length === 0) break;
      target = Math.min(MAX_PAIRS, Math.max(...more));
    }
  } finally {
    host.after = hostEvidence([sides.A.pid, sides.B.pid]);
    if (sides.B.proxy) host.delayedDocuments = sides.B.proxy.delayed();
    await stopSides(sides);
  }
  const sideInfo = Object.fromEntries(
    ["A", "B"].map((s) => [
      s,
      {
        sandbox: sides[s].name,
        origin: sides[s].sandboxOrigin ?? sides[s].origin,
        ...(sides[s].proxy ? { proxyOrigin: sides[s].origin, documentDelayMs: opts.fault } : {}),
        page: sides[s].page,
      },
    ]),
  );
  return {
    round: index,
    sides: sideInfo,
    pairs: pairs.map((p) => ({ i: p.i, order: p.order, A: p.A, B: p.B })),
    estimates,
    host,
  };
}

/** Per metric: the paired estimate and its assessment against the floor. */
function estimate(pairs, opts, floors) {
  const out = {};
  for (const m of opts.metrics) {
    const incomplete = pairs.filter((p) => p.A.note || p.B.note).map((p) => p.i);
    const missing = pairs.filter((p) => p.A.metrics[m] === null || p.B.metrics[m] === null).map((p) => p.i);
    if (missing.length || incomplete.length) {
      out[m] = {
        n: pairs.length,
        verdict: "missing",
        status: NOT_EVALUATED,
        next: null,
        reason: missing.length
          ? `${m} missing in pair(s) ${missing.join(", ")}`
          : `incomplete row in pair(s) ${incomplete.join(", ")}`,
      };
      continue;
    }
    const e = pairedEstimate(
      pairs.map((p) => ({ a: p.A.metrics[m], b: p.B.metrics[m] })),
      { resamples: opts.resamples, seed: `${opts.seed}:${m}` },
    );
    const { differences, ...summary } = e;
    out[m] = opts.aa
      ? { ...summary, differences, floor: floorFromAA(e) }
      : { ...summary, differences, ...assess(e, floors[m]) };
  }
  return out;
}

/** Floors from --floor-from (an --aa compare.json) and --floor m=v pairs; the flag wins. */
function loadFloors(opts) {
  const floors = {},
    sources = {};
  if (opts["floor-from"]) {
    const aa = JSON.parse(readFileSync(opts["floor-from"], "utf8"));
    if (aa.schema !== SCHEMA || !aa.aa) throw new Error(`${opts["floor-from"]} is not an --aa compare.json`);
    for (const key of ["page", "state", "profile"])
      if (aa[key] !== opts[key])
        throw new Error(`--floor-from was measured on ${key} ${aa[key]}, this run is ${opts[key]}`);
    for (const [m, f] of Object.entries(aa.floors ?? {}))
      if (typeof f === "number") {
        floors[m] = f;
        sources[m] = `${opts["floor-from"]} (A/A, ${aa.rounds?.[0]?.pairs?.length} pairs, ${aa.generatedAt})`;
      }
  }
  for (const part of (opts.floor ?? "").split(",").filter(Boolean)) {
    const [m, v] = part.split("=");
    if (!(Number(v) >= 0)) throw new Error(`--floor ${part}: expected metric=ms`);
    floors[m.trim()] = Number(v);
    sources[m.trim()] = "--floor";
  }
  return { floors, sources };
}

// ---------------------------------------------------------------------------------------------------- report

const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : "—");

function markdown(report) {
  const lines = [
    `# Paired timing comparison${report.aa ? " (A/A floor)" : ""}`,
    "",
    `${report.generatedAt} · page \`${report.page}\` · ${report.state} · profile \`${report.profile}\` · seed \`${report.seed}\` · ${report.resamples} resamples`,
    "",
    `- A: ${report.trees.A.spec} → ${report.trees.A.commit.slice(0, 12)}${report.trees.A.dirtyFiles ? ` (+${report.trees.A.dirtyFiles} changed files)` : ""}`,
    `- B: ${report.trees.B.spec} → ${report.trees.B.commit.slice(0, 12)}${report.trees.B.dirtyFiles ? ` (+${report.trees.B.dirtyFiles} changed files)` : ""}${report.seedFaultMs ? ` · **seeded fault: documents on B held ${report.seedFaultMs} ms**` : ""}`,
    "",
  ];
  for (const r of report.rounds) {
    lines.push(`## Round ${r.round} (${r.pairs.length} pairs, fresh sandboxes)`, "");
    lines.push(
      "| Metric | n | median B − A | 95% interval | floor | verdict | status |",
      "|---|---|---|---|---|---|---|",
    );
    for (const [m, e] of Object.entries(r.estimates))
      lines.push(
        `| ${m} | ${e.n} | ${fmt(e.median)} | ${e.lo === undefined ? "—" : `[${fmt(e.lo)}, ${fmt(e.hi)}]`} | ${fmt(e.floor)} | ${report.aa ? "A/A" : e.verdict} | ${report.aa ? "floor" : e.status}${e.reason ? ` (${e.reason})` : ""} |`,
      );
    lines.push("", `Order: ${r.pairs.map((p) => p.order).join(" ")}`, "");
    for (const when of ["before", "after"]) {
      const h = r.host[when];
      lines.push(
        `Host ${when}: ${h.quiet ? "quiet" : `**not quiet** (${h.reasons.join("; ")})`}; load/core ${h.loadPerCore.join(" ")}; cpu some avg10 ${h.pressure.cpu?.some?.avg10 ?? "—"}%, memory ${h.pressure.memory?.some?.avg10 ?? "—"}%, io ${h.pressure.io?.some?.avg10 ?? "—"}%`,
      );
    }
    lines.push("");
  }
  if (report.aa)
    lines.push("## Floors", "", ...Object.entries(report.floors).map(([m, f]) => `- ${m}: ${fmt(f)} ms`), "");
  else {
    lines.push("## Result", "", "| Metric | verdict | status | reason |", "|---|---|---|---|");
    for (const [m, r] of Object.entries(report.result))
      lines.push(`| ${m} | ${r.verdict} | ${r.status} | ${r.reason ?? ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const opts = options();
  mkdirSync(opts.out, { recursive: true });
  const B = resolveTree(opts.b, opts.treesDir);
  const A = opts.aa ? { ...B } : resolveTree(opts.a, opts.treesDir);
  const trees = { A, B };
  const { floors, sources } = opts.aa ? { floors: {}, sources: {} } : loadFloors(opts);
  const rounds = [];
  let failed = false;
  try {
    rounds.push(await round(1, trees, opts, floors));
    const flagged =
      !opts.aa && Object.values(rounds[0].estimates).some((e) => e.verdict === "regressed" || e.verdict === "improved");
    if (opts.confirm && flagged) rounds.push(await round(2, trees, opts, floors));
    const quiet = rounds.every((r) => r.host.before.quiet && r.host.after.quiet);
    const report = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      aa: Boolean(opts.aa),
      page: opts.page,
      state: opts.state,
      profile: opts.profile,
      metrics: opts.metrics,
      seed: opts.seed,
      resamples: opts.resamples,
      seedFaultMs: opts.fault || undefined,
      instrument: { pageLoad: PAGE_LOAD, ...treeIdentity(REPO) },
      trees: Object.fromEntries(
        Object.entries(trees).map(([s, t]) => [
          s,
          { spec: t.spec, tree: t.tree, made: t.made, ...treeIdentity(t.tree) },
        ]),
      ),
      floorSources: sources,
      hostQuiet: quiet,
      rounds,
    };
    if (opts.aa)
      report.floors = Object.fromEntries(Object.entries(rounds[0].estimates).map(([m, e]) => [m, e.floor ?? null]));
    else {
      report.result = {};
      for (const m of opts.metrics) {
        const first = rounds[0].estimates[m],
          second = rounds[1]?.estimates[m];
        const c = first.verdict === "missing" ? null : confirm(first, rounds[1] ? second : undefined);
        let status = c ? c.status : first.status,
          reason = first.reason ?? second?.reason;
        if (!rounds[1] && (first.verdict === "regressed" || first.verdict === "improved"))
          reason = "single run: a candidate finding until a second fresh run repeats it (--confirm)";
        if (!quiet && status !== NOT_EVALUATED) {
          status = NOT_EVALUATED;
          reason = "host not quiet (§3): verdict recorded, not scored";
        }
        report.result[m] = {
          verdict: c ? c.verdict : first.verdict,
          status,
          ...(reason ? { reason } : {}),
          floor: floors[m] ?? null,
        };
        if (first.verdict === "regressed" && (!rounds[1] || c.confirmed)) failed = true;
      }
    }
    writeFileSync(join(opts.out, "compare.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(opts.out, "compare.md"), markdown(report));
    process.stdout.write(markdown(report) + "\n");
  } finally {
    for (const t of new Set([A, B].filter((t) => t.made && !opts["keep-trees"]).map((t) => t.tree))) {
      try {
        git(["worktree", "remove", "--force", t]);
      } catch (error) {
        process.stderr.write(`compare: ${error.message}\n`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = () => {
    for (const s of ACTIVE) sandboxDown(s);
    process.exit(130);
  };
  process.once("SIGINT", stop);
  main().catch((error) => {
    process.stderr.write(`${redact(error?.stack ?? error)}\n`);
    process.exit(2);
  });
}
