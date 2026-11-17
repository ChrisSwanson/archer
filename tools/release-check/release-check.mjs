#!/usr/bin/env node
// Pre-release gate: one command that runs every check a UI or service change must pass, with a
// PASS/FAIL line, a time and an evidence path per step, and a budget gate over what the browser saw.
//
//   npm run release-check            full: + smoke-a/b/c journeys, seeded monkeys, lab on two profiles
//   npm run release-check:quick      stock journeys + editor-entry, lab on the default profile
//   node tools/release-check/release-check.mjs [--quick] [--out <dir>] [--skip <step>…] [--keep-sandbox] [--serial] [--parallel-unit]
//        [--buckets <ref>|none]
//
// Steps: typecheck (ui, ts) · unit (ui, ts; the opt-in stress suite excluded) · page-build (the web page and the MCP
// file into temp dirs, prod-strip check, the size caps on the web distribution and on the MCP file; reports index.html
// alone and every emitted file and, with --buckets (default in a full run:
// main), gzip per source bucket against the merge base with <ref>) · sandbox (fresh `sandbox.mjs up --debug-ui`, always torn down) · lab
// (page-load lab against tools/release-check/lab-budgets.json) · journeys (harness) · scale (count gates on the S and M corpora) · budgets (archer-budget/1 blocks: duplicate
// requests, API requests and bytes per page view, failed requests, duplicate writes, and the warning budget against
// allowed-warnings.json). Caps: config.json. Docs: docs/devkit/agent-harness.md "Release check".
//
// Output: a terminal report, <out>/release-check.json and <out>/release-check.md (default out:
// tools/release-check/out/<time>/, gitignored). Exit codes: 0 every step passed (WARN lines allowed), 1 a step or
// gate check failed, 2 usage or configuration error, 3 interrupted (SIGINT/SIGTERM/SIGHUP; the sandbox is still
// torn down). `--skip` steps are listed as SKIP and the verdict says "partial".
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  checkBudgets,
  checkFailedRequests,
  checkPageSize,
  checkWarnings,
  classifyVitest,
  cleanPage,
  fmtBytes,
} from "./lib/gate.mjs";
import {
  assetLines,
  attributeBuild,
  bucketLines,
  distribution,
  domLine,
  listAssets,
  referencedAssets,
  routeLine,
} from "./lib/sizes.mjs";
import { readServiceLog } from "../devkit/lib/service-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const STEPS = ["typecheck", "unit", "page-build", "sandbox", "lab", "journeys", "scale", "budgets"];

const { values: args } = (() => {
  try {
    return parseArgs({
      options: {
        quick: { type: "boolean" },
        out: { type: "string" },
        skip: { type: "string", multiple: true },
        "keep-sandbox": { type: "boolean" },
        serial: { type: "boolean" },
        "parallel-unit": { type: "boolean" },
        buckets: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
})();
if (args.help) {
  process.stdout.write(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 20)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n") + "\n",
  );
  process.exit(0);
}
const skip = new Set(args.skip ?? []);
for (const s of skip)
  if (!STEPS.includes(s)) {
    process.stderr.write(`unknown step ${s} (have ${STEPS.join(", ")})\n`);
    process.exit(2);
  }
let config, allowList;
try {
  config = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
  allowList = JSON.parse(readFileSync(join(HERE, "allowed-warnings.json"), "utf8")).allow;
  for (const e of allowList) {
    if (!e.code || !e.reason)
      throw new Error(`allowed-warnings.json: every entry needs code and reason (${JSON.stringify(e)})`);
    if (e.match) new RegExp(e.match);
  }
} catch (error) {
  process.stderr.write(`release-check: bad configuration: ${error.message}\n`);
  process.exit(2);
}

const mode = args.quick ? "quick" : "full";
const startedAt = new Date();
const OUT = resolve(args.out ?? join(HERE, "out", `${startedAt.toISOString().replace(/[:.]/g, "-")}-${mode}`));
const LOGS = join(OUT, "logs");
mkdirSync(LOGS, { recursive: true });
const rel = (p) => {
  if (!p) return p;
  const r = relative(process.cwd(), p) || ".";
  return r.startsWith("..") ? p : r;
};
const TTY = process.stdout.isTTY;
const progress = (text) => {
  if (TTY) process.stdout.write(`\x1b[2K\r${text.slice(0, (process.stdout.columns ?? 100) - 1)}\r`);
};

// ---------- interruption: kill children, tear the sandbox down, exit 3 ----------
const children = new Set();
let interrupted = null,
  signals = 0;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => {
    if (++signals > 1) {
      process.stderr.write(
        `\nsecond ${sig}: exiting now${sandbox ? `; run: node tools/devkit/sandbox.mjs down --name ${sandbox.name}` : ""}\n`,
      );
      process.exit(3);
    }
    interrupted = sig;
    process.stderr.write(`\nrelease-check: ${sig} received; stopping the current step and tearing down\n`);
    for (const c of children)
      try {
        c.kill("SIGTERM");
      } catch {
        /* gone */
      }
  });

/** Run a command, its output to a log file. Resolves {code, signal, ms, log}. */
function run(cmd, cmdArgs, { cwd = REPO, env = cleanEnv(), log, onLine } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const sink = createWriteStream(log, { flags: "a" });
    sink.write(`$ (cd ${rel(cwd)} && ${cmd} ${cmdArgs.join(" ")})\n`);
    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let buffered = "";
    child.stdout.on("data", (d) => {
      sink.write(d);
      if (onLine) {
        buffered += d;
        const lines = buffered.split("\n");
        buffered = lines.pop();
        lines.forEach(onLine);
      }
    });
    child.stderr.on("data", (d) => sink.write(d));
    child.on("error", (error) => sink.write(`spawn error: ${error.message}\n`));
    child.on("close", (code, signal) => {
      children.delete(child);
      if (onLine && buffered) onLine(buffered);
      sink.end(
        `\n[exit ${code}${signal ? ` signal ${signal}` : ""} after ${((Date.now() - started) / 1000).toFixed(1)} s]\n`,
      );
      sink.on("finish", () => done({ code, signal, ms: Date.now() - started, log }));
    });
  });
}

