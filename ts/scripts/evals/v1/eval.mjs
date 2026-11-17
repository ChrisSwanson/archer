// The small-agent eval baseline in one command (docs/evaluations/eval-baseline.md):
// builds the package, installs it into a throwaway HOME, runs agents × tasks × runs a few at a
// time with the isolation run.mjs gives each run, judges them, and prints a summary table.
//
//   npm run eval -- [--agents haiku,sol,luna] [--tasks all|main|holdout|<id,...>] [--runs 3] [--jobs 4]
//                   [--out <dir>] [--package <tgz>] [--compare <baseline.json>] [--write-baseline <file>]
//   npm run eval -- --rejudge <results dir> [--compare <baseline.json>] [--write-baseline <file>]
//
// Results (transcripts, projects, judgements, results.json, summary.md) go to --out, by default
// ~/.cache/archer-evals/<date>-<time>. --compare diffs the run against a committed baseline and
// exits 3 when a cell regressed; --write-baseline writes one from this run.
// aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENTS, DEFAULT_AGENTS } from "./agents.mjs";
import { CANARY, judgeRun } from "./judge.mjs";
import { runOne } from "./run.mjs";
import { HOLDOUT, HOLDOUT_MANIFEST, TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

// ---- pure parts (tested in ts/test/evals/eval-baseline.test.ts)

/** The task ids a --tasks value names: all, main, holdout, or a comma list. */
export function selectTasks(value = "main", tasks = TASKS, manifest = HOLDOUT_MANIFEST) {
  if (value === "all") return tasks.map((t) => t.id);
  if (value === "main" || value === "holdout") return tasks.filter((t) => t.set === value).map((t) => t.id);
  // The normalisation tasks (ticket 06), T1–T6.
  if (value === "normalise") return tasks.filter((t) => t.id.startsWith("norm-")).map((t) => t.id);
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !tasks.some((t) => t.id === id));
  const privateIds = unknown.filter((id) => manifest.ids.includes(id));
  if (privateIds.length)
    throw new Error(
      `hold-out task(s) ${privateIds.join(", ")} need the private hold-out file (docs/evaluations/eval-baseline.md, "Hold-out")`,
    );
  if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(", ")}`);
  return ids;
}

export const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** A run's score: pass 1, partial 0.5, fail (error, contaminated) 0. */
export const score = (verdict) => (verdict === "pass" ? 1 : verdict === "partial" ? 0.5 : 0);

/** Per agent × task: runs, verdict counts, pass rate, mean score, median calls, misses by name. */
export function cells(runs) {
  const out = {};
  for (const run of runs) {
    const key = `${run.agent}/${run.task}`;
    const cell = (out[key] ??= {
      agent: run.agent,
      task: run.task,
      set: run.set,
      runs: 0,
      pass: 0,
      partial: 0,
      fail: 0,
      error: 0,
      contaminated: 0,
      calls: [],
      archerCalls: [],
      misses: {},
    });
    cell.runs++;
    cell[run.verdict] = (cell[run.verdict] ?? 0) + 1;
    if (typeof run.toolCalls === "number") cell.calls.push(run.toolCalls);
    if (typeof run.archerCalls === "number") cell.archerCalls.push(run.archerCalls);
    for (const miss of run.misses ?? []) cell.misses[miss] = (cell.misses[miss] ?? 0) + 1;
  }
  for (const cell of Object.values(out)) {
    cell.passRate = cell.pass / cell.runs;
    cell.score = (cell.pass + cell.partial / 2) / cell.runs;
    cell.medianCalls = median(cell.calls);
    cell.medianArcherCalls = median(cell.archerCalls);
    delete cell.calls;
    delete cell.archerCalls;
  }
  return out;
}

/** Totals per agent and set. */
export function totals(cellMap) {
  const out = {};
  for (const cell of Object.values(cellMap)) {
    const t = (out[`${cell.agent}/${cell.set}`] ??= {
      agent: cell.agent,
      set: cell.set,
      runs: 0,
      pass: 0,
      partial: 0,
      fail: 0,
      error: 0,
      contaminated: 0,
    });
    for (const k of ["runs", "pass", "partial", "fail", "error", "contaminated"]) t[k] += cell[k] ?? 0;
  }
  for (const t of Object.values(out)) {
    t.passRate = t.pass / t.runs;
    t.score = (t.pass + t.partial / 2) / t.runs;
  }
  return out;
}

const failures = (c) => c.fail + (c.error ?? 0) + (c.contaminated ?? 0);

/**
 * New cells against a baseline's. A cell regressed when its mean score fell by a third or more
 * (one of three runs from pass to fail, or two from pass to partial) or it gained a fail the
 * baseline never had; it improved on the mirror image. Small samples are noisy: a flag means
 * "re-run this cell", not "proven worse". Hold-out cells are "not run" when this run had no
 * hold-out file, and "not comparable" when its file's sha256 differs from the baseline's.
 */
export function compare(baseline, current, { holdout = "same" } = {}) {
  const rows = [];
  const agents = new Set(Object.values(current).map((c) => c.agent));
  if (holdout !== "same")
    for (const [key, was] of Object.entries(baseline))
      if (was.set === "holdout" && !(key in current) && agents.has(was.agent))
        rows.push({ key, status: holdout === "absent" ? "not run" : "not comparable", was });
  for (const [key, now] of Object.entries(current)) {
    const was = baseline[key];
    if (now.set === "holdout" && holdout === "changed") {
      rows.push({ key, status: "not comparable", ...(was ? { was } : {}), now });
      continue;
    }
    if (!was) {
      rows.push({ key, status: "new", now });
      continue;
    }
    const delta = now.score - was.score;
    const newFail = failures(now) > 0 && failures(was) === 0;
    const status = delta <= -1 / 3 + 1e-9 || newFail ? "regressed" : delta >= 1 / 3 - 1e-9 ? "improved" : "same";
    rows.push({ key, status, delta, was, now });
  }
  return rows;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const verdicts = (c) =>
  `${c.pass}/${c.partial}/${c.fail}${c.error ? ` +${c.error} err` : ""}${c.contaminated ? ` +${c.contaminated} contaminated` : ""}`;

export function summaryTable(cellMap, totalMap) {
  const lines = [
    "| Agent | Task | Set | Runs | Pass/partial/fail | Pass rate | Median calls (Archer) | Misses |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of Object.values(cellMap).sort(
    (a, b) => a.agent.localeCompare(b.agent) || a.set.localeCompare(b.set) || a.task.localeCompare(b.task),
  )) {
    const misses =
      Object.entries(c.misses)
        .map(([name, n]) => `${name} ×${n}`)
        .join("; ") || "";
    lines.push(
      `| ${c.agent} | ${c.task} | ${c.set} | ${c.runs} | ${verdicts(c)} | ${pct(c.passRate)} | ${c.medianCalls ?? "-"} (${c.medianArcherCalls ?? "-"}) | ${misses} |`,
    );
  }
  lines.push("", "| Agent | Set | Runs | Pass/partial/fail | Pass rate | Score |", "|---|---|---|---|---|---|");
  for (const t of Object.values(totalMap).sort((a, b) => a.agent.localeCompare(b.agent) || a.set.localeCompare(b.set)))
    lines.push(`| ${t.agent} | ${t.set} | ${t.runs} | ${verdicts(t)} | ${pct(t.passRate)} | ${t.score.toFixed(2)} |`);
  return lines.join("\n") + "\n";
}

export function compareTable(rows) {
  const lines = ["| Cell | Baseline p/p/f | Now p/p/f | Δ score | |", "|---|---|---|---|---|"];
  const mark = { regressed: "▼ regressed", improved: "▲ improved" };
  for (const r of rows.filter((r) => r.status !== "same"))
    lines.push(
      `| ${r.key} | ${r.was ? verdicts(r.was) : "-"} | ${r.now ? verdicts(r.now) : "-"} | ${r.delta === undefined ? "-" : r.delta.toFixed(2)} | ${mark[r.status] ?? r.status} |`,
    );
  if (lines.length === 2) lines.push("| (no cell changed by a third or more) | | | | |");
  return lines.join("\n") + "\n";
}

// ---- package, install, context

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** sha256 over a directory's files, by relative path. */
export function digestDir(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(relative(root, full)).update("\0").update(readFileSync(full)).update("\0");
    }
  };
  walk(root);
  return hash.digest("hex");
}

function build(out) {
  const dir = join(out, "package");
  mkdirSync(dir, { recursive: true });
  console.log(`building the package into ${dir}`);
  const r = spawnSync("npm", ["--workspace", "ts", "run", "package", "--", dir], { cwd: REPO, encoding: "utf8" });
  writeFileSync(join(dir, "build.log"), r.stdout + r.stderr);
  if (r.status !== 0) throw new Error(`package build failed; see ${join(dir, "build.log")}`);
  const version = JSON.parse(readFileSync(join(REPO, "ts", "package.json"), "utf8")).version;
  return join(dir, `archer-${version}.tgz`);
}

/** `archer setup` into a throwaway HOME: never the person's own ~/.local, ~/.codex or ~/.claude. */
function install(tgz, home) {
  mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CODEX_HOME: join(home, ".codex"),
    npm_config_cache: join(home, ".npm"),
    npm_config_update_notifier: "false",
  };
  const r = spawnSync("npx", ["--yes", `./${basename(tgz)}`, "setup", "--no-claude"], {
    cwd: dirname(tgz),
    env,
    encoding: "utf8",
    timeout: 300_000,
  });
  writeFileSync(join(home, "..", "setup.log"), r.stdout + r.stderr);
  if (r.status !== 0 || !existsSync(join(home, ".local", "bin", "archer")))
    throw new Error(`archer setup failed; see ${join(home, "..", "setup.log")}`);
}

const tokens = (text) => Math.round(text.length / 4);

/** What the installed package costs an agent's context: skill, MCP instructions, descriptions, schemas. */
async function context(home) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const skillDir = join(home, ".local", "share", "archer", "current", "skills", "archer");
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const scratch = join(home, "..", "context");
  mkdirSync(scratch, { recursive: true });
  const client = new Client({ name: "eval-context", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: join(home, ".local", "bin", "archer"),
      args: ["mcp"],
      cwd: scratch,
      stderr: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        ARCHER_STATE_DIR: join(scratch, "s"),
        ARCHER_SOCKET: join(scratch, "s", "a.sock"),
      },
    }),
  );
  try {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const descriptions = tools.map((t) => `${t.name}: ${t.description ?? ""}`).join("\n");
    const schemas = tools.map((t) => JSON.stringify(t.inputSchema)).join("\n");
    return {
      skillDigest: digestDir(skillDir),
      toolsDigest: createHash("sha256").update(instructions).update(descriptions).update(schemas).digest("hex"),
      tokens: {
        skillBody: tokens(skill),
        mcpInstructions: tokens(instructions),
        toolDescriptions: tokens(descriptions),
        toolSchemas: tokens(schemas),
        tools: tools.length,
      },
    };
  } finally {
    await client.close();
  }
}

/** Your own Archer services' ports, from ARCHER_RESERVED_PORTS (comma-separated; default 40399, the dev server's default): never given to a run, even when free. */
const OWN_PORTS = new Set(
  (process.env.ARCHER_RESERVED_PORTS ?? "40399")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0),
);
const anyPort = () =>
  new Promise((done, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
const freePort = async () => {
  for (;;) {
    const port = await anyPort();
    if (!OWN_PORTS.has(port)) return port;
  }
};

// ---- the command

/** A run's missed checks; a hold-out check's name is rubric text, so it is only "a hold-out check" outside its run folder. */
export function misses(checks, set) {
  return checks
    .filter((c) => !c.pass)
    .map((c) => `${c.level === "must" ? "✗ " : ""}${set === "holdout" ? "(hold-out check)" : c.name}`);
}

function condensed(j, set) {
  return {
    agent: j.agent,
    task: j.task,
    set,
    rep: j.rep,
    verdict: j.verdict,
    toolCalls: j.toolCalls,
    archerCalls: j.archerCalls,
    seconds: j.seconds,
    misses: misses(j.checks, set),
    ...(j.contamination ? { contamination: j.contamination } : {}),
    ...(j.usage ? { usage: j.usage } : {}),
    ...(j.measures ? { measures: j.measures } : {}),
  };
}

/** Runs that touched the eval itself (judge.mjs, contamination): listed apart, each a fail. */
export function contaminatedList(runs) {
  const bad = runs.filter((r) => r.verdict === "contaminated");
  if (bad.length === 0) return "";
  return `\n## Contaminated runs (${bad.length}): counted as fails\n\n${bad.map((r) => `- ${r.agent} ${r.task} ${r.rep}: ${(r.contamination ?? []).slice(0, 3).join("; ")}`).join("\n")}\n`;
}

