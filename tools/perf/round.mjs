#!/usr/bin/env node
// One performance-round measurement (docs/quality/rubrics/performance.md §6 evidence packet, §9 run manifest):
// fresh TLS sandboxes of tools/devkit/corpus with the §1 fixture state (an agent presentation of seq-awkward),
// the production variant (every surface × cold/warm × default/remote-link, --runs 3, manifest, scoped TLS, coverage)
// and the debug variant (poll tags, default profile, the same --runs), the build's document and worker sizes, and the §1 test
// target. Raw output goes to --out (keep it outside git); the run manifest says what ran and what did not.
//
//   node tools/perf/round.mjs --out <scratch dir> [--runs 3] [--profiles default,remote-link] [--skip-debug] [--skip-coverage]
//   node tools/perf/round.mjs --summarise <dir with perf-report.json and requests.jsonl>
//   node tools/perf/round.mjs --rescore <round dir> [--release-control <dir with a release perf-report.json>]...
//
// The last release is measured in the same run (rubric §4: the ratchet compares like with like): the newest tag
// reachable from the candidate (v0.10.0 for 0.11.0), or --release <ref>. Its tree is a detached worktree
// built under --out (`npm ci`, `npm --workspace ui run build`) unless --release-tree names a built one at that commit.
// The tree's own sandbox.mjs and fixture.mjs serve it; this branch's page-load.mjs measures it with the production
// arguments, so both sides are the max of the same --runs (3). The release's ratchet rows, sizes and artifact hashes
// go in the packet, with release-comparison.json: G4 (ratchet), S1 (kinds, chain depth), S2 (unused bytes) and S6
// (new late shifts).
//
//   node tools/perf/round.mjs --out <dir> [--release v0.10.0] [--release-tree <built worktree>] [--skip-release]
//
// The timing pairs (compare.mjs) and journeys (canvas-pan, leak-navigation, reconnect, service-load) are run
// separately; their outputs are named in the packet. Needs the production page built (ui/dist).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, release as osRelease, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { down, up } from "../devkit/sandbox.mjs";
import { distribution, listAssets, referencedAssets } from "../release-check/lib/sizes.mjs";
import { present } from "./fixture.mjs";
import {
  FAIL,
  NOT_EVALUATED,
  PASS,
  PASS_WITH_EXCEPTIONS,
  RATCHET_METRICS,
  S1_METRICS,
  anchorsOverRuns,
  cellKey,
  cellKeys,
  covers,
  lateShiftChanges,
  ratchet,
} from "./lib/compare.mjs";
import { PAGES } from "./page-load.mjs";
import { anchorPhases, shownFor } from "./lib/manifest.mjs";
import { coverageAA, runRange } from "./lib/coverage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const gitIn = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
const git = (...args) => gitIn(REPO, ...args);
const pressure = () =>
  Object.fromEntries(
    ["cpu", "memory", "io"].map((k) => {
      try {
        return [k, readFileSync(`/proc/pressure/${k}`, "utf8").trim()];
      } catch {
        return [k, null];
      }
    }),
  );

/** The page artifacts of a built tree (its ui/dist): the document and the layout worker, with SHA-256. */
export function artifactsOf(root = REPO) {
  const dist = join(root, "ui/dist");
  if (!existsSync(join(dist, "index.html"))) return null;
  const worker = existsSync(join(dist, "page-assets"))
    ? listAssets(dist).find((a) => /elk-layout-worker-.*\.js$/.test(a.path))
    : null;
  return {
    html: { path: "ui/dist/index.html", sha256: sha(readFileSync(join(dist, "index.html"))) },
    worker: worker ? { path: `ui/dist/${worker.path}`, sha256: sha(readFileSync(join(dist, worker.path))) } : null,
  };
}

/**
 * The release this candidate is compared against: `ref` when given, else the newest tag reachable from the
 * candidate, skipping a tag on the candidate itself (a candidate that is the release has nothing to compare). Returns
 * {ref, tag, commit} or {error}.
 */
export function resolveRelease(ref = null, { cwd = REPO } = {}) {
  const head = gitIn(cwd, "rev-parse", "HEAD");
  let tag = ref ?? gitIn(cwd, "describe", "--tags", "--abbrev=0", "HEAD");
  if (!ref && tag && gitIn(cwd, "rev-list", "-n", "1", tag) === head)
    tag = gitIn(cwd, "describe", "--tags", "--abbrev=0", "HEAD^");
  if (!tag) return { error: "no tag reachable from HEAD: pass --release <ref>" };
  const commit = gitIn(cwd, "rev-list", "-n", "1", tag);
  if (!commit) return { error: `${tag}: not a commit` };
  return { ref: tag, tag: gitIn(cwd, "describe", "--tags", "--exact-match", commit) || null, commit };
}

/** The rubric's frozen version (`v2.1`) and its latest amendments (`v2.2`) from the Status line. */
export function rubricVersion(text) {
  const status = /^Status: (.*)$/m.exec(text)?.[1] ?? "";
  return {
    version: /frozen (v\d+(?:\.\d+)*)/.exec(status)?.[1] ?? null,
    amendments: [...status.matchAll(/amendments (v\d+(?:\.\d+)*)/g)].at(-1)?.[1] ?? null,
  };
}