/** The environment for every child: no stress opt-in, no debug page build, no git overrides. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^STRESS/.test(k) || k === "ARCHER_DEBUG_UI" || /^GIT_/.test(k)) delete env[k];
  return { ...env, FORCE_COLOR: "0", ...extra };
}

// ---------- step bookkeeping ----------
const results = [];
const mark = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL", SKIP: "SKIP" };
async function step(id, title, fn) {
  const entry = { id, title, status: "SKIP", ms: 0, evidence: [], details: [] };
  results.push(entry);
  if (skip.has(id)) {
    entry.details.push("skipped (--skip)");
    print(entry);
    return entry;
  }
  if (interrupted) {
    entry.details.push(`not run: interrupted (${interrupted})`);
    print(entry);
    return entry;
  }
  progress(`… ${id}: ${title}`);
  const started = Date.now();
  try {
    const r = await fn(entry);
    Object.assign(entry, r ?? {});
  } catch (error) {
    entry.status = "FAIL";
    entry.details.push(
      `the step itself threw: ${String(error?.stack ?? error)
        .split("\n")
        .slice(0, 4)
        .join(" | ")}`,
    );
  }
  if (interrupted && entry.status !== "FAIL") {
    entry.status = "FAIL";
    entry.details.unshift(`interrupted (${interrupted})`);
  }
  entry.ms = Date.now() - started;
  print(entry);
  return entry;
}
function print(e) {
  progress("");
  const t = e.ms ? `${(e.ms / 1000).toFixed(1).padStart(6)} s` : "        ";
  process.stdout.write(`${mark[e.status].padEnd(4)} ${e.id.padEnd(10)} ${t}  ${e.title}\n`);
  const shown = e.status === "PASS" ? e.details.slice(0, 1) : e.details.slice(0, 14);
  for (const d of shown) process.stdout.write(`       ${d}\n`);
  if (e.status !== "PASS" && e.details.length > shown.length)
    process.stdout.write(`       … ${e.details.length - shown.length} more in release-check.md\n`);
  if (e.evidence.length && e.status !== "SKIP")
    process.stdout.write(`       evidence: ${e.evidence.map(rel).join("  ")}\n`);
}
const worst = (...s) =>
  s.includes("FAIL") ? "FAIL" : s.includes("WARN") ? "WARN" : s.every((x) => x === "SKIP") ? "SKIP" : "PASS";

// ---------- the steps ----------
const parallel = (jobs) =>
  args.serial
    ? jobs.reduce((p, j) => p.then(async (acc) => [...acc, await j()]), Promise.resolve([]))
    : Promise.all(jobs.map((j) => j()));

async function typecheck(entry) {
  const [ui, ts] = await parallel([
    () => run("npm", ["--workspace", "ui", "run", "typecheck"], { log: join(LOGS, "typecheck-ui.log") }),
    () => run("npm", ["--workspace", "ts", "run", "typecheck"], { log: join(LOGS, "typecheck-ts.log") }),
  ]);
  entry.evidence.push(ui.log, ts.log);
  const details = [];
  for (const [name, r] of [
    ["ui", ui],
    ["ts", ts],
  ]) {
    if (r.code === 0) {
      details.push(`${name}: clean (${(r.ms / 1000).toFixed(1)} s)`);
      continue;
    }
    const errors = readFileSync(r.log, "utf8")
      .split("\n")
      .filter((l) => /error TS\d+/.test(l));
    details.push(
      `${name}: ${errors.length || "?"} type error(s)`,
      ...errors.slice(0, 6).map((l) => `  ${l.trim().slice(0, 180)}`),
    );
  }
  return { status: ui.code === 0 && ts.code === 0 ? "PASS" : "FAIL", details };
}

async function unit(entry) {
  const rgOnPath = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  // The ui suite serves and bundles this checkout's built pages (ui/dist; no tracked fallback since P3-shell). A
  // checkout that was never built gets them first, so the suite is not red on a missing build.
  const built = ["ui/dist/index.html", "ui/dist/mcp/index.html"].every((p) => existsSync(join(REPO, p)));
  const prelude = [];
  if (!built) {
    const b = await run("npm", ["--workspace", "ui", "run", "build"], { log: join(LOGS, "unit-build.log") });
    entry.evidence.push(b.log);
    if (b.code !== 0)
      return { status: "FAIL", details: ["ui/dist was missing and `npm run build` failed (see the log)"] };
    prelude.push("ui/dist was missing: built it first (`npm run build`), as the ui suite serves the built page");
  }
  const one = async (ws) => {
    const json = join(OUT, `unit-${ws}.json`);
    rmSync(json, { force: true });
    const r = await run(
      "npx",
      ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${json}`],
      { cwd: join(REPO, ws), log: join(LOGS, `unit-${ws}.log`) },
    );
    let report = null;
    try {
      report = JSON.parse(readFileSync(json, "utf8"));
    } catch {
      /* crashed */
    }
    entry.evidence.push(r.log);
    return { ws, ms: r.ms, ...classifyVitest(report, { exitCode: r.code, rgOnPath }) };
  };
  // Serial on purpose: in parallel on a shared host the ui suite took 772 s instead of ~200 and
  // process-spawning property tests timed out (ETIMEDOUT). --parallel-unit runs them together.
  const out = args["parallel-unit"] ? await Promise.all([one("ui"), one("ts")]) : [await one("ui"), await one("ts")];
  return {
    status: worst(...out.map((o) => o.status)),
    details: [
      ...prelude,
      ...out.flatMap((o) => [
        `${o.ws}: ${o.status} ${o.details[0]} (${(o.ms / 1000).toFixed(1)} s)`,
        ...o.details.slice(1),
      ]),
    ],
  };
}