/** The hold-out as a baseline keeps it: scores by task id, no check names (they are rubric text). */
export function publicCells(cellMap) {
  return Object.fromEntries(
    Object.entries(cellMap).map(([key, c]) => [key, c.set === "holdout" ? { ...c, misses: {} } : c]),
  );
}

/** Says so when the hold-out is skipped or changed. */
function holdoutNotice(holdout, selected) {
  if (holdout.status === "absent")
    return `hold-out skipped: no ${holdout.path} (docs/evaluations/eval-baseline.md, "Hold-out")`;
  if (!holdout.matches && selected)
    return `warning: ${holdout.path} differs from ts/scripts/evals/v1/holdout.json (sha256 ${holdout.sha256.slice(0, 12)}, ids ${holdout.ids.join(",")}): the hold-out changed, so earlier hold-out scores are not comparable`;
  return "";
}

/** Every run's condensed judgement; re-judged when `install` is given (hold-out runs only with `rejudgeHoldout`). */
function collect(out, install, rejudgeHoldout = true) {
  const runs = [];
  for (const agent of readdirSync(out).filter((a) => a in AGENTS))
    for (const task of readdirSync(join(out, agent))) {
      const def = TASKS.find((t) => t.id === task);
      if (!def) continue;
      for (const rep of readdirSync(join(out, agent, task)).sort()) {
        const dir = join(out, agent, task, rep);
        if (!existsSync(join(dir, "evidence.json"))) {
          runs.push({ agent, task, set: def.set, rep, verdict: "error", misses: ["no evidence (run did not finish)"] });
          continue;
        }
        try {
          runs.push(
            condensed(
              install && (rejudgeHoldout || def.set !== "holdout")
                ? judgeRun(dir, install)
                : JSON.parse(readFileSync(join(dir, "judgement.json"), "utf8")),
              def.set,
            ),
          );
        } catch (error) {
          runs.push({ agent, task, set: def.set, rep, verdict: "error", misses: [`judge: ${error.message}`] });
        }
      }
    }
  return runs;
}