/** The §1 test target, minus what only the run knows (sandbox, TLS mode, browser). */
export function testTarget({ lastRelease = null } = {}) {
  const rubric = join(REPO, "docs/quality/rubrics/performance.md");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  const rel = lastRelease ?? resolveRelease();
  return {
    rubric: {
      path: "docs/quality/rubrics/performance.md",
      ...rubricVersion(readFileSync(rubric, "utf8")),
      sha256: sha(readFileSync(rubric)),
    },
    sourceEditions: {
      webDev: "as fetched 2026-10-30 (rubric §2 table)",
      cdpPdl: "devtools-protocol master as of 2026-10-30 (not pinned to a commit by this run)",
      rfc9113: "RFC 9113",
    },
    candidate: {
      commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      diffSha256: sha(git("diff", "HEAD")),
      untrackedSha256: sha(untracked),
      untrackedFiles: untracked ? untracked.split("\n").length : 0,
    },
    artifacts: artifactsOf(REPO),
    lastRelease: rel.error
      ? { error: rel.error }
      : {
          ref: rel.ref,
          tag: rel.tag,
          commit: rel.commit,
          artifacts: rel.artifacts ?? "not built by this run",
          ...(rel.tree ? { tree: rel.tree } : {}),
          ...(rel.sizes ? { sizes: rel.sizes } : {}),
        },
    environment: {
      os: type(),
      kernel: osRelease(),
      cpu: cpus()[0]?.model ?? null,
      cores: cpus().length,
      node: process.version,
      playwright: JSON.parse(readFileSync(join(REPO, "node_modules/playwright/package.json"), "utf8")).version,
    },
    fixture: {
      corpus: "tools/devkit/corpus",
      corpusCommit: git("log", "-1", "--format=%H", "--", "tools/devkit/corpus"),
      project: "awkward",
      presentation: "agent presentation of seq-awkward (tools/perf/fixture.mjs present)",
    },
    settings: {
      archerToml: "corpus default",
      ARCHER_HTTP2: "unset (HTTP/1.1)",
      ARCHER_DEBUG: "1 (devkit sandboxes always run with it)",
    },
    credential: "one sandbox editing link (full capability), token redacted from every record",
  };
}

/** Document and worker bytes of the build, and the distribution against the pageSize caps (G4 ratchet inputs). */
export function buildSizes(root = REPO) {
  const dist = join(root, "ui/dist");
  // ui/dist holds the MCP build in mcp/ and the page's text names it, so referencedAssets would count it: the
  // release check builds the two apart. The web distribution is index.html and what it names outside mcp/.
  const assets = listAssets(dist).filter((a) => !a.path.startsWith("mcp/")),
    shipped = referencedAssets(dist).filter((p) => !p.startsWith("mcp/"));
  const doc = assets.find((a) => a.path === "index.html"),
    worker = assets.find((a) => /elk-layout-worker-.*\.js$/.test(a.path));
  const caps = JSON.parse(readFileSync(join(root, "tools/release-check/config.json"), "utf8")).pageSize;
  return {
    document: doc,
    worker,
    distribution: distribution(assets.filter((a) => shipped.includes(a.path))),
    caps: { raw: caps.maxRawBytes, gzip: caps.maxGzipBytes, brotli: caps.maxBrotliBytes },
  };
}

function lab(record, out, args) {
  const r = spawnSync(
    process.execPath,
    [
      join(HERE, "page-load.mjs"),
      "--base",
      record.origin,
      "--login",
      record.link,
      "--fixture",
      "rubric",
      "--tls-ca",
      record.caPath,
      "--manifest",
      join(HERE, "manifests.json"),
      "--out",
      out,
      ...args,
    ],
    { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 },
  );
  writeFileSync(
    join(out, "..", `${out.split("/").pop()}.log`),
    (r.stdout + r.stderr).replace(/token=[0-9a-f]+/gi, "token=REDACTED"),
  );
  return r.status;
}