async function pageBuild(entry) {
  const root = mkdtempSync(join(tmpdir(), "archer-release-page-"));
  const dir = join(root, "web"),
    mcpDir = join(root, "mcp");
  const log = join(LOGS, "page-build.log");
  entry.evidence.push(log);
  try {
    const ui = join(REPO, "ui");
    const validator = await run("node", ["scripts/generate-validator.mjs", "--check"], { cwd: ui, log });
    if (validator.code !== 0)
      return {
        status: "FAIL",
        details: [
          "the generated envelope validator is stale: run `node ui/scripts/generate-validator.mjs` (see the log)",
        ],
      };
    // Both pages the package ships (ui/package.json build): the web page with its assets, and the MCP App's one file.
    const [build, mcpBuild] = await parallel([
      () =>
        run("npx", ["vite", "build", "--outDir", dir, "--emptyOutDir"], {
          cwd: ui,
          log: join(LOGS, "page-build-web.log"),
        }),
      () =>
        run("npx", ["vite", "build", "--mode", "mcp", "--outDir", mcpDir, "--emptyOutDir"], {
          cwd: ui,
          log: join(LOGS, "page-build-mcp.log"),
        }),
    ]);
    entry.evidence.push(build.log, mcpBuild.log);
    if (build.code !== 0 || mcpBuild.code !== 0)
      return {
        status: "FAIL",
        details: [
          `vite build failed: ${[build.code !== 0 ? "web" : null, mcpBuild.code !== 0 ? "mcp" : null].filter(Boolean).join(", ")} (see the log)`,
        ],
      };
    const page = join(dir, "index.html"),
      mcpPage = join(mcpDir, "index.html");
    const details = [];
    for (const [name, file] of [
      ["the page", page],
      ["the MCP file", mcpPage],
    ]) {
      const clean = cleanBuiltPage(file, log);
      if (clean.external.length)
        return {
          status: "FAIL",
          details: [`${name} loads external scripts HEAD's ui/index.html does not: ${clean.external.join(", ")}`],
        };
      if (clean.removed.length)
        details.push(
          `${name} built without ${clean.removed.length} uncommitted ui/index.html line(s): ${clean.removed.join(" ").slice(0, 160)}`,
        );
    }
    // The existing caps gate what ships (performance passes, "the litmus, honestly applied"): the web distribution
    // (index.html and every asset it names) and the self-contained MCP file. index.html alone is reported.
    const shipped = referencedAssets(dir);
    const strip = await run("node", ["scripts/check-prod-strip.mjs", ...shipped.map((f) => join(dir, f)), mcpPage], {
      cwd: ui,
      log,
    });
    const html = readFileSync(page);
    const size = {
      raw: html.length,
      gzip: gzipSync(html, { level: 9 }).length,
      brotli: brotliCompressSync(html).length,
    };
    const assets = listAssets(dir, { "index.html": size });
    const web = distribution(assets.filter((a) => shipped.includes(a.path)));
    const mcpHtml = readFileSync(mcpPage);
    const mcp = {
      raw: mcpHtml.length,
      gzip: gzipSync(mcpHtml, { level: 9 }).length,
      brotli: brotliCompressSync(mcpHtml).length,
    };
    const checks = [
      checkPageSize(
        web,
        config.pageSize,
        `web distribution (index.html + ${shipped.length - 1} asset${shipped.length === 2 ? "" : "s"} it names)`,
      ),
      checkPageSize(mcp, config.pageSize, "MCP single file"),
    ];
    for (const c of checks)
      details.push(
        `${c.ok ? "ok  " : "FAIL"} ${c.title}`,
        ...c.details.map((d) => `     over cap: ${d} (tools/release-check/config.json pageSize)`),
      );
    if (strip.code !== 0)
      details.push(
        "prod-strip: the production build carries debug code:",
        ...readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => /marker|carries|contains/i.test(l))
          .slice(-6)
          .map((l) => `  ${l}`),
      );
    else
      details.push(
        `prod-strip: no dev telemetry or profiling renderer in ${shipped.length} web file${shipped.length === 1 ? "" : "s"} or the MCP file`,
      );
    // Report only: index.html alone, every file the build emitted (one nothing names is listed, not shipped), and,
    // when asked, gzip per source bucket against a base build.
    details.push(
      `report index.html alone: ${fmtBytes(size.raw)} (gzip ${fmtBytes(size.gzip)}, br ${fmtBytes(size.brotli)})`,
    );
    details.push(...assetLines(assets));
    if (bucketBase)
      details.push(
        ...(await buckets(bucketBase, log).catch((error) => [
          `report buckets: not measured (${String(error?.message ?? error)
            .split("\n")[0]
            .slice(0, 160)})`,
        ])),
      );
    entry.page = size;
    entry.distribution = { ...web, shipped };
    entry.mcp = mcp;
    entry.assets = assets;
    return { status: strip.code === 0 && checks.every((c) => c.ok) ? "PASS" : "FAIL", details };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Bucket attribution: on by default in a full run (against main), opt-in for --quick; `--buckets none` turns it off.
const bucketBase = args.buckets === "none" ? null : (args.buckets ?? (args.quick ? null : "main"));

/**
 * gzip per source bucket of the working tree's page against the merge base with `ref`: both built with sourcemaps
 * (the base from `git archive` of ui, shared and ts/src, over this checkout's node_modules) and split by
 * lib/sizes.mjs attributeBuild. About 20 s. Report only.
 */
async function buckets(ref, log) {
  const { SourceMapConsumer } = createRequire(join(REPO, "package.json"))("source-map-js");
  const base = spawnSync("git", ["merge-base", "HEAD", ref], { cwd: REPO, encoding: "utf8" });
  if (base.status !== 0) throw new Error(`no merge base with ${ref}`);
  const sha = base.stdout.trim();
  const work = mkdtempSync(join(tmpdir(), "archer-release-buckets-"));
  try {
    const build = async (root, out) => {
      const r = await run("npx", ["vite", "build", "--sourcemap", "--outDir", out, "--emptyOutDir"], {
        cwd: join(root, "ui"),
        log,
      });
      if (r.code !== 0)
        throw new Error(
          `the sourcemap build in ${root === REPO ? "the working tree" : sha.slice(0, 8)} failed (see the log)`,
        );
      return attributeBuild(out, SourceMapConsumer);
    };
    const tree = join(work, "base");
    mkdirSync(tree);
    const paths = ["ui", "shared", "ts/src"].filter(
      (p) => spawnSync("git", ["cat-file", "-e", `${sha}:${p}`], { cwd: REPO }).status === 0,
    );
    const archive = spawnSync("sh", ["-c", `git archive ${sha} ${paths.join(" ")} | tar -x -C "${tree}"`], {
      cwd: REPO,
    });
    if (archive.status !== 0) throw new Error(`git archive ${sha.slice(0, 8)} failed`);
    symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
    const head = await build(REPO, join(work, "head"));
    const then = await build(tree, join(work, "base-out"));
    return bucketLines(head, then, { label: `merge base with ${ref} (${sha.slice(0, 8)})` });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Build pages from the committed ui/index.html, not the working tree's: an uncommitted dev-only tag there (the
 * Impeccable live script, with a token) would ship in the measured page and trip the CSP on every view.
 */
function cleanBuiltPage(page, log) {
  const head = spawnSync("git", ["show", "HEAD:ui/index.html"], { cwd: REPO, encoding: "utf8" }).stdout ?? "";
  const work = readFileSync(join(REPO, "ui/index.html"), "utf8");
  const r = cleanPage(readFileSync(page, "utf8"), { head, work });
  writeFileSync(page, r.html);
  writeFileSync(
    log,
    `cleaned ${page}: removed ${r.removed.length} uncommitted index.html line(s)${r.removed.length ? `: ${r.removed.join(" | ")}` : ""}; external scripts left: ${r.external.length}\n`,
    { flag: "a" },
  );
  return r;
}

let sandbox = null,
  debugPageDir = null;
const sandboxName = `rc-${randomBytes(3).toString("hex")}`;
async function sandboxUp(entry) {
  // The gate builds the debug page itself (telemetry on, ARCHER_DEBUG_UI=1, never into ui/dist) so it can clean it.
  debugPageDir = mkdtempSync(join(tmpdir(), "archer-release-debug-"));
  const log = join(LOGS, "sandbox.log");
  entry.evidence.push(log);
  const build = await run("npx", ["vite", "build", "--outDir", debugPageDir, "--emptyOutDir"], {
    cwd: join(REPO, "ui"),
    env: cleanEnv({ ARCHER_DEBUG_UI: "1" }),
    log,
  });
  if (build.code !== 0) return { status: "FAIL", details: ["the debug page did not build (see the log)"] };
  const page = join(debugPageDir, "index.html");
  const clean = cleanBuiltPage(page, log);
  if (clean.external.length)
    return {
      status: "FAIL",
      details: [`the debug page loads external scripts HEAD's ui/index.html does not: ${clean.external.join(", ")}`],
    };
  const { up } = await import("../devkit/sandbox.mjs");
  sandbox = await up({ name: sandboxName, page });
  entry.evidence.push(sandbox.logPath);
  return {
    status: "PASS",
    details: [
      `${sandbox.name} at ${sandbox.origin} (${sandbox.projects.length} projects, debug page${clean.removed.length ? `, ${clean.removed.length} uncommitted index.html line(s) left out` : ""})`,
    ],
  };
}
async function sandboxDown() {
  if (debugPageDir && !args["keep-sandbox"]) rmSync(debugPageDir, { recursive: true, force: true });
  if (!sandbox) return null;
  try {
    copyFileSync(sandbox.logPath, join(OUT, "service.log"));
  } catch {
    /* none */
  }
  if (args["keep-sandbox"]) return `kept: node tools/devkit/sandbox.mjs down --name ${sandbox.name}`;
  const { down } = await import("../devkit/sandbox.mjs");
  try {
    await down({ name: sandbox.name });
    return `torn down (service log copied to ${rel(join(OUT, "service.log"))})`;
  } catch (error) {
    return `TEARDOWN FAILED: ${error.message}; run node tools/devkit/sandbox.mjs down --name ${sandbox.name}`;
  }
}

/**
 * Service warnings (svc.*, not echoed client events) logged since `seq`, read with the sandbox's own token. A log that
 * cannot be read comes back as `unreadable` (its cause), which the caller reports as a WARN, never as no warnings.
 */
async function serviceWarnings(since) {
  const read = await readServiceLog(
    sandbox.origin,
    sandbox.ownerToken,
    `${since === null ? "limit=1" : `since=${since}&limit=1000`}&level=warn`,
  );
  if (read.unreadable) return { seq: since, entries: [], unreadable: read.unreadable };
  return { seq: read.seq ?? since, entries: since === null ? [] : read.entries.filter((e) => e.source !== "client") };
}

const collected = { budgets: [], warnings: [], requests: [], journeys: [] };

async function lab(entry) {
  const out = join(OUT, "lab");
  const profiles = args.quick ? config.lab.quickProfiles : config.lab.fullProfiles;
  const before = await serviceWarnings(null);
  // --tls-ca: a TLS sandbox is trusted by its pinned leaf (perf rubric G5), never by ignoring TLS errors.
  // --allow-writes: a throwaway sandbox, so the page behaves exactly as for a person (selection posts, layout reads).
  const r = await run(
    "node",
    [
      "tools/perf/page-load.mjs",
      "--base",
      sandbox.origin,
      "--login",
      sandbox.link,
      "--project",
      config.lab.project,
      "--pages",
      config.lab.pages.join(","),
      "--profiles",
      profiles.join(","),
      "--runs",
      "1",
      "--out",
      out,
      "--budget",
      config.lab.budgetFile,
      "--allow-writes",
      ...(sandbox.caPath ? ["--tls-ca", sandbox.caPath] : []),
    ],
    { log: join(LOGS, "lab.log") },
  );
  entry.evidence.push(join(out, "perf-report.md"), r.log);
  let summary;
  try {
    summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  } catch {
    return { status: "FAIL", details: [`the lab wrote no summary.json (exit ${r.code}); see the log`] };
  }
  collected.budgets.push({ run: "lab", budget: summary.budget });
  for (const [code, n] of Object.entries(summary.budget.warnings?.byCode ?? {}))
    for (let i = 0; i < n; i++) collected.warnings.push({ run: "lab", code, msg: null });
  const after = await serviceWarnings(before.seq);
  for (const e of after.entries) collected.warnings.push({ run: "lab", code: e.code, msg: e.msg });
  const unreadable = before.unreadable ?? after.unreadable;
  const rows = summary.budget.pages ?? [];
  const t = summary.budget.totals;
  const details = [
    `${rows.length} loads (${profiles.join(", ")}; cold + warm): ${t.apiRequests} API requests, ${t.duplicateRequests} duplicates, worst page ${t.maxApiRequestsPerPage} API / ${t.maxDuplicateRequestsPerPage} dup`,
  ];
  // Report only (performance passes: new measurements beside the caps): what each route's first load moved, and
  // its DOM as shell + rows × elements per row + the rest.
  details.push(...rows.filter((p) => /\/cold$/.test(p.key)).map((p) => `report ${p.key}: ${routeLine(p)}`));
  // The lab file's caps are judged here (timings warn up to timingFailFactor × the cap); duplicates, bytes and
  // warnings are judged in the budgets step together with every other source.
  const checks = checkBudgets([{ run: "lab", budget: summary.budget }], config.budgets);
  const labCheck = checks.find((c) => c.id === "lab-budget"),
    timing = checks.find((c) => c.id === "lab-timing");
  details.push(...labCheck.details.map((d) => `over ${config.lab.budgetFile}: ${d}`), ...timing.details);
  if (unreadable) details.push(`service log unreadable, so its svc.* warnings are not gated: ${unreadable}`);
  return { status: !labCheck.ok ? "FAIL" : timing.warn || unreadable ? "WARN" : "PASS", details };
}

/**
 * Scale count gates (tools/perf/scale-gates.mjs): the S and M corpora in sandboxes of their own, over the debug page
 * built for this run. Counts gate against config.scale.budgetFile; timings warn. ARCHER_SCALE_L=1 adds the slow L corpus.
 */
async function scale(entry) {
  const wanted = args.quick ? config.scale.quickSizes : config.scale.sizes;
  const out = join(OUT, "scale");
  const r = await run(
    "node",
    [
      "tools/perf/scale-gates.mjs",
      "--sizes",
      wanted.join(","),
      "--page",
      join(debugPageDir, "index.html"),
      "--out",
      out,
      "--budget",
      config.scale.budgetFile,
    ],
    { log: join(LOGS, "scale.log") },
  );
  entry.evidence.push(join(out, "scale-report.md"), r.log);
  let report;
  try {
    report = JSON.parse(readFileSync(join(out, "scale-report.json"), "utf8"));
  } catch {
    return { status: "FAIL", details: [`the scale gates wrote no report (exit ${r.code}); see the log`] };
  }
  const shapes = Object.entries(report.measured).flatMap(([size, m]) =>
    Object.entries(m.pages)
      .filter(([, p]) => p.dom)
      .map(([page, p]) => `report ${size}/${page}: DOM ${domLine(p.dom)}`),
  );
  const sizes = Object.entries(report.measured).map(([size, m]) => {
    const pages = Object.values(m.pages);
    return `${size}: ${m.views ?? "?"} views, probe ${m.probe.contentEncoding}, ${pages.map((p) => p.apiRequests).join("/")} API requests (${pages.map((p) => p.commentFetches).join("/")} comment reads), catalog ${Math.round(Math.max(...pages.map((p) => p.catalogBytes)) / 1024)} KB, ${pages.map((p) => p.domNodes).join("/")} DOM nodes`;
  });
  // Each size's service warnings go to the warning budget; a log that could not be read is a WARN here.
  const unreadable = [];
  for (const [size, m] of Object.entries(report.measured)) {
    for (const w of m.service?.warnings ?? [])
      collected.warnings.push({ run: `scale-${size}`, code: w.code, msg: w.msg });
    if (m.service?.warnings === undefined)
      unreadable.push(
        `${size}: service log unreadable, so its svc.* warnings are not gated: ${m.service?.unreadable ?? "not reported"}`,
      );
  }
  const details = [
    ...sizes,
    ...report.failures.map((f) => `over ${config.scale.budgetFile}: ${f}`),
    ...report.warnings.map((w) => `warn ${w}`),
    ...unreadable,
    ...shapes,
  ];
  return {
    status:
      report.failures.length || r.code === 2 ? "FAIL" : report.warnings.length || unreadable.length ? "WARN" : "PASS",
    details,
  };
}

function journeyFiles() {
  const files = [...config.journeys.quick];
  if (!args.quick) {
    const exclude = new RegExp(config.journeys.full.exclude);
    for (const d of config.journeys.full.dirs)
      for (const f of readdirSync(join(REPO, d)).sort())
        if (f.endsWith(".mjs") && !exclude.test(f)) files.push(join(d, f));
  }
  return files;
}

async function journeys(entry) {
  const groups = [{ label: args.quick ? "quick" : "journeys", files: journeyFiles(), env: {} }];
  if (!args.quick)
    for (const m of config.journeys.monkey)
      groups.push({
        label: `monkey-${m.type}-${m.seed}`,
        files: ["tools/devkit/journeys/monkey/monkey.mjs"],
        env: { MONKEY_TYPE: m.type, MONKEY_SEED: String(m.seed), MONKEY_SOURCE: m.source, MONKEY_MS: String(m.ms) },
      });
  const failures = [],
    unreadable = [];
  let total = 0,
    passed = 0;
  for (const g of groups) {
    if (interrupted) break;
    const lines = [];
    const r = await run(
      "node",
      [
        "tools/devkit/harness/smoke.mjs",
        "--sandbox",
        sandbox.name,
        "--json",
        ...g.files.flatMap((f) => ["--journey", f]),
      ],
      {
        env: cleanEnv(g.env),
        log: join(LOGS, `journeys-${g.label}.log`),
        onLine: (l) => {
          try {
            const j = JSON.parse(l);
            if (typeof j?.summary !== "string" || typeof j.ok !== "boolean") return;
            lines.push(j);
            progress(`… journeys: ${lines.length} done, last ${j.ok ? "pass" : "FAIL"} ${j.name}`);
          } catch {
            /* not ours */
          }
        },
      },
    );
    entry.evidence.push(r.log);
    for (const j of lines) {
      total++;
      let s = null;
      try {
        s = JSON.parse(readFileSync(j.summary, "utf8"));
      } catch {
        /* aborted before writing */
      }
      collected.journeys.push({ name: j.name, ok: j.ok, summary: j.summary });
      if (j.ok) passed++;
      else
        failures.push(
          `✗ ${j.name}: ${j.failures
            .slice(0, 2)
            .map(
              (f) =>
                `[${f.step}] ${
                  f.kind === "invariant"
                    ? `invariant ${f.invariant}`
                    : String(f.error ?? "")
                        .split("\n")[0]
                        .slice(0, 120)
                }`,
            )
            .join("; ")}  → ${rel(j.summary)}`,
        );
      if (!s) continue;
      if (typeof s.surfaces?.serviceLog === "string")
        unreadable.push(
          `${j.name}: service log unreadable, so its svc.* warnings are not gated: ${s.surfaces.serviceLog}`,
        );
      collected.budgets.push({ run: j.name, budget: s.budget });
      for (const st of s.steps ?? [])
        for (const w of st.warnings ?? []) collected.warnings.push({ run: j.name, code: w.code, msg: w.msg ?? null });
      try {
        collected.requests.push({
          run: j.name,
          requests: readFileSync(s.artifacts.requests, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .filter((q) => q.tab === undefined),
        });
      } catch {
        /* no requests file */
      }
    }
    if (r.code === 3 || (r.code !== 0 && lines.length < g.files.length))
      failures.push(
        `✗ ${g.label}: the harness exited ${r.code} after ${lines.length} of ${g.files.length} journeys; see ${rel(r.log)}`,
      );
  }
  return {
    status: failures.length ? "FAIL" : unreadable.length ? "WARN" : "PASS",
    details: [`${passed} of ${total} journeys passed`, ...failures, ...unreadable],
  };
}

async function budgets(entry) {
  if (collected.budgets.length === 0)
    return { status: "SKIP", details: ["no archer-budget/1 block collected (lab and journeys did not run)"] };
  const checks = [
    ...checkBudgets(collected.budgets, config.budgets),
    checkFailedRequests(collected.requests, config.allowedFailedRequests),
    checkWarnings(collected.warnings, allowList),
  ];
  entry.checks = checks;
  const w = checks.find((c) => c.id === "warnings");
  const details = [];
  for (const c of checks) {
    details.push(`${!c.ok ? "FAIL" : c.warn ? "warn" : "ok  "} ${c.title}`);
    if (c.ok && c.warn) details.push(...c.details.slice(0, 6).map((d) => `       ${d}`));
    if (!c.ok)
      details.push(
        ...c.details.slice(0, 8).map((d) => `       ${d}`),
        ...(c.details.length > 8 ? [`       … ${c.details.length - 8} more`] : []),
      );
  }
  let debt = false;
  for (const a of w.allowed) {
    const e = allowList.find((x) => x.code === a.code && x.match === a.match);
    if (e?.kind === "debt") {
      debt = true;
      details.push(`debt ${a.code} ×${a.count} allowed: ${a.reason}`);
    }
  }
  if (Object.keys(w.notGated).length)
    details.push(
      `not gated: ${Object.entries(w.notGated)
        .map(([k, n]) => `${k} ×${n}`)
        .join(", ")}`,
    );
  const file = join(OUT, "budgets.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        checks,
        allowed: w.allowed,
        sources: collected.budgets.map((b) => ({ run: b.run, totals: b.budget.totals, warnings: b.budget.warnings })),
      },
      null,
      2,
    ) + "\n",
  );
  entry.evidence.push(file);
  // Known debt passes, but as WARN so it is printed on every run.
  return {
    status: !checks.every((c) => c.ok) ? "FAIL" : debt || checks.some((c) => c.warn) ? "WARN" : "PASS",
    details,
  };
}

// ---------- main ----------
const git = (a) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" }).stdout.trim();
const head = git(["rev-parse", "--short", "HEAD"]),
  dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
process.stdout.write(
  `release-check (${mode}) at ${head}${dirty ? ` + ${dirty} uncommitted file(s)` : ""} → ${rel(OUT)}\n`,
);

let teardown = null,
  crashed = null;
try {
  await step("typecheck", "tsc --noEmit, ui and ts", typecheck);
  await step("unit", "vitest, ui and ts (stress suite excluded)", unit);
  await step("page-build", "production pages (web + MCP): build, prod-strip, size caps", pageBuild);
  const sb = await step("sandbox", "fresh throwaway sandbox, debug page built from committed ui/index.html", sandboxUp);
  const browser = sb.status === "PASS";
  const needsSandbox = (id, title, fn) =>
    step(
      id,
      title,
      browser
        ? fn
        : async () => ({
            status: skip.has("sandbox") ? "SKIP" : "FAIL",
            details: [
              skip.has("sandbox") ? "skipped: no sandbox (--skip sandbox)" : "not run: the sandbox did not start",
            ],
          }),
    );
  await needsSandbox("lab", `page-load lab vs ${config.lab.budgetFile}`, lab);
  await needsSandbox(
    "journeys",
    args.quick ? "stock journeys + editor-entry" : "stock + smoke-a/b/c journeys + seeded monkeys",
    journeys,
  );
  await needsSandbox(
    "scale",
    `scale count gates, sizes ${(args.quick ? config.scale.quickSizes : config.scale.sizes).join("+")} vs ${config.scale.budgetFile}`,
    scale,
  );
} catch (error) {
  crashed = error;
} finally {
  teardown = await sandboxDown();
  if (teardown) process.stdout.write(`       sandbox ${sandboxName}: ${teardown}\n`);
}
if (!crashed)
  await step("budgets", "budget gate over every archer-budget/1 block", budgets).catch((e) => {
    crashed = e;
  });

const statuses = results.map((r) => r.status);
const skipped = results.filter((r) => r.status === "SKIP").map((r) => r.id);
const failed = statuses.includes("FAIL");
const exitCode = interrupted ? 3 : crashed ? 2 : failed ? 1 : 0;
const verdict = interrupted
  ? `INTERRUPTED (${interrupted})`
  : crashed
    ? "ERROR (the gate crashed)"
    : failed
      ? "FAIL"
      : `PASS${skipped.length ? ` (partial: ${skipped.join(", ")} skipped)` : ""}${statuses.includes("WARN") ? " with warnings" : ""}`;
const durationMs = Date.now() - startedAt.getTime();

const report = {
  schema: "archer-release-check/1",
  mode,
  verdict,
  ok: exitCode === 0,
  exitCode,
  startedAt: startedAt.toISOString(),
  durationMs,
  git: { head, uncommittedFiles: dirty },
  sandbox: { name: sandboxName, teardown },
  page: results.find((r) => r.id === "page-build")?.page ?? null,
  distribution: results.find((r) => r.id === "page-build")?.distribution ?? null,
  mcp: results.find((r) => r.id === "page-build")?.mcp ?? null,
  assets: results.find((r) => r.id === "page-build")?.assets ?? null,
  steps: results.map(({ id, title, status, ms, details, evidence, checks }) => ({
    id,
    title,
    status,
    ms,
    details,
    evidence: evidence.map(rel),
    ...(checks ? { checks } : {}),
  })),
  journeys: collected.journeys.map((j) => ({ ...j, summary: rel(j.summary) })),
  ...(crashed ? { error: String(crashed.stack ?? crashed) } : {}),
};
writeFileSync(join(OUT, "release-check.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(OUT, "release-check.md"), markdown(report));
process.stdout.write(
  `\n${verdict} in ${(durationMs / 1000).toFixed(0)} s  (exit ${exitCode})\n  report: ${rel(join(OUT, "release-check.md"))}\n  json:   ${rel(join(OUT, "release-check.json"))}\n`,
);
if (crashed) process.stderr.write(`${crashed.stack ?? crashed}\n`);
process.exit(exitCode);

function markdown(r) {
  const lines = [
    `# Release check (${r.mode}): ${r.verdict}`,
    "",
    `${r.startedAt} · ${(r.durationMs / 1000).toFixed(0)} s · \`${r.git.head}\`${r.git.uncommittedFiles ? ` + ${r.git.uncommittedFiles} uncommitted` : ""} · exit ${r.exitCode}`,
    "",
    "| Step | Result | Time | Evidence |",
    "|---|---|---|---|",
  ];
  for (const s of r.steps)
    lines.push(
      `| ${s.id} | ${s.status} | ${(s.ms / 1000).toFixed(1)} s | ${s.evidence.map((e) => `\`${e}\``).join(" ")} |`,
    );
  for (const s of r.steps) {
    if (!s.details.length) continue;
    lines.push("", `## ${s.id}: ${s.status}`, "", s.title, "", "```", ...s.details, "```");
    if (s.checks)
      for (const c of s.checks.filter((x) => !x.ok))
        lines.push("", `### ${c.id}`, "", ...c.details.map((d) => `- ${d}`));
  }
  if (r.journeys.length) {
    lines.push("", "## Journeys", "", "| Journey | Result | summary.json |", "|---|---|---|");
    for (const j of r.journeys) lines.push(`| ${j.name} | ${j.ok ? "pass" : "**FAIL**"} | \`${j.summary}\` |`);
  }
  lines.push("", `Sandbox ${r.sandbox.name}: ${r.sandbox.teardown ?? "not started"}.`, "");
  return lines.join("\n");
}