async function main() {
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(
        [
          "agents",
          "tasks",
          "runs",
          "jobs",
          "out",
          "package",
          "compare",
          "write-baseline",
          "rejudge",
          "from",
          "judge-install",
        ].map((k) => [k, { type: "string" }]),
      ),
      sealed: { type: "boolean" },
    },
  });
  let out,
    meta,
    rejudgeHoldout = true;
  // --judge-install <home>: judge with another install's archer, so a baseline and its comparison share one lint and compiler.
  const judgeHome = values["judge-install"] ? resolve(values["judge-install"]) : undefined;
  if (values.rejudge) {
    out = resolve(values.rejudge);
    meta = JSON.parse(readFileSync(join(out, "results.json"), "utf8")).meta;
    console.log(`re-judging ${out}`);
    // Hold-out runs made with another hold-out file keep the judgements they had: today's rubric is not theirs.
    rejudgeHoldout = !meta.holdout?.sha256 || meta.holdout.sha256 === HOLDOUT.sha256;
    if (!rejudgeHoldout)
      console.log(
        `hold-out runs kept as judged: they were made with hold-out ${meta.holdout.sha256.slice(0, 12)}, and the file is now ${HOLDOUT.sha256?.slice(0, 12) ?? "absent"}`,
      );
    if (!meta.holdout && HOLDOUT.status === "loaded")
      meta = { ...meta, holdout: { status: "loaded", sha256: HOLDOUT.sha256, matches: HOLDOUT.matches } };
    meta = { ...meta, canary: CANARY };
  } else {
    const stamp = new Date()
      .toISOString()
      .replace(/:\d\d\.\d+Z$/, "")
      .replace("T", "-")
      .replace(":", "");
    out = resolve(values.out ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "archer-evals", stamp));
    const agents = (values.agents ?? DEFAULT_AGENTS.join(",")).split(",");
    for (const a of agents) if (!(a in AGENTS)) throw new Error(`unknown agent ${a}`);
    const tasks = selectTasks(values.tasks ?? "all");
    const notice = holdoutNotice(
      HOLDOUT,
      tasks.some((id) => TASKS.find((t) => t.id === id)?.set === "holdout") ||
        ["all", "holdout"].includes(values.tasks ?? "all"),
    );
    if (notice) console.log(notice);
    if (tasks.length === 0) throw new Error("no tasks to run");
    mkdirSync(out, { recursive: true });
    // Resuming a campaign made with another hold-out would mix two rubrics' scores under one fingerprint.
    const earlier = existsSync(join(out, "results.json"))
      ? JSON.parse(readFileSync(join(out, "results.json"), "utf8")).meta
      : undefined;
    if (earlier?.holdout?.sha256 && earlier.holdout.sha256 !== HOLDOUT.sha256)
      throw new Error(
        `${out} was started with hold-out ${earlier.holdout.sha256.slice(0, 12)}, and the hold-out file is now ${HOLDOUT.sha256?.slice(0, 12) ?? "absent"}: use a new --out`,
      );
    if (!existsSync(join(out, "progress.log"))) writeFileSync(join(out, "progress.log"), `# ${CANARY}\n`);
    const tgz = values.package ? resolve(values.package) : build(out);
    const home = join(out, "install", "home");
    if (!existsSync(join(home, ".local", "bin", "archer"))) install(tgz, home);
    const git = (args) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim();
    meta = {
      canary: CANARY,
      started: new Date().toISOString(),
      package: { file: tgz, sha256: sha256(tgz) },
      git: {
        head: git(["rev-parse", "--short", "HEAD"]),
        dirty: git(["status", "--porcelain", "--", "ts", "shared", "ui/src"]) !== "",
      },
      install: home,
      holdout:
        HOLDOUT.status === "absent"
          ? { status: "absent" }
          : { status: "loaded", sha256: HOLDOUT.sha256, matches: HOLDOUT.matches },
      agents: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, `${v.model} (${v.effort})`])),
      ...(await context(home)),
    };
    writeFileSync(join(out, "results.json"), JSON.stringify({ meta, runs: [] }, null, 2));
    const runsPer = Number(values.runs ?? 3),
      from = Number(values.from ?? 1);
    // Repetition-major, so a stopped campaign still has every cell's first runs.
    const jobs = [];
    for (let rep = from; rep < from + runsPer; rep++)
      for (const task of tasks) for (const agent of agents) jobs.push({ agent, task, rep });
    console.log(
      `${jobs.length} runs (${agents.join(",")} × ${tasks.length} tasks × ${runsPer}) into ${out}; package ${meta.package.sha256.slice(0, 12)}, skill ${meta.skillDigest.slice(0, 12)}`,
    );
    let next = 0,
      done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const line = await (async () => {
          try {
            if (existsSync(join(out, job.agent, job.task, `r${job.rep}`, "evidence.json")))
              return `${job.agent} ${job.task} r${job.rep}: kept`;
            const dir = await runOne({
              install: home,
              out,
              ...job,
              port: await freePort(),
              sealed: values.sealed === true,
            });
            const j = judgeRun(dir, judgeHome ?? home);
            return `${j.agent} ${j.task} ${j.rep}: ${j.verdict} calls=${j.toolCalls} archer=${j.archerCalls} ${misses(j.checks, TASKS.find((t) => t.id === j.task)?.set).join("; ")}`;
          } catch (error) {
            return `${job.agent} ${job.task} r${job.rep}: ERROR ${error.message}`;
          }
        })();
        done++;
        console.log(`[${done}/${jobs.length}] ${line}`);
        appendFileSync(join(out, "progress.log"), line + "\n");
      }
    };
    await Promise.all(Array.from({ length: Number(values.jobs ?? 4) }, worker));
  }
  const runs = collect(out, values.rejudge ? (judgeHome ?? meta.install) : undefined, rejudgeHoldout);
  const cellMap = cells(runs),
    totalMap = totals(cellMap);
  writeFileSync(join(out, "results.json"), JSON.stringify({ meta, runs, cells: cellMap, totals: totalMap }, null, 2));
  let report =
    `<!-- ${CANARY} -->\n# Eval run ${meta.started}\n\nPackage sha256 ${meta.package.sha256} (git ${meta.git.head}${meta.git.dirty ? ", dirty" : ""}); skill ${meta.skillDigest.slice(0, 12)}; tools ${meta.toolsDigest.slice(0, 12)}.\n` +
    `Context (tokens ≈ chars/4): skill ${meta.tokens.skillBody}, MCP instructions ${meta.tokens.mcpInstructions}, ${meta.tokens.tools} tool descriptions ${meta.tokens.toolDescriptions}, schemas ${meta.tokens.toolSchemas}.\n\n${summaryTable(cellMap, totalMap)}`;
  let regressed = false;
  if (values.compare) {
    const base = JSON.parse(readFileSync(resolve(values.compare), "utf8"));
    const ran = runs.some((r) => r.set === "holdout"),
      sha = meta.holdout?.sha256 ?? HOLDOUT.sha256;
    const holdout = !ran ? "absent" : base.meta.holdout?.sha256 !== sha ? "changed" : "same";
    const rows = compare(base.cells, cellMap, { holdout });
    // Totals over the cells both runs have; a changed hold-out has none in common.
    const comparable = ([key, cell]) => key in cellMap && !(cell.set === "holdout" && holdout !== "same");
    const baseShared = totals(Object.fromEntries(Object.entries(base.cells).filter(comparable)));
    regressed = rows.some((r) => r.status === "regressed");
    report +=
      `\n## Against ${values.compare} (package ${base.meta.package.sha256.slice(0, 12)}, skill ${base.meta.skillDigest.slice(0, 12)})\n\n${compareTable(rows)}\n` +
      // Totals over the cells both runs have, so a partial run compares like with like.
      Object.values(totalMap)
        .map((t) => {
          const b = baseShared[`${t.agent}/${t.set}`];
          return b
            ? `- ${t.agent} ${t.set}: pass rate ${pct(b.passRate)} → ${pct(t.passRate)} (${b.runs} → ${t.runs} runs)`
            : "";
        })
        .filter(Boolean)
        .join("\n") +
      "\n";
  }
  report += contaminatedList(runs);
  writeFileSync(join(out, "summary.md"), report);
  console.log(`\n${report}\n${join(out, "summary.md")}`);
  if (values["write-baseline"]) {
    const { install: _install, ...kept } = meta;
    writeFileSync(
      resolve(values["write-baseline"]),
      JSON.stringify(
        { meta: { ...kept, package: { sha256: meta.package.sha256 } }, cells: publicCells(cellMap), totals: totalMap },
        null,
        2,
      ) + "\n",
    );
    console.log(`baseline written to ${values["write-baseline"]}`);
  }
  if (regressed) process.exitCode = 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
