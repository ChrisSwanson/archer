// The round's last-release handling (rubric §4, item 10 of the round 1 fixes): which release, which rubric version,
// and the comparison it writes. resolveRelease runs on a scratch git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  coverageChanges,
  expectedCells,
  incompleteVariants,
  ratchetRows,
  releaseComparison,
  releaseTree,
  resolveRelease,
  rubricVersion,
} from "../round.mjs";
import { PAGES } from "../page-load.mjs";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-round-test-"));
  const g = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  g("config", "tag.gpgsign", "false");
  const commit = (m) => {
    writeFileSync(join(dir, "f"), m);
    g("add", "f");
    g("commit", "-q", "-m", m);
    return g("rev-parse", "HEAD");
  };
  return { dir, g, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("release: the newest tag behind the candidate; a tag on the candidate itself is skipped; --release wins", () => {
  const r = repo();
  try {
    const first = r.commit("one");
    r.g("tag", "v0.9.0");
    const second = r.commit("two");
    r.g("tag", "-a", "v0.10.0", "-m", "0.10.0");
    r.commit("three");
    assert.deepEqual(resolveRelease(null, { cwd: r.dir }), { ref: "v0.10.0", tag: "v0.10.0", commit: second });
    assert.deepEqual(resolveRelease("v0.9.0", { cwd: r.dir }), { ref: "v0.9.0", tag: "v0.9.0", commit: first });
    r.g("tag", "v0.11.0");
    assert.equal(
      resolveRelease(null, { cwd: r.dir }).ref,
      "v0.10.0",
      "the candidate's own tag is not its last release",
    );
    assert.match(resolveRelease("nope", { cwd: r.dir }).error, /not a commit/);
  } finally {
    r.done();
  }
});

test("release tree: one at another commit is refused, not measured as the release", () => {
  const r = repo();
  try {
    r.commit("one");
    assert.throws(() => releaseTree({ commit: "0".repeat(40), tree: r.dir, out: r.dir }), /not the release 0000000/);
  } finally {
    r.done();
  }
});

test("rubric version: the frozen predicates' version with its minor, and the latest amendments", () => {
  assert.deepEqual(
    rubricVersion("# x\n\nStatus: frozen v2.1 (v2 adds G7; rulings recorded as amendments v2.2). More\n"),
    { version: "v2.1", amendments: "v2.2" },
  );
  assert.deepEqual(rubricVersion("Status: frozen v2 (2026-10-30)\n"), { version: "v2", amendments: null });
});

const cov = (page, mainUnused, complete = true) => ({
  page,
  state: "cold",
  profile: "default",
  coverage: {
    complete,
    summary: complete
      ? { mainJs: { unusedBytes: mainUnused }, workerJs: { unusedBytes: 0 }, css: { unusedBytes: 10 } }
      : null,
  },
});

test("S2 against the release: a rise in unused bytes fails, equal passes, an incomplete side is NOT EVALUATED", () => {
  const same = coverageChanges({ results: [cov("note", 100)] }, { results: [cov("note", 100)] });
  assert.equal(same.status, "PASS");
  const rose = coverageChanges({ results: [cov("note", 150)] }, { results: [cov("note", 100)] });
  assert.equal(rose.status, "FAIL");
  assert.match(rose.cells.find((c) => c.metric === "mainJs.unusedBytes").reason, /rose by 50 bytes/);
  assert.equal(
    coverageChanges({ results: [cov("note", 100)] }, { results: [cov("note", 0, false)] }).status,
    "NOT EVALUATED",
  );
  assert.equal(coverageChanges({ results: [cov("note", 100)] }, { results: [] }).status, "NOT EVALUATED");
});

test("release comparison: G4, S1 (kinds, chain depth), S2 and S6 from both sides' rows", () => {
  const row = (over) => ({
    page: "note",
    state: "cold",
    byPhase: { document: 1, boot: 2, data: 3, stream: 1, prefetch: 0, idle: 0 },
    kinds: 6,
    chainDepth: 3,
    documentBrBytes: 1,
    workerBrBytes: 1,
    distributionBytes: { raw: 1, gzip: 1, br: 1 },
    readyAnchors: {
      mark: {
        at: 1,
        domElements: 100,
        lateShifts: [],
        lateShiftElements: [],
        byPhase: { document: 1, boot: 2, data: 3, stream: 1, prefetch: 0, idle: 0 },
        byRequest: { "GET /p/:project/api/x": { data: 3 } },
        requestTotals: { "GET /p/:project/api/x": 3 },
      },
    },
    ...over,
  });
  const c = releaseComparison({
    candidateRows: [
      row({
        chainDepth: 4,
        readyAnchors: {
          mark: {
            at: 1,
            domElements: 90,
            lateShifts: ["div.x"],
            lateShiftElements: [
              {
                node: "div.x",
                path: "main > div.x",
                from: { x: 0, y: 0, width: 1, height: 1 },
                to: { x: 0, y: 4, width: 1, height: 1 },
                startTime: 5,
              },
            ],
            byPhase: { document: 1, boot: 2, data: 3, stream: 1, prefetch: 0, idle: 0 },
            byRequest: { "GET /p/:project/api/x": { data: 3 } },
            requestTotals: { "GET /p/:project/api/x": 3 },
          },
        },
      }),
    ],
    releaseRows: [row({})],
    candidateReport: { results: [cov("note", 100)] },
    releaseReport: { results: [cov("note", 100)] },
    release: { ref: "v0.10.0" },
  });
  assert.equal(c.G4.status, "PASS");
  assert.equal(c.S1.status, "FAIL");
  assert.equal(c.S1.cells.find((x) => x.metric === "chainDepth").reason, "rose by 1 with no approved exception");
  assert.equal(c.S2.status, "PASS");
  assert.equal(c.S6.status, "FAIL");
  assert.deepEqual(
    c.S6.cells[0].newMovements.map((m) => m.node),
    ["div.x"],
  );
});

// O214 (codex-202, claude-208): ratchetRows kept only the default profile and dropped chain.complete and its reasons,
// so S1 scored 44 cells PASS while 8 release chains were incomplete and the remote-link profile was never compared.
const SIZES = { document: { brotli: 1 }, worker: { brotli: 1 }, distribution: { raw: 1, gzip: 1, brotli: 1 } };
const phases = { document: 1, boot: 2, data: 3, stream: 1, prefetch: 0, idle: 0 };
const labRow = (page, state, profile, over = {}) => ({
  page,
  state,
  profile,
  manifest: { byPhase: phases, kinds: 6 },
  perRun: [
    {
      readyDomElements: 300,
      readyAnchors: { dom: { domElements: 300, lateShifts: [], lateShiftElements: [], byPhase: phases } },
    },
  ],
  readiness: { complete: true, reasons: [] },
  chain: { depth: 3, method: "initiators + async stacks", complete: true, reasons: [] },
  ...over,
});
const report = (profiles, edit = (r) => r) => ({
  results: PAGES.flatMap((page) =>
    ["cold", "warm"].flatMap((state) => profiles.map((profile) => edit(labRow(page, state, profile)))),
  ),
});
const compare = (cand, rel, profiles = ["default", "remote-link"]) =>
  releaseComparison({
    candidateRows: ratchetRows(cand, SIZES),
    releaseRows: ratchetRows(rel, SIZES),
    candidateReport: { results: [] },
    releaseReport: { results: [] },
    release: { ref: "v0.10.0" },
    expected: expectedCells(profiles),
  });

test("S1 over the whole matrix: 88 kind/depth cells on both profiles; an incomplete chain is NOT EVALUATED, not compared", () => {
  const both = ["default", "remote-link"];
  const full = compare(report(both), report(both));
  assert.equal(full.S1.cells.length, 88);
  assert.equal(full.S1.status, "PASS");
  assert.equal(new Set(full.S1.cells.map((c) => c.profile)).size, 2);
  // One release chain incomplete (the release note's anchor never valid): that cell is NOT EVALUATED with the reason.
  const broken = report(both, (r) =>
    r.page === "note" && r.state === "cold" && r.profile === "remote-link"
      ? {
          ...r,
          chain: { depth: 2, method: "initiators + async stacks", complete: false, reasons: ["2 of 3 samples valid"] },
        }
      : r,
  );
  const s1 = compare(report(both), broken).S1;
  assert.equal(s1.status, "NOT EVALUATED");
  const cell = s1.cells.find(
    (c) => c.page === "note" && c.state === "cold" && c.profile === "remote-link" && c.metric === "chainDepth",
  );
  assert.equal(cell.status, "NOT EVALUATED");
  assert.match(cell.reason, /last release chain incomplete: 2 of 3 samples valid/);
  assert.equal(s1.cells.filter((c) => c.status === "NOT EVALUATED").length, 1);
  // Incomplete samples make every load-measured metric of the cell NOT EVALUATED, in G4 too; the build's bytes still compare.
  const short = report(both, (r) =>
    r.page === "note" && r.state === "warm" && r.profile === "default"
      ? { ...r, readiness: { complete: false, reasons: ["route-ready never reached"] } }
      : r,
  );
  const g4 = compare(short, report(both)).G4.cells.filter(
    (c) => c.page === "note" && c.state === "warm" && c.profile === "default",
  );
  assert.ok(
    g4
      .filter((c) => c.metric.startsWith("byPhase.") || c.metric === "kinds" || c.metric === "domElements")
      .every((c) => c.status === "NOT EVALUATED" && /candidate samples incomplete/.test(c.reason)),
  );
  assert.ok(g4.filter((c) => c.metric.startsWith("distributionBytes")).every((c) => c.status === "PASS"));
});

test("S1/G4/S6 with a profile omitted from one side, or from both: its cells are NOT EVALUATED, not left out", () => {
  const both = ["default", "remote-link"];
  const oneSided = compare(report(both), report(["default"]));
  assert.equal(oneSided.S1.cells.length, 88);
  assert.equal(oneSided.S1.status, "NOT EVALUATED");
  const missing = oneSided.S1.cells.filter((c) => c.status === "NOT EVALUATED");
  assert.equal(missing.length, 44);
  assert.ok(missing.every((c) => c.profile === "remote-link" && c.reason === "no last-release row"));
  assert.equal(oneSided.S6.status, "NOT EVALUATED");
  // Neither side collected remote-link but the round asked for it: still 88 cells, 44 NOT EVALUATED.
  const neither = compare(report(["default"]), report(["default"]));
  assert.equal(neither.S1.cells.filter((c) => c.status === "NOT EVALUATED").length, 44);
  assert.equal(neither.G4.status, "NOT EVALUATED");
  // A row from a packet before O214 has no profile: it is the default profile's.
  const legacy = ratchetRows(report(["default"]), SIZES).map(({ profile, ...rest }) => rest);
  const c = releaseComparison({
    candidateRows: ratchetRows(report(["default"]), SIZES),
    releaseRows: legacy,
    candidateReport: { results: [] },
    releaseReport: { results: [] },
    expected: expectedCells(["default"]),
  });
  assert.equal(c.S1.status, "PASS");
});

test("round exit: a variant whose summary is incomplete, or missing, is named", () => {
  const summaries = {
    "/a": { complete: true },
    "/b": { complete: false, incomplete: ["note/default/cold", "note-alias/default/warm"] },
  };
  const got = incompleteVariants(
    { production: { out: "/a", exit: 0 }, release: { out: "/b", exit: 1 }, debug: { out: "/c", exit: 2 } },
    (d) => summaries[d] ?? null,
  );
  assert.deepEqual(
    got.map((v) => v.variant),
    ["release", "debug"],
  );
  assert.deepEqual(got[0].cells, ["note/default/cold", "note-alias/default/warm"]);
  assert.match(got[1].reason, /no summary.json \(lab exit 2\)/);
  assert.deepEqual(
    incompleteVariants({ production: { out: "/a", exit: 1 } }, (d) => summaries[d] ?? null),
    [],
    "a G1 miss alone (exit 1, complete) is not incompleteness",
  );
});

// O216 (codex-203/206, claude-203): S2 compared the max of 3 coverage runs exactly, so a byte-identical worker whose
// runs vary (1,005,925 / 1,006,094 on either build; one 1,128,832 sample among 935,296s) read as new unused code.
const covRuns = (page, profile, workerRuns, layouts = workerRuns.map(() => 1)) => ({
  page,
  state: "cold",
  profile,
  coverage: {
    complete: true,
    summary: {
      mainJs: { unusedBytes: 100 },
      workerJs: { unusedBytes: Math.max(...workerRuns) },
      css: { unusedBytes: 10 },
    },
    perRun: workerRuns.map((w, i) => ({
      mainJs: 100,
      workerJs: w,
      css: 10,
      workerMessages: { count: layouts[i] + 2, byCmd: { layout: layouts[i], nest: 2 }, layouts: [] },
    })),
  },
});
const workerCell = (cmp, page) => cmp.cells.find((c) => c.page === page && c.metric === "workerJs.unusedBytes");

test("S2 A/A: a rise where one build's own runs vary is NOT EVALUATED with both ranges; a deterministic rise still fails", async () => {
  // A/A control: the same report against itself passes everywhere, and coverageAA names the varying cells.
  const { coverageAA } = await import("../lib/coverage.mjs");
  const same = {
    results: [
      covRuns("note-alias", "default", [1006094, 1005925, 1005925]),
      covRuns("flow-diagram", "remote-link", [935465, 935465, 935465]),
    ],
  };
  assert.equal(coverageChanges(same, same).status, "PASS");
  const aa = coverageAA(same);
  assert.equal(aa.varying, 1);
  assert.deepEqual(
    aa.cells.find((c) => c.page === "note-alias" && c.metric === "workerJs.unusedBytes").runs,
    [1006094, 1005925, 1005925],
  );
  // The +169 alias cell: the candidate's runs vary on an identical worker: NOT EVALUATED, not FAIL.
  const alias = coverageChanges(
    { results: [covRuns("note-alias", "default", [1006094, 1005925, 1005925])] },
    { results: [covRuns("note-alias", "default", [1005925, 1005925, 1005925])] },
  );
  const a = workerCell(alias, "note-alias");
  assert.deepEqual([a.status, a.maxOfRuns], ["NOT EVALUATED", "FAIL"]);
  assert.match(
    a.reason,
    /rose by 169 bytes at the max of runs, but the A\/A runs vary and overlap \(candidate 1005925–1006094 over 3 runs\)/,
  );
  // One high sample among equal ones (+193,367 at the max): NOT EVALUATED with the range.
  const spike = workerCell(
    coverageChanges(
      { results: [covRuns("flow-diagram", "default", [1128832, 935296, 935296])] },
      { results: [covRuns("flow-diagram", "default", [935296, 935296, 935296])] },
    ),
    "flow-diagram",
  );
  assert.equal(spike.status, "NOT EVALUATED");
  assert.deepEqual([spike.aa.candidate.min, spike.aa.candidate.max, spike.aa.release.varies], [935296, 1128832, false]);
  // Deterministic on both sides: the release always laid out one more graph (its warm-up): still FAIL, explained.
  const warm = workerCell(
    coverageChanges(
      { results: [covRuns("flow-diagram", "remote-link", [935465, 935465, 935465])] },
      { results: [covRuns("flow-diagram", "remote-link", [912907, 912907, 912907], [2, 2, 2])] },
    ),
    "flow-diagram",
  );
  assert.equal(warm.status, "FAIL");
  assert.match(warm.reason, /rose by 22558 bytes/);
  assert.equal(warm.workNote, "the last release posted 1 more layout(s) to its worker in 3 of 3 runs");
  assert.deepEqual(warm.layoutsPerRun, { candidate: [1, 1, 1], release: [2, 2, 2] });
  // claude-302: ranges that do not overlap are a rise in every pairing, a determinate FAIL however each side varies.
  const disjoint = workerCell(
    coverageChanges(
      { results: [covRuns("flow-diagram", "remote-link", [935296, 935465, 935465])] },
      { results: [covRuns("flow-diagram", "remote-link", [912738, 912907, 912907])] },
    ),
    "flow-diagram",
  );
  assert.equal(disjoint.status, "FAIL");
  assert.match(
    disjoint.reason,
    /every candidate run \(935296–935465\) is above every last-release run \(912738–912907\)/,
  );
  // Touching ranges overlap: still NOT EVALUATED.
  assert.equal(
    workerCell(
      coverageChanges(
        { results: [covRuns("x", "default", [10, 12, 12])] },
        { results: [covRuns("x", "default", [9, 10, 10])] },
      ),
      "x",
    ).status,
    "NOT EVALUATED",
  );
  // No tolerance: one byte more, every run alike, fails.
  assert.equal(
    workerCell(
      coverageChanges(
        { results: [covRuns("x", "default", [11, 11, 11])] },
        { results: [covRuns("x", "default", [10, 10, 10])] },
      ),
      "x",
    ).status,
    "FAIL",
  );
});

// PERF-EX-1 (rubric v2.3 ruling 2, v2.4 item 1): flow-diagram × remote-link × cold and warm worker unused bytes, scoped
// to that profile. covers() ignored the profile, so the record would have covered the default profile's cell too.
test("PERF-EX-1: the manifest's record covers the r3 cell on remote-link only, up to its bound; the validator accepts it", async () => {
  const { readFileSync } = await import("node:fs");
  const { validateManifest } = await import("../lib/manifest.mjs");
  const { covers } = await import("../lib/compare.mjs");
  const manifest = JSON.parse(readFileSync(new URL("../manifests.json", import.meta.url), "utf8"));
  assert.deepEqual(validateManifest(manifest), []);
  const ex = manifest.exceptions.find((e) => e.id === "PERF-EX-1");
  assert.deepEqual(
    [ex.metric, ex.surfaces, ex.states, ex.profiles, ex.upTo, ex.review],
    ["workerJs.unusedBytes", ["flow-diagram"], ["cold", "warm"], ["remote-link"], 935465, "0.12.0"],
  );
  const cell = { page: "flow-diagram", state: "cold", metric: "workerJs.unusedBytes", candidate: 935465 };
  assert.equal(covers(ex, { ...cell, profile: "remote-link" }), true);
  assert.equal(covers(ex, { ...cell, profile: "default" }), false, "another profile");
  assert.equal(covers(ex, cell), false, "a row without a profile is default");
  assert.equal(covers(ex, { ...cell, profile: "remote-link", candidate: 935466 }), false, "one byte over its bound");
  assert.equal(
    covers({ ...ex, profiles: undefined }, { ...cell, profile: "default" }),
    true,
    "no profiles: every profile",
  );
  // Through S2: the r3 cell (release runs vary) and the deterministic rise both read PASS WITH APPROVED EXCEPTIONS on
  // remote-link; the same rise on default still fails.
  const r3 = coverageChanges(
    { results: [covRuns("flow-diagram", "remote-link", [935465, 935465, 935465], [0, 0, 0])] },
    { results: [covRuns("flow-diagram", "remote-link", [912907, 912738, 912907])] },
    { exceptions: manifest.exceptions },
  );
  const c = workerCell(r3, "flow-diagram");
  assert.deepEqual(
    [c.status, c.exception, c.maxOfRuns, r3.status],
    ["PASS WITH APPROVED EXCEPTIONS", "PERF-EX-1", "FAIL", "PASS WITH APPROVED EXCEPTIONS"],
  );
  const onDefault = coverageChanges(
    { results: [covRuns("flow-diagram", "default", [935465, 935465, 935465])] },
    { results: [covRuns("flow-diagram", "default", [912907, 912907, 912907])] },
    { exceptions: manifest.exceptions },
  );
  assert.equal(workerCell(onDefault, "flow-diagram").status, "FAIL");
  // The warm cell (v2.4): covered at its measured values, and not above the bound (a 1,128,832 sample is the invalid
  // report shape, claude-303, which the lab retakes; were it counted it would fail, not be excused).
  const warmCell = (runs) =>
    workerCell(
      coverageChanges(
        { results: [{ ...covRuns("flow-diagram", "remote-link", runs), state: "warm" }] },
        { results: [{ ...covRuns("flow-diagram", "remote-link", [912738, 912738, 912738]), state: "warm" }] },
        { exceptions: manifest.exceptions },
      ),
      "flow-diagram",
    );
  assert.deepEqual(
    [warmCell([935465, 935296, 935465]).status, warmCell([935465, 935296, 935465]).exception],
    ["PASS WITH APPROVED EXCEPTIONS", "PERF-EX-1"],
  );
  assert.deepEqual(
    [warmCell([1128832, 935465, 935296]).status, warmCell([1128832, 935465, 935296]).exception],
    ["FAIL", undefined],
  );
  // Nor another surface, nor an unapproved copy of the record.
  const note = workerCell(
    coverageChanges(
      { results: [covRuns("note", "remote-link", [935465, 935465, 935465])] },
      { results: [covRuns("note", "remote-link", [912907, 912907, 912907])] },
      { exceptions: manifest.exceptions },
    ),
    "note",
  );
  assert.equal(note.status, "FAIL");
  const unapproved = coverageChanges(
    { results: [covRuns("flow-diagram", "remote-link", [935465, 935465, 935465])] },
    { results: [covRuns("flow-diagram", "remote-link", [912907, 912907, 912907])] },
    { exceptions: [{ ...ex, approval: undefined }] },
  );
  assert.equal(workerCell(unapproved, "flow-diagram").status, "FAIL");
  // The ratchet scopes by profile too.
  const { ratchet } = await import("../lib/compare.mjs");
  const g4 = {
    id: "PERF-EX-9",
    metric: "kinds",
    surfaces: ["note"],
    states: ["cold"],
    profiles: ["remote-link"],
    approval: "maintainer",
  };
  const rows = (profile, kinds) => [{ page: "note", state: "cold", profile, kinds }];
  assert.equal(
    ratchet(rows("remote-link", 6), rows("remote-link", 5), { metrics: ["kinds"], exceptions: [g4] }).status,
    "PASS WITH APPROVED EXCEPTIONS",
  );
  assert.equal(
    ratchet(rows("default", 6), rows("default", 5), { metrics: ["kinds"], exceptions: [g4] }).status,
    "FAIL",
  );
  // A malformed record is refused by the validator.
  const bad = validateManifest({
    ...manifest,
    exceptions: [{ ...ex, profiles: [], approval: undefined, review: "" }],
  }).join("\n");
  for (const p of [/profiles must be/, /approval/, /review is required/]) assert.match(bad, p);
});

// Rubric v2.4 item 2: G4 compares per request, and packets collected before v2.4 carry no per-request phases.
// `--rescore` rebuilds them from the raw request logs, and only where the rebuild reproduces the lab's byPhase.
test("rescore: per-request phases rebuilt from the raw logs at each anchor, refused where the rebuild differs", async () => {
  const { withRequestPhases } = await import("../round.mjs");
  const { anchorPhases, shownFor } = await import("../lib/manifest.mjs");
  const at = { page: "project-notes", profile: "default", state: "cold", run: 0 };
  const rows = [
    {
      ...at,
      method: "GET",
      url: "https://h/projects/awkward/",
      type: "Document",
      startMs: 1000,
      endMs: 1010,
      requestId: "1",
    },
    {
      ...at,
      method: "GET",
      url: "https://h/p/awkward/api/notes",
      type: "Fetch",
      startMs: 1040,
      endMs: 1050,
      requestId: "2",
    },
    {
      ...at,
      method: "GET",
      url: "https://h/p/awkward/api/connection",
      type: "Fetch",
      startMs: 1300,
      endMs: 1310,
      requestId: "3",
    },
  ];
  const truth = anchorPhases({
    rows,
    shown: shownFor("project-notes", { project: "awkward" }),
    anchors: { dom: { readyMs: 1100 } },
  }).dom;
  const report = (byPhase) => ({
    project: "awkward",
    shown: {},
    results: [
      {
        page: "project-notes",
        profile: "default",
        state: "cold",
        perRun: [{ readyAnchors: { dom: { at: 100, byPhase } } }],
      },
    ],
  });
  const ok = withRequestPhases(report(truth.byPhase), rows, [{ ...at, readyMs: 1100, inView: [] }]);
  assert.deepEqual([ok.rebuilt, ok.mismatched], [1, []]);
  assert.deepEqual(ok.report.results[0].perRun[0].readyAnchors.dom.byRequest, truth.byRequest);
  assert.equal(truth.byRequest["GET /p/:project/api/connection"].idle, 1);
  const off = withRequestPhases(report({ ...truth.byPhase, data: truth.byPhase.data + 1 }), rows, []);
  assert.deepEqual([off.rebuilt, off.mismatched], [0, ["project-notes/default/cold/0 dom"]]);
  assert.equal(off.report.results[0].perRun[0].readyAnchors.dom.byRequest, undefined);
});