/** One variant on a fresh sandbox; `tools` is the tree whose sandbox.mjs and fixture.mjs serve it (the release's own). */
async function variant(name, out, { debugUi, args, tools = { up, down, present }, tree = REPO }) {
  const record = await tools.up({ name, tls: true, debugUi });
  try {
    const presented = await tools.present({ sandbox: name });
    mkdirSync(out, { recursive: true });
    const status = lab(record, out, args);
    return {
      sandbox: {
        name,
        tls: true,
        debugUi,
        page: debugUi ? "debug" : `production (${tree === REPO ? "ui/dist" : `${tree}/ui/dist`})`,
      },
      presented,
      exit: status,
      out,
    };
  } finally {
    await tools.down({ name });
  }
}

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} in ${cwd}: exit ${r.status}\n${(r.stderr || r.stdout).slice(-2000)}`);
};

/**
 * The release's built tree: --release-tree when given (it must be at the release commit; built when ui/dist is
 * missing), else a detached worktree under `out` (reused when present), `npm ci` and the page built. Returns the path.
 */
export function releaseTree({ commit, tree = null, out }) {
  const path = tree ? resolve(tree) : join(out, `release-${commit.slice(0, 7)}`);
  if (!existsSync(path)) run("git", ["worktree", "add", "--detach", path, commit], REPO);
  const at = gitIn(path, "rev-parse", "HEAD");
  if (at !== commit)
    throw new Error(
      `release tree ${path} is at ${at.slice(0, 7) || "no commit"}, not the release ${commit.slice(0, 7)}`,
    );
  if (!existsSync(join(path, "node_modules"))) run("npm", ["ci"], path);
  if (!existsSync(join(path, "ui/dist/index.html"))) run("npm", ["--workspace", "ui", "run", "build"], path);
  return path;
}

/**
 * S2 against the release: unused main JS, worker JS and CSS bytes per surface × state × profile, each side the max of
 * its samples (coverageCell). A rise fails; a cell incomplete or missing on either side is NOT EVALUATED, and with
 * `expected` ({pages, states, profiles}) a cell neither side collected is listed NOT EVALUATED too (O214).
 */
export function coverageChanges(candidate, release, { expected = null, exceptions = [] } = {}) {
  const index = (report) =>
    new Map((report?.results ?? []).filter((r) => r.coverage).map((r) => [cellKey(r), r.coverage]));
  const cand = index(candidate),
    rel = index(release);
  const cells = [];
  for (const k of cellKeys(cand.keys(), rel.keys(), expected)) {
    const [page, state, profile] = k.split("\u0000"),
      c = cand.get(k),
      p = rel.get(k);
    for (const kind of ["mainJs", "workerJs", "css"]) {
      const base = { page, state, profile, metric: `${kind}.unusedBytes` };
      if (!c || !p) {
        cells.push({ ...base, status: NOT_EVALUATED, reason: c ? "no last-release cell" : "no candidate cell" });
        continue;
      }
      if (!c.complete || !p.complete || !c.summary || !p.summary) {
        cells.push({
          ...base,
          status: NOT_EVALUATED,
          reason: `${!c.complete || !c.summary ? "candidate" : "last release"} cell incomplete`,
        });
        continue;
      }
      const cv = c.summary[kind]?.unusedBytes,
        rv = p.summary[kind]?.unusedBytes;
      // The A/A control (O216): each side's runs of one build on this cell. Where they differ, the metric is not
      // deterministic here and a rise of the max is NOT EVALUATED with both ranges; `maxOfRuns` keeps what the
      // exact max-of-3 comparison reads. The worker's messages per run say what work the runs did.
      const aa = { candidate: runRange(c.perRun, kind), release: runRange(p.perRun, kind) };
      const messages =
        kind === "workerJs"
          ? {
              workerMessages: {
                candidate: (c.perRun ?? []).map((x) => x.workerMessages ?? null),
                release: (p.perRun ?? []).map((x) => x.workerMessages ?? null),
              },
            }
          : {};
      const extra = { aa, ...messages, ...(kind === "workerJs" ? workDifference(messages.workerMessages) : {}) };
      if (cv <= rv) {
        cells.push({ ...base, candidate: cv, release: rv, status: PASS, ...extra });
        continue;
      }
      // An approved PERF-EX record for this metric, surface, state and profile, up to its bound (§4), covers the rise
      // whether or not the A/A runs vary; `maxOfRuns` keeps what the exact comparison reads.
      const ex = exceptions.find((e) => covers(e, { page, state, profile, metric: base.metric, candidate: cv }));
      if (ex) {
        cells.push({
          ...base,
          candidate: cv,
          release: rv,
          status: PASS_WITH_EXCEPTIONS,
          exception: ex.id,
          maxOfRuns: FAIL,
          ...extra,
        });
        continue;
      }
      // Ranges that do not overlap (claude-302): every candidate run above every release run is a rise in every
      // pairing, so a determinate FAIL however much each side's runs vary.
      if (aa.candidate && aa.release && aa.candidate.min > aa.release.max) {
        cells.push({
          ...base,
          candidate: cv,
          release: rv,
          status: FAIL,
          reason: `rose by ${cv - rv} bytes; every candidate run (${aa.candidate.min}–${aa.candidate.max}) is above every last-release run (${aa.release.min}–${aa.release.max})`,
          ...extra,
        });
        continue;
      }
      const varies = [
        ["candidate", aa.candidate],
        ["last release", aa.release],
      ].filter(([, r]) => r?.varies);
      if (varies.length) {
        cells.push({
          ...base,
          candidate: cv,
          release: rv,
          status: NOT_EVALUATED,
          maxOfRuns: FAIL,
          reason: `rose by ${cv - rv} bytes at the max of runs, but the A/A runs vary and overlap (${varies.map(([who, r]) => `${who} ${r.min}–${r.max} over ${r.runs.length} runs`).join("; ")}): not a deterministic rise`,
          ...extra,
        });
        continue;
      }
      cells.push({ ...base, candidate: cv, release: rv, status: FAIL, reason: `rose by ${cv - rv} bytes`, ...extra });
    }
  }
  const status = cells.some((x) => x.status === FAIL)
    ? FAIL
    : cells.length === 0 || cells.some((x) => x.status === NOT_EVALUATED)
      ? NOT_EVALUATED
      : cells.some((x) => x.status === PASS_WITH_EXCEPTIONS)
        ? PASS_WITH_EXCEPTIONS
        : PASS;
  return { status, cells };
}

/**
 * How the two builds' worker work differed on a cell (O216), from the per-run worker messages: the layouts each run
 * posted, and a sentence when one side posted more, e.g. "the last release posted 1 more layout in 3 of 3 runs".
 */
export function workDifference(messages) {
  const layouts = (list) => (list ?? []).map((m) => (m ? (m.byCmd?.layout ?? 0) : null));
  const c = layouts(messages?.candidate),
    r = layouts(messages?.release);
  if (c.length === 0 || r.length === 0 || c.includes(null) || r.includes(null)) return {};
  const cMax = Math.max(...c),
    rMax = Math.max(...r);
  const out = { layoutsPerRun: { candidate: c, release: r } };
  if (rMax > cMax)
    out.workNote = `the last release posted ${rMax - cMax} more layout(s) to its worker in ${r.filter((n) => n > cMax).length} of ${r.length} runs`;
  else if (cMax > rMax)
    out.workNote = `the candidate posted ${cMax - rMax} more layout(s) to its worker in ${c.filter((n) => n > rMax).length} of ${c.length} runs`;
  return out;
}

/** The cells a round's comparison must cover: every page the lab measures, cold and warm, on every profile run. */
export const expectedCells = (profiles) => ({ pages: PAGES, states: ["cold", "warm"], profiles });

/**
 * The packet's comparison of the candidate with the release, from both production reports and their ratchet rows.
 * `expected` ({pages, states, profiles}): every cell the comparison must cover, so a missing one is NOT EVALUATED.
 */
export function releaseComparison({
  candidateRows,
  releaseRows,
  candidateReport,
  releaseReport,
  release,
  expected = null,
  exceptions = [],
  releaseControls = [],
}) {
  return {
    release,
    note: "Both sides measured in this run by this branch's page-load.mjs with the same arguments; each value is the max of the runs. Evidence for the review, not its verdict. A cell whose samples or chain loads were incomplete, or that a side lacks, is NOT EVALUATED, not compared.",
    ...(expected
      ? { expected: { pages: expected.pages.length, states: expected.states, profiles: expected.profiles } }
      : {}),
    ...(exceptions.length ? { exceptions: exceptions.map((e) => e.id) } : {}),
    G4: ratchet(candidateRows, releaseRows, { metrics: RATCHET_METRICS, expected, exceptions }),
    S1: ratchet(candidateRows, releaseRows, { metrics: S1_METRICS, expected, exceptions }),
    S2: coverageChanges(candidateReport, releaseReport, { expected, exceptions }),
    ...(releaseControls.length ? { releaseControls: releaseControls.map((c) => c.name) } : {}),
    S6: lateShiftChanges(candidateRows, releaseRows, { expected, releaseControls: releaseControls.map((c) => c.rows) }),
  };
}

/**
 * S6 rows from a further collection of the release (O228: three release runs missed movements v0.10.0 makes): each
 * cell's readiness and its anchors over that collection's runs. Added to the release's evidence, never replacing it.
 */
export const releaseControlRows = (report) =>
  (report?.results ?? [])
    .filter((r) => r.perRun)
    .map((r) => ({
      page: r.page,
      state: r.state,
      profile: r.profile,
      readiness: { complete: r.readiness?.complete === true, reasons: r.readiness?.reasons ?? [] },
      readyAnchors: anchorsOverRuns(r.perRun),
    }));

/**
 * A report's per-run anchors with their per-request phases (G4 per request, rubric v2.4 item 2) rebuilt from the
 * lab's raw logs, for reports collected before the lab recorded them: each run's requests (requests.jsonl records) at
 * its anchors, the DOM anchor at the document's start plus its `at`, the mark at the load's readyMs (loads.jsonl).
 * A run's anchor gets `byRequest` only when the rebuilt requests by phase equal the recorded ones, so a rebuild that
 * does not reproduce the lab is never scored. Returns {report, rebuilt, mismatched: ["page/profile/state/run anchor"]}.
 */
export function withRequestPhases(report, requests, loads) {
  const byRun = new Map(),
    key = (x, run) => `${x.page}\u0000${x.profile ?? "default"}\u0000${x.state}\u0000${run}`;
  for (const r of requests) {
    const k = key(r, r.run);
    (byRun.get(k) ?? byRun.set(k, []).get(k)).push(r);
  }
  const fixture = {
    project: report.project,
    diagram: report.shown?.diagram,
    flow: report.shown?.flow,
    note: report.shown?.note,
  };
  let rebuilt = 0;
  const mismatched = [];
  const results = (report.results ?? []).map((cell) => {
    if (!Array.isArray(cell.perRun)) return cell;
    const perRun = cell.perRun.map((p, run) => {
      const ra = p?.readyAnchors,
        rows = byRun.get(key(cell, run)) ?? [];
      const doc = rows.find((r) => /^document$/i.test(r.type ?? "")),
        load = loads.find(
          (l) =>
            l.page === cell.page &&
            (l.profile ?? "default") === (cell.profile ?? "default") &&
            l.state === cell.state &&
            l.run === run,
        );
      if (!ra || !doc) return p;
      const anchors = {};
      if (ra.dom && typeof ra.dom.at === "number")
        anchors.dom = { readyMs: doc.startMs + ra.dom.at, inView: load?.inView ?? null };
      if (ra.mark && typeof load?.readyMs === "number")
        anchors.mark = { readyMs: load.readyMs, inView: load.inView ?? null };
      const got = anchorPhases({ rows, shown: shownFor(cell.page, fixture), anchors }),
        next = { ...ra };
      for (const [n, g] of Object.entries(got)) {
        if (JSON.stringify(g.byPhase) !== JSON.stringify(ra[n].byPhase)) {
          mismatched.push(`${cell.page}/${cell.profile ?? "default"}/${cell.state}/${run} ${n}`);
          continue;
        }
        next[n] = { ...ra[n], byRequest: g.byRequest };
        rebuilt++;
      }
      return { ...p, readyAnchors: next };
    });
    return { ...cell, perRun };
  });
  return { report: { ...report, results }, rebuilt, mismatched };
}

const jsonLines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : null;

/**
 * A round's comparison again, from its raw reports, with this tree's tools (`--rescore`): the rows' anchors rebuilt from
 * each cell's runs (so fields added since the round are read from the samples; G4's per-request phases from the raw
 * request logs, withRequestPhases), the manifest's exceptions, and any release controls (`--release-control <dir with
 * perf-report.json>`, repeatable).
 */
export function rescore(dir, controls = []) {
  const read = (p) => JSON.parse(readFileSync(join(dir, p), "utf8"));
  const phased = (side) => {
    const report = read(`${side}/perf-report.json`),
      requests = jsonLines(join(dir, side, "requests.jsonl")),
      loads = jsonLines(join(dir, side, "loads.jsonl"));
    if (!requests || !loads) return { report, rebuilt: 0, mismatched: [] };
    return withRequestPhases(report, requests, loads);
  };
  const cand = phased("production"),
    rel = phased("release");
  const candidateReport = cand.report,
    releaseReport = rel.report;
  const rebuild = (rows, report) => {
    const m = new Map(report.results.map((r) => [cellKey(r), r]));
    return rows.map((x) => ({
      ...x,
      ...(m.get(cellKey(x))?.perRun ? { readyAnchors: anchorsOverRuns(m.get(cellKey(x)).perRun) } : {}),
    }));
  };
  const profiles = [...new Set(candidateReport.results.map((r) => r.profile))];
  return {
    ...releaseComparison({
      candidateRows: rebuild(read("ratchet-rows.json"), candidateReport),
      releaseRows: rebuild(read("release-ratchet-rows.json"), releaseReport),
      candidateReport,
      releaseReport,
      release: read("release-comparison.json").release ?? null,
      expected: expectedCells(profiles),
      exceptions: JSON.parse(readFileSync(join(HERE, "manifests.json"), "utf8")).exceptions ?? [],
      releaseControls: controls.map((c) => ({
        name: c,
        rows: releaseControlRows(JSON.parse(readFileSync(join(c, "perf-report.json"), "utf8"))),
      })),
    }),
    requestPhases: {
      candidate: { rebuilt: cand.rebuilt, mismatched: cand.mismatched },
      release: { rebuilt: rel.rebuilt, mismatched: rel.mismatched },
    },
  };
}

/**
 * The G4/S1/S6 ratchet rows (lib/compare.mjs RatchetRow) of this run, per surface × state × profile (O214: every
 * profile, not only `default`): requests by phase and kinds (max of runs), document and worker brotli bytes and the
 * distribution from the build, the DOM at route-ready (max of runs), the anchors, and whether the cell's samples and
 * its chain loads were complete, with their reasons, so a comparison never reads an incomplete value as evidence.
 * Kept in the packet so the next round compares against them as "last release". `profile` filters to one.
 */
export function ratchetRows(report, sizes, profile = null) {
  return report.results
    .filter((r) => (profile === null || r.profile === profile) && r.manifest)
    .map((r) => ({
      page: r.page,
      state: r.state,
      profile: r.profile,
      byPhase: r.manifest.byPhase,
      kinds: r.manifest.kinds,
      documentBrBytes: sizes.document?.brotli,
      workerBrBytes: sizes.worker?.brotli,
      distributionBytes: { raw: sizes.distribution.raw, gzip: sizes.distribution.gzip, br: sizes.distribution.brotli },
      domElements: Math.max(...(r.perRun ?? []).map((x) => x.readyDomElements ?? -Infinity)),
      readyAnchors: anchorsOverRuns(r.perRun ?? []),
      readiness: {
        complete: r.readiness?.complete === true,
        reasons: r.readiness?.reasons ?? ["no readiness verdict"],
      },
      ...(r.chain
        ? {
            chainDepth: r.chain.depth,
            chainMethod: r.chain.method,
            chainComplete: r.chain.complete === true,
            chainReasons: r.chain.reasons ?? [],
          }
        : {}),
    }));
}

/**
 * Whether every variant the round ran left a complete collection (O214, claude-208): its summary.json says
 * `complete: true`. A variant without one (its lab crashed) is incomplete too. `readSummary(out)` returns the parsed
 * summary.json of a variant's out directory or null. Returns [{variant, reason, cells}] for the incomplete ones.
 */
export function incompleteVariants(variants, readSummary) {
  const out = [];
  for (const [name, v] of Object.entries(variants ?? {})) {
    const summary = v?.out ? readSummary(v.out) : null;
    if (!summary) out.push({ variant: name, reason: `no summary.json (lab exit ${v?.exit ?? "unknown"})`, cells: [] });
    else if (summary.complete !== true)
      out.push({
        variant: name,
        reason: `${summary.incomplete?.length ?? "some"} incomplete cell(s)`,
        cells: summary.incomplete ?? [],
      });
  }
  return out;
}

const kb = (n) => (typeof n === "number" ? `${Math.round(n / 1024).toLocaleString("en")} KB` : "—");

/**
 * The packet's tables from a production perf-report.json and its requests.jsonl: requests by phase per surface ×
 * state (max of runs, default profile), bytes, readiness, cache, vitals, coverage, and the largest waste: wrong-target
 * reads, prefetched thumbnails and the worker on pages that draw no graph, with bytes. Evidence, not a verdict.
 */
export function summarise(dir) {
  const report = JSON.parse(readFileSync(join(dir, "perf-report.json"), "utf8"));
  const rows = readFileSync(join(dir, "requests.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const lines = [];
  for (const profile of Object.keys(report.profiles)) {
    lines.push(
      `### Requests per surface × state (${profile}; max of ${report.runs} runs)`,
      "",
      "| surface | load | requests | document | boot | data | stream | prefetch | idle | kinds | wrong-target | no entry | transfer (median) | ready ms | LCP ms | CLS | DOM at ready | complete |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of report.results.filter((x) => x.profile === profile && x.manifest)) {
      const m = r.manifest,
        p = m.byPhase;
      lines.push(
        `| ${r.page} | ${r.state} | ${m.requests}${m.varied ? ` (${m.varied.join("/")})` : ""} | ${p.document} | ${p.boot} | ${p.data} | ${p.stream} | ${p.prefetch} | ${p.idle} | ${m.kinds} | ${m.wrongTarget} | ${m.unmatched + m.overCount} | ${kb(r.metrics.transferBytes)} | ${r.metrics.routeReadyMs ?? "—"} | ${r.metrics.lcpMs ?? "—"} | ${r.metrics.cls ?? "—"} | ${r.metrics.readyDomElements ?? "—"} | ${r.readiness.complete ? "yes" : `no (${r.readiness.reasons.join("; ")})`} |`,
      );
    }
    lines.push("");
  }
  const def = Object.keys(report.profiles)[0];
  const cold = rows.filter((r) => r.state === "cold" && r.profile === def && r.run === 0);
  const pages = [...new Set(cold.map((r) => r.page))];
  const waste = new Map();
  const add = (key, reason, r) => {
    const w = waste.get(key) ?? { key, reason, pages: new Set(), count: 0, bytes: 0 };
    w.pages.add(r.page);
    w.count++;
    w.bytes += r.transferBytes ?? 0;
    waste.set(key, w);
  };
  const shownOn = report.shown ?? {};
  for (const r of cold) {
    if (
      /\/api\/(?:emphasis|comments|notes|walkthroughs|authoring\/open|authoring\/presentation|selection)/.test(
        r.url + (r.body ?? ""),
      ) &&
      /seq-awkward/.test(decodeURIComponent(r.url) + (r.body ?? ""))
    )
      add(
        "reads of the agent-presented seq-awkward (not shown)",
        "wrong target: the page shows another view or none",
        r,
      );
    else if (/\/api\/thumbnails\//.test(r.url) && r.page !== "project-diagrams")
      add("thumbnails on pages that show none", "fetched ahead; no thumbnail is visible", r);
    else if (
      /elk-layout-worker/.test(r.url) &&
      !["flow-diagram", "note", "note-alias"].includes(r.page) &&
      r.transferBytes > 0
    )
      add(
        "ELK worker on pages that draw no graph",
        "graph layout engine; the sequence, its editor, the empty draft and lists draw no graph (the note's figures and the flow page do)",
        r,
      );
    else if (
      /\/api\/comment-activity|\/api\/compile$/.test(r.url) &&
      !new URL(r.url).pathname.startsWith(`/p/${report.project}/`)
    )
      add(
        "other projects' badges (comment-activity, compile) on every page",
        "catalog badges for projects not shown",
        r,
      );
    else if (r.method === "POST" && /\/api\/selection/.test(r.url))
      add("selection write on load", "a write no input asked for", r);
  }
  lines.push(
    `### Largest waste on a cold load (${def}, run 0)`,
    "",
    "| item | why | pages | requests | transfer |",
    "|---|---|---|---|---|",
  );
  for (const w of [...waste.values()].sort((a, b) => b.bytes - a.bytes))
    lines.push(`| ${w.key} | ${w.reason} | ${w.pages.size} of ${pages.length} | ${w.count} | ${kb(w.bytes)} |`);
  lines.push("");
  const warm = report.results.filter((r) => r.cache);
  if (warm.length) {
    lines.push(
      "### Cache on the wire (G5, warm)",
      "",
      "| surface | profile | verdict | shell wire status | worker bytes | problems |",
      "|---|---|---|---|---|---|",
    );
    for (const r of warm)
      lines.push(
        `| ${r.page} | ${r.profile} | ${r.cache.verdict} | ${r.cache.shell?.wireStatus ?? "—"} | ${(r.cache.workers ?? []).map((w) => w.transferBytes).join(", ") || "—"} | ${r.cache.problems.join("; ") || "—"} |`,
      );
    lines.push("");
  }
  const cov = report.results.filter((r) => r.coverage);
  if (cov.length) {
    lines.push(
      "### Unused code on first load (S2)",
      "",
      `Max of ${report.runs} samples per cell, every profile; a cell with a missing sample or an unreadable script, worker or sheet is NOT EVALUATED. The last two columns are each run's own values (the A/A control, coverage-aa.json).`,
      "",
      "| surface | load | main JS | unused | worker JS | unused | CSS | unused | largest unused block | worker unused per run (B) | worker layouts per run |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    const perRun = (r) => {
      const runs = r.coverage.perRun ?? [];
      return `${runs.map((x) => x.workerJs ?? "—").join(" / ")} | ${runs.map((x) => (x.workerMessages ? (x.workerMessages.byCmd?.layout ?? 0) : "—")).join(" / ")}`;
    };
    for (const r of cov) {
      const c = r.coverage.summary;
      if (!c || !r.coverage.complete) {
        lines.push(
          `| ${r.page} (${r.profile}) | ${r.state} | NOT EVALUATED: ${(r.coverage.reasons ?? []).slice(0, 2).join("; ")} | | | | | | | | |`,
        );
        continue;
      }
      const pct = (x) => (x.unusedShare === null ? "—" : `${Math.round(x.unusedShare * 1000) / 10}%`);
      lines.push(
        `| ${r.page} (${r.profile}) | ${r.state} | ${kb(c.mainJs.totalBytes)} | ${pct(c.mainJs)} | ${kb(c.workerJs.totalBytes)} | ${pct(c.workerJs)} | ${kb(c.css.totalBytes)} | ${pct(c.css)} | ${kb(Math.max(c.mainJs.largestUnusedBytes, c.workerJs.largestUnusedBytes))} | ${perRun(r)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "### Main-thread work per load (S3; median of runs)",
    "",
    "| surface | profile | load | TaskDuration ms | Layouts | Style recalcs | React commits | long frames (blocking ms) | shifts after ready |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of report.results.filter((x) => x.metrics))
    lines.push(
      `| ${r.page} | ${r.profile} | ${r.state} | ${r.metrics.taskDurationMs ?? "—"} | ${r.metrics.layoutCount ?? "—"} | ${r.metrics.recalcStyleCount ?? "—"} | ${r.metrics.commits ?? "—"} | ${r.metrics.longFrames ? `${r.metrics.longFrames.count} (${r.metrics.longFrames.blockingMs})` : "—"} | ${r.metrics.shiftsAfterReady ?? "—"} |`,
    );
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      summarise: { type: "string" },
      out: { type: "string" },
      runs: { type: "string", default: "3" },
      profiles: { type: "string", default: "default,remote-link" },
      "skip-debug": { type: "boolean" },
      "skip-coverage": { type: "boolean" },
      release: { type: "string" },
      "release-tree": { type: "string" },
      "skip-release": { type: "boolean" },
      rescore: { type: "string" },
      "release-control": { type: "string", multiple: true },
    },
  });
  if (values.summarise) {
    process.stdout.write(summarise(resolve(values.summarise)));
    return;
  }
  if (values.rescore) {
    process.stdout.write(
      JSON.stringify(
        rescore(
          resolve(values.rescore),
          (values["release-control"] ?? []).map((c) => resolve(c)),
        ),
        null,
        1,
      ) + "\n",
    );
    return;
  }
  if (!values.out) {
    process.stderr.write(
      "usage: round.mjs --out <dir> [--runs 3] [--profiles default,remote-link] [--skip-debug] [--skip-coverage] [--release <ref>] [--release-tree <dir>] [--skip-release]\n",
    );
    process.exit(2);
  }
  const out = resolve(values.out);
  const release = values["skip-release"] ? null : resolveRelease(values.release ?? null);
  if (release?.error) {
    process.stderr.write(`round.mjs: ${release.error}\n`);
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const started = new Date();
  const host = {
    before: {
      loadPerCore: loadavg().map((l) => Math.round((l / cpus().length) * 100) / 100),
      pressure: pressure(),
      processes: spawnSync("ps", ["-eo", "pid,pcpu,etime,comm", "--sort=-pcpu"], { encoding: "utf8" })
        .stdout.split("\n")
        .slice(0, 25),
    },
  };
  const productionArgs = [
    "--profiles",
    values.profiles,
    "--runs",
    values.runs,
    "--chain",
    ...(values["skip-coverage"] ? [] : ["--coverage"]),
  ];
  let releaseInfo = null;
  if (release) {
    const tree = releaseTree({ commit: release.commit, tree: values["release-tree"] ?? null, out });
    releaseInfo = { ...release, tree, artifacts: artifactsOf(tree), sizes: buildSizes(tree) };
  }
  const manifest = {
    schema: "archer-perf-run/1",
    startedAt: started.toISOString(),
    target: testTarget({ lastRelease: releaseInfo ?? { error: "not measured (--skip-release)" } }),
    sizes: buildSizes(),
    host,
    variants: {},
    skipped: [],
  };
  manifest.variants.production = await variant("perf-round-prod", join(out, "production"), {
    debugUi: false,
    args: productionArgs,
  });
  if (releaseInfo) {
    const imp = (p) => import(pathToFileURL(join(releaseInfo.tree, p)).href);
    const [{ up: relUp, down: relDown }, { present: relPresent }] = await Promise.all([
      imp("tools/devkit/sandbox.mjs"),
      imp("tools/perf/fixture.mjs"),
    ]);
    manifest.variants.release = {
      ...(await variant("perf-round-release", join(out, "release"), {
        debugUi: false,
        args: productionArgs,
        tools: { up: relUp, down: relDown, present: relPresent },
        tree: releaseInfo.tree,
      })),
      commit: releaseInfo.commit,
      ref: releaseInfo.ref,
    };
  } else manifest.skipped.push("last release (--skip-release)");
  if (values["skip-debug"]) manifest.skipped.push("debug variant (--skip-debug)");
  else
    manifest.variants.debug = await variant("perf-round-debug", join(out, "debug"), {
      debugUi: true,
      args: ["--profiles", "default", "--runs", values.runs],
    });
  manifest.host.after = {
    loadPerCore: loadavg().map((l) => Math.round((l / cpus().length) * 100) / 100),
    pressure: pressure(),
  };
  manifest.finishedAt = new Date().toISOString();
  manifest.durationMs = Date.now() - started.getTime();
  writeFileSync(join(out, "run-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(out, "summary.md"), summarise(join(out, "production")));
  const candidateReport = JSON.parse(readFileSync(join(out, "production", "perf-report.json"), "utf8"));
  const candidateRows = ratchetRows(candidateReport, manifest.sizes);
  writeFileSync(join(out, "ratchet-rows.json"), JSON.stringify(candidateRows, null, 1) + "\n");
  // S2's A/A control: each cell's coverage runs of the candidate against each other (lib/coverage.mjs coverageAA).
  writeFileSync(join(out, "coverage-aa.json"), JSON.stringify(coverageAA(candidateReport), null, 1) + "\n");
  if (releaseInfo && existsSync(join(out, "release", "perf-report.json"))) {
    const releaseReport = JSON.parse(readFileSync(join(out, "release", "perf-report.json"), "utf8"));
    const releaseRows = ratchetRows(releaseReport, releaseInfo.sizes);
    writeFileSync(join(out, "release-ratchet-rows.json"), JSON.stringify(releaseRows, null, 1) + "\n");
    writeFileSync(join(out, "release-summary.md"), summarise(join(out, "release")));
    writeFileSync(join(out, "release-coverage-aa.json"), JSON.stringify(coverageAA(releaseReport), null, 1) + "\n");
    writeFileSync(
      join(out, "release-comparison.json"),
      JSON.stringify(
        releaseComparison({
          candidateRows,
          releaseRows,
          candidateReport,
          releaseReport,
          release: { ref: releaseInfo.ref, commit: releaseInfo.commit, artifacts: releaseInfo.artifacts },
          expected: expectedCells(
            values.profiles
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean),
          ),
          exceptions: JSON.parse(readFileSync(join(HERE, "manifests.json"), "utf8")).exceptions ?? [],
        }),
        null,
        1,
      ) + "\n",
    );
  }
  process.stdout.write(`${join(out, "run-manifest.json")}\n`);
  // A round with an incomplete variant is not a complete packet: say which, and exit 1 (the variants' own exits stay
  // in run-manifest.json; a variant's G1 misses alone, e.g. the release against this manifest, are not incompleteness).
  const incomplete = incompleteVariants(manifest.variants, (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    } catch {
      return null;
    }
  });
  if (incomplete.length) {
    process.stderr.write(
      `round.mjs: incomplete variant(s):\n${incomplete.map((v) => `  ${v.variant}: ${v.reason}${v.cells.length ? ` (${v.cells.slice(0, 12).join(", ")}${v.cells.length > 12 ? ", …" : ""})` : ""}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(2);
  });
