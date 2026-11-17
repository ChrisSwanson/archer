// node --test tools/perf/test/compare.test.mjs
// Known passing and failing cases for the G4 timing estimator and ratchet (tools/perf/lib/compare.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAIL,
  NOT_EVALUATED,
  PASS,
  PASS_WITH_EXCEPTIONS,
  assess,
  confirm,
  floorFromAA,
  median,
  mulberry32,
  nextSampleSize,
  pairedEstimate,
  ratchet,
  verdict,
  commonAnchor,
  lateShiftChanges,
  anchorsOverRuns,
} from "../lib/compare.mjs";

/** n pairs of load times around `mean` ms with noise of about ±`spread`, B shifted by `shift` ms (seeded). */
function pairs(n, { seed, mean = 300, spread = 20, shift = 0 }) {
  const random = mulberry32(seed);
  const noise = () => (random() + random() + random() + random() - 2) * spread; // roughly normal, sd ≈ 0.58·spread
  return Array.from({ length: n }, () => ({ a: mean + noise(), b: mean + shift + noise() }));
}

test("median: odd and even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("pairedEstimate: deterministic for a seed, the interval holds the median, a missing side is refused", () => {
  const p = pairs(10, { seed: 7 });
  const one = pairedEstimate(p, { seed: 42 }),
    two = pairedEstimate(p, { seed: 42 });
  assert.deepEqual(one, two);
  assert.equal(one.n, 10);
  assert.equal(one.resamples, 10000);
  assert.ok(one.lo <= one.median && one.median <= one.hi, JSON.stringify(one));
  assert.throws(
    () =>
      pairedEstimate([
        { a: 1, b: 2 },
        { a: 1, b: undefined },
      ]),
    /missing or non-numeric/,
  );
  assert.throws(() => pairedEstimate([]), /at least one pair/);
});

test("A/A with identical distributions: a small floor, and B shifted by +100 ms is regressed", () => {
  const aa = pairedEstimate(pairs(10, { seed: 1 }), { seed: 1 });
  const floor = floorFromAA(aa);
  assert.ok(floor > 0 && floor < 40, `A/A floor ${floor} ms (noise sd ≈ 12 ms per side)`);
  const ab = pairedEstimate(pairs(10, { seed: 2, shift: 100 }), { seed: 1 });
  assert.equal(verdict(ab, floor), "regressed");
  assert.deepEqual(assess(ab, floor), { verdict: "regressed", status: FAIL, next: null, floor });
  // Known passing case: another A/B with no shift is not detected (interval inside ±floor) or at most straddles.
  const same = pairedEstimate(pairs(10, { seed: 3 }), { seed: 1 });
  assert.notEqual(verdict(same, floor), "regressed");
  // And a B 100 ms faster is improved.
  assert.equal(verdict(pairedEstimate(pairs(10, { seed: 4, shift: -100 }), { seed: 1 }), floor), "improved");
});

test("floorFromAA: the larger magnitude of the bounds", () => {
  assert.equal(floorFromAA({ lo: -12, hi: 7 }), 12);
  assert.equal(floorFromAA({ lo: -3, hi: 9 }), 9);
  assert.throws(() => floorFromAA({ lo: null, hi: 3 }));
});

test("verdict boundaries: strictly above the floor regresses; touching it straddles", () => {
  assert.equal(verdict({ lo: 21, hi: 60 }, 20), "regressed");
  assert.equal(verdict({ lo: 20, hi: 60 }, 20), "straddling");
  assert.equal(verdict({ lo: -60, hi: -21 }, 20), "improved");
  assert.equal(verdict({ lo: -60, hi: -20 }, 20), "straddling");
  assert.equal(verdict({ lo: -10, hi: 15 }, 20), "not-detected");
  assert.equal(verdict({ lo: -30, hi: 30 }, 20), "straddling");
});

test("sample size: 10, then +5 up to 30; still straddling at 30 is inconclusive (NOT EVALUATED)", () => {
  assert.deepEqual([0, 9, 10, 12, 15, 25, 29, 30, 31].map(nextSampleSize), [10, 10, 15, 15, 20, 30, 30, null, null]);
  const straddle = { n: 10, median: 18, lo: 5, hi: 40 };
  assert.deepEqual(assess(straddle, 20), { verdict: "straddling", status: "MORE SAMPLES", next: 15, floor: 20 });
  const atCap = assess({ ...straddle, n: 30 }, 20);
  assert.equal(atCap.verdict, "inconclusive");
  assert.equal(atCap.status, NOT_EVALUATED);
  assert.equal(atCap.next, null);
  // A straddling case built from data: a shift close to the floor at 10 pairs.
  const aa = pairedEstimate(pairs(10, { seed: 11 }), { seed: 5 });
  const floor = floorFromAA(aa);
  const near = pairedEstimate(pairs(10, { seed: 12, shift: floor }), { seed: 5 });
  assert.equal(assess(near, floor).next, 15, `shift = floor ${floor}: ${JSON.stringify({ lo: near.lo, hi: near.hi })}`);
  assert.equal(assess(near, null).status, NOT_EVALUATED);
});

test("confirm: a regression stands only when a second fresh run repeats it", () => {
  assert.deepEqual(confirm({ verdict: "regressed" }, { verdict: "regressed" }), {
    verdict: "confirmed regression",
    confirmed: true,
    status: FAIL,
  });
  assert.equal(confirm({ verdict: "regressed" }, { verdict: "not-detected" }).confirmed, false);
  assert.equal(confirm({ verdict: "regressed" }, { verdict: "not-detected" }).status, PASS);
  assert.equal(confirm({ verdict: "regressed" }, undefined).status, NOT_EVALUATED);
  assert.equal(confirm({ verdict: "regressed" }, { verdict: "inconclusive" }).status, NOT_EVALUATED);
  assert.equal(confirm({ verdict: "not-detected" }, undefined).status, PASS);
  assert.equal(confirm({ verdict: "inconclusive" }, undefined).status, NOT_EVALUATED);
  assert.equal(confirm({ verdict: "improved" }, { verdict: "improved" }).verdict, "confirmed improvement");
});

const row = (over = {}) => ({
  page: "diagram",
  state: "cold",
  byPhase: { document: 1, boot: 1, data: 4, stream: 1, prefetch: 0, idle: 0 },
  kinds: 5,
  documentBrBytes: 575722,
  workerBrBytes: 355003,
  distributionBytes: { raw: 4000000, gzip: 1190000, br: 950000 },
  domElements: 400,
  ...over,
});

test("ratchet: equal or lower passes; +1 request in data fails; an approved matching exception covers it", () => {
  const release = [row(), row({ state: "warm" })];
  assert.equal(ratchet([row(), row({ state: "warm", domElements: 390 })], release).status, PASS);

  const plusOne = [row({ byPhase: { ...row().byPhase, data: 5 } }), row({ state: "warm" })];
  const failed = ratchet(plusOne, release);
  assert.equal(failed.status, FAIL);
  const cell = failed.cells.find((c) => c.status === FAIL);
  assert.deepEqual(
    [cell.page, cell.state, cell.metric, cell.release, cell.candidate],
    ["diagram", "cold", "byPhase.data", 4, 5],
  );

  const ex = {
    id: "PERF-EX-3",
    metric: "byPhase.data",
    surfaces: ["diagram"],
    states: ["cold"],
    approval: { by: "maintainer", pr: "#1" },
  };
  const covered = ratchet(plusOne, release, { exceptions: [ex] });
  assert.equal(covered.status, PASS_WITH_EXCEPTIONS);
  assert.equal(covered.cells.find((c) => c.metric === "byPhase.data" && c.state === "cold").exception, "PERF-EX-3");

  // An exception that is unapproved, for another metric, surface or state, or below the new value, does not cover.
  for (const bad of [
    { ...ex, approval: undefined },
    { ...ex, metric: "byPhase.boot" },
    { ...ex, surfaces: ["note"] },
    { ...ex, states: ["warm"] },
    { ...ex, upTo: 4 },
    { ...ex, id: "EX-3" },
  ]) {
    assert.equal(ratchet(plusOne, release, { exceptions: [bad] }).status, FAIL, JSON.stringify(bad));
  }
});

test("ratchet: a missing field is NOT EVALUATED for that metric, never a pass", () => {
  const release = [row()];
  const { distributionBytes, ...noDist } = row();
  const result = ratchet([{ ...noDist, byPhase: { ...row().byPhase, idle: undefined } }], release);
  assert.equal(result.status, NOT_EVALUATED);
  const missing = result.cells
    .filter((c) => c.status === NOT_EVALUATED)
    .map((c) => c.metric)
    .sort();
  assert.deepEqual(missing, [
    "byPhase.idle",
    "distributionBytes.br",
    "distributionBytes.gzip",
    "distributionBytes.raw",
  ]);
  assert.equal(result.cells.filter((c) => c.status === PASS).length, 9);
  // A surface on one side only is NOT EVALUATED, and a FAIL elsewhere still wins.
  assert.equal(ratchet([row(), row({ page: "note" })], release).status, NOT_EVALUATED);
  assert.equal(ratchet([row({ kinds: 6 }), row({ page: "note" })], release).status, FAIL);
  assert.equal(ratchet([], []).status, NOT_EVALUATED);
});

// codex-02: the candidate's DOM at its mark was compared with the release's DOM predicate. Rows now carry their
// anchors and compare at the one both have.
const anchored = (page, anchors, extra = {}) => ({
  page,
  state: "cold",
  domElements: anchors.mark?.domElements ?? anchors.dom?.domElements,
  readyAnchors: anchors,
  ...extra,
});

test("DOM ratchet at a common anchor: a candidate with marks meets a release without them at the DOM predicate", () => {
  // Candidate 234 at its (early) mark, 337 at the DOM predicate; the release has only the DOM predicate, 343.
  const cand = [anchored("note", { mark: { domElements: 234 }, dom: { domElements: 337 } })];
  const rel = [anchored("note", { dom: { domElements: 343 } })];
  const cell = ratchet(cand, rel).cells.find((c) => c.metric === "domElements");
  assert.deepEqual([cell.status, cell.anchor, cell.candidate, cell.release], [PASS, "dom", 337, 343]);
  // A real rise at the shared anchor still fails.
  const up = ratchet(
    [anchored("projects", { dom: { domElements: 758 } })],
    [anchored("projects", { dom: { domElements: 756 } })],
  ).cells.find((c) => c.metric === "domElements");
  assert.equal(up.status, FAIL);
  // Both with marks: compared at the mark.
  assert.equal(
    commonAnchor(
      anchored("x", { mark: { domElements: 1 }, dom: { domElements: 2 } }),
      anchored("x", { mark: { domElements: 1 }, dom: { domElements: 9 } }),
    ).name,
    "mark",
  );
  // No common anchor, or anchors on one side only: NOT EVALUATED, not a pass or a fail.
  const none = ratchet(
    [anchored("g", { mark: { domElements: 900 } })],
    [anchored("g", { dom: { domElements: 100 } })],
  ).cells.find((c) => c.metric === "domElements");
  assert.equal(none.status, NOT_EVALUATED);
  assert.match(none.reason, /no common readiness anchor/);
  const oneSided = ratchet(
    [anchored("g", { dom: { domElements: 1 } })],
    [{ page: "g", state: "cold", domElements: 1 }],
  ).cells.find((c) => c.metric === "domElements");
  assert.equal(oneSided.status, NOT_EVALUATED);
});

const mv = (node, from, to, startTime = 900, path = `main > ${node}`) => ({
  node,
  path,
  from: { x: from, y: 10, width: 80, height: 30 },
  to: { x: to, y: 10, width: 80, height: 30 },
  startTime,
});
test("S6 late shifts by element and geometry at the common anchor: the release's chat-button shift is not new; a new element is", () => {
  const fab = mv("button.archer-chat-fab", 1300, 1290);
  const rel = [
    anchored("diagram", { dom: { domElements: 1, lateShifts: ["button.archer-chat-fab"], lateShiftElements: [fab] } }),
  ];
  assert.equal(
    lateShiftChanges(
      [
        anchored("diagram", {
          mark: { domElements: 1, lateShiftElements: [fab] },
          dom: { domElements: 1, lateShiftElements: [{ ...fab, startTime: 1200 }] },
        }),
      ],
      rel,
    ).status,
    PASS,
    "the same movement at another moment is not new",
  );
  const changed = lateShiftChanges(
    [
      anchored("diagram", {
        mark: { domElements: 1, lateShiftElements: [] },
        dom: { domElements: 1, lateShiftElements: [fab, mv("div.authoring-parts", 0, 0)] },
      }),
    ],
    rel,
  );
  assert.equal(changed.status, FAIL);
  assert.deepEqual(
    changed.cells[0].newMovements.map((m) => m.node),
    ["div.authoring-parts"],
  );
  assert.equal(
    lateShiftChanges([anchored("diagram", { mark: { domElements: 1, lateShiftElements: [] } })], rel).status,
    NOT_EVALUATED,
  );
  // Rows from before O215 carry only the joined signatures: NOT EVALUATED, not a signature comparison.
  const old = lateShiftChanges(
    [anchored("diagram", { dom: { domElements: 1, lateShifts: ["x"] } })],
    [anchored("diagram", { dom: { domElements: 1, lateShifts: ["x"] } })],
  );
  assert.equal(old.status, NOT_EVALUATED);
  assert.match(old.cells[0].reason, /no per-element shift records/);
});

// O215 (codex-207, claude-205): the release's warm tab motion recorded as one entry with its text and counter
// (`#text | button.archer-project-tab | span`), the candidate's as the tab alone, read as a new shift.
test("S6: the same motion attributed in a different grouping is not new; the same element moving differently is", async () => {
  const { shiftElements } = await import("../lib/vitals.mjs");
  const tab = {
    node: "button.archer-project-tab",
    path: "div.archer-project-tabs > button.archer-project-tab:2",
    previousRect: { x: 302, y: 120, width: 96, height: 32 },
    currentRect: { x: 308, y: 120, width: 96, height: 32 },
  };
  const text = {
    node: "#text",
    path: "div.archer-project-tabs > button.archer-project-tab:2 > #text",
    previousRect: { x: 318, y: 128, width: 20, height: 16 },
    currentRect: { x: 324, y: 128, width: 20, height: 16 },
  };
  const count = {
    node: "span",
    path: "div.archer-project-tabs > button.archer-project-tab:2 > span.archer-project-tab-count",
    previousRect: { x: 360, y: 128, width: 8, height: 16 },
    currentRect: { x: 360, y: 128, width: 16, height: 16 },
  };
  const release = shiftElements([{ startTime: 640.12, sources: [text, tab, count] }]);
  const candidate = shiftElements([
    { startTime: 612.5, sources: [tab] },
    { startTime: 629.3, sources: [text, count] },
  ]);
  const row = (els) =>
    anchored("project-notes", { dom: { domElements: 1, lateShiftElements: els } }, { state: "warm" });
  assert.equal(lateShiftChanges([row(candidate)], [row(release)]).status, PASS);
  // The joined source sets differ, which the old comparison counted as new.
  const { shiftSignature } = await import("../lib/vitals.mjs");
  assert.notEqual(shiftSignature({ sources: [tab] }), shiftSignature({ sources: [text, tab, count] }));
  // Negative control: the tab moving from another place (counts painted as 0, then widened) is a new movement.
  const moved = shiftElements([
    { startTime: 612.5, sources: [{ ...tab, previousRect: { ...tab.previousRect, x: 300 } }] },
  ]);
  const failed = lateShiftChanges([row(moved)], [row(release)]);
  assert.equal(failed.status, FAIL);
  assert.deepEqual(failed.cells[0].newShifts, [
    "div.archer-project-tabs > button.archer-project-tab:2 Δx8 Δy0 Δw0 Δh0",
  ]);
  // The same motion with the whole row placed 4 px lower (the page above it changed) is not new (live run, O215).
  const lower = (r) => ({ ...r, y: r.y + 4 });
  const placed = shiftElements([
    {
      startTime: 612.5,
      sources: [{ ...tab, previousRect: lower(tab.previousRect), currentRect: lower(tab.currentRect) }],
    },
  ]);
  assert.equal(lateShiftChanges([row(placed)], [row(release)]).status, PASS);
  // Over runs: each movement once, the union of the runs.
  const over = anchorsOverRuns([
    { readyAnchors: { dom: { domElements: 1, lateShiftElements: candidate } } },
    { readyAnchors: { dom: { domElements: 1, lateShiftElements: [...candidate, ...moved] } } },
  ]);
  assert.equal(over.dom.lateShiftElements.length, 4);
  assert.equal(
    anchorsOverRuns([
      { readyAnchors: { dom: { domElements: 1, lateShiftElements: [] } } },
      { readyAnchors: { dom: { domElements: 1 } } },
    ]).dom.lateShiftElements,
    undefined,
  );
});

// O223 (r3 packet, 12 of 14 S6 FAIL cells): a layout-shift source whose previous and current rects are equal. The
// Layout Instability spec lists a source only when its starting point moved ≥ 3 px (§2.1–2.2), and the entry's score
// (7.716e-7 = 2 × 16 × 15 / (1440 × 900) × 3 / 1440) is a 3 px move: it is a movement, which the rects do not show.
// The key read "Δx0 Δy0 Δw0 Δh0", as if nothing moved.
test("S6: a source with equal rects is a movement the rects do not describe; a real 1 px move keys by its motion", async () => {
  const { shiftElements, movementKey } = await import("../lib/vitals.mjs");
  const box = { x: 392, y: 326, width: 16, height: 15 };
  const path = "button.archer-project-tab:2 > span.archer-project-tab-count > #text";
  const count = shiftElements([
    { startTime: 478.7, sources: [{ node: "#text", path, previousRect: box, currentRect: box }] },
  ]);
  const row = (els) => anchored("project-notes", { dom: { domElements: 1, lateShiftElements: els } });
  const s6 = lateShiftChanges([row(count)], [row([])]);
  assert.equal(s6.status, FAIL, "still a new late movement");
  assert.deepEqual(s6.cells[0].newShifts, [`${path} moved, rects unchanged (16×15)`]);
  assert.doesNotMatch(movementKey(count[0]), /Δx0 Δy0 Δw0 Δh0/);
  // The same text node making the same unreported motion on the release is not new.
  assert.equal(
    lateShiftChanges(
      [row(count)],
      [
        row(
          shiftElements([
            {
              startTime: 420,
              sources: [{ node: "#text", path, previousRect: { ...box, x: 390 }, currentRect: { ...box, x: 390 } }],
            },
          ]),
        ),
      ],
    ).status,
    PASS,
  );
  // Negative control: a real 1 px move is a motion, keyed by it, and still counts.
  const nudged = shiftElements([
    { startTime: 478.7, sources: [{ node: "#text", path, previousRect: box, currentRect: { ...box, x: 393 } }] },
  ]);
  const one = lateShiftChanges([row(nudged)], [row(count)]);
  assert.equal(one.status, FAIL);
  assert.deepEqual(one.cells[0].newShifts, [`${path} Δx1 Δy0 Δw0 Δh0`]);
});

// Rubric v2.4 item 2 (in force; replaces v2.3 item 1's at-ready sums, which failed one existing read per collection,
// a different cell each time): G4 compares requests by phase per request. A read is a phase rise only when the release
// made no read of the same request (method + manifest pattern) in that load in any phase, or made fewer of it.
const PHASE_NAMES = ["document", "boot", "data", "stream", "prefetch", "idle"];
const loadRun = (reads, nearAnchor = []) => {
  const byPhase = Object.fromEntries(PHASE_NAMES.map((p) => [p, 0])),
    byRequest = {};
  for (const [pattern, phase, n = 1] of reads) {
    byPhase[phase] += n;
    (byRequest[pattern] ??= {})[phase] = (byRequest[pattern][phase] ?? 0) + n;
  }
  return { readyAnchors: { dom: { domElements: 700, byPhase, nearAnchor, byRequest } } };
};
const BASE_READS = [
  ["GET /", "document"],
  ["GET /assets/index-:hash.js", "boot"],
  ["GET /assets/index-:hash.css", "boot"],
  ["GET /p/:project/api/notes", "data", 6],
  ["GET /p/:project/api/events", "stream"],
];
const CONNECTION = "GET /p/:project/api/connection";

test("G4 per request (v2.4): a read the release made in another phase passes; a new request, or more of one, fails", () => {
  const row = (runs) => ({
    page: "project-notes",
    state: "cold",
    profile: "default",
    readyAnchors: anchorsOverRuns(runs),
  });
  const g4 = (c, r) => ratchet([c], [r], { metrics: PHASE_NAMES.map((p) => `byPhase.${p}`) }).cells;
  const cell = (cells, p) => cells.find((x) => x.metric === `byPhase.${p}`);
  // r3 project-notes × cold × default: the connection read (http-connection.ts negotiate(), unchanged since v0.10.0)
  // started 14.4 ms before the DOM anchor in 1 of 3 candidate runs, after it in the other two and in every release run.
  const near = [{ pattern: CONNECTION, phase: "data", deltaMs: -14.4 }];
  const release = row(
    [0, 1, 2].map(() =>
      loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 2], [CONNECTION, "data"]], near),
    ),
  );
  const cand = row([
    loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 1], [CONNECTION, "idle"]]),
    loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 1], [CONNECTION, "data"]], near),
    loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 1], [CONNECTION, "data"]], near),
  ]);
  const ok = g4(cand, release);
  assert.ok(
    ok.every((x) => x.status === PASS),
    JSON.stringify(ok.filter((x) => x.status !== PASS)),
  );
  const idle = cell(ok, "idle");
  assert.deepEqual([idle.candidate, idle.release], [1, 0], "the bare idle count rose");
  assert.match(
    idle.reason,
    /1 more at the anchor in this phase, each a request the release made in another phase \(GET \/p\/:project\/api\/connection\)/,
  );
  assert.deepEqual(idle.perRequest.moved, [
    { pattern: CONNECTION, candidate: 1, release: 0, releasePhases: { data: 1 } },
  ]);
  assert.deepEqual(
    cell(ok, "data").readsWithinAFrameOfAnchor,
    { candidate: 1, release: 1 },
    "near reads still reported",
  );
  // A request the release never made, in the data phase: FAIL, even with the data count unchanged.
  const added = row(
    [0, 1, 2].map(() =>
      loadRun([
        ...BASE_READS,
        ["GET /p/:project/api/compile", "data", 1],
        ["GET /p/:project/api/new-thing", "data"],
        [CONNECTION, "data"],
      ]),
    ),
  );
  const fresh = cell(g4(added, release), "data");
  assert.deepEqual([fresh.status, fresh.candidate, fresh.release], [FAIL, 9, 9]);
  assert.match(
    fresh.reason,
    /GET \/p\/:project\/api\/new-thing: a new request \(1 in data; the release made none in any phase\)/,
  );
  // One more read of an existing request, in one run: FAIL.
  const extra = row([
    loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 2], [CONNECTION, "data", 2]]),
    loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 2], [CONNECTION, "data"]]),
    loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 2], [CONNECTION, "data"]]),
  ]);
  const more = cell(g4(extra, release), "data");
  assert.equal(more.status, FAIL);
  assert.match(more.reason, /GET \/p\/:project\/api\/connection: 2 reads over all phases against the release's 1/);
  // A read moved to another phase that the release also made, but more of it overall: still FAIL.
  const movedMore = row(
    [0, 1, 2].map(() =>
      loadRun([...BASE_READS, ["GET /p/:project/api/compile", "data", 2], [CONNECTION, "data"], [CONNECTION, "idle"]]),
    ),
  );
  assert.equal(cell(g4(movedMore, release), "idle").status, FAIL);
  // Rows without per-request phases (collected before v2.4): NOT EVALUATED, never the bare count.
  const old = {
    ...release,
    readyAnchors: { dom: { ...release.readyAnchors.dom, byRequest: undefined, requestTotals: undefined } },
  };
  const ne = cell(g4(cand, old), "data");
  assert.equal(ne.status, NOT_EVALUATED);
  assert.match(
    ne.reason,
    /no per-request phases at the common anchor \(dom\) on the last release \(collected before rubric v2.4\)/,
  );
  assert.equal(
    anchorsOverRuns([
      loadRun(BASE_READS),
      { readyAnchors: { dom: { domElements: 1, byPhase: loadRun(BASE_READS).readyAnchors.dom.byPhase } } },
    ]).dom.byRequest,
    undefined,
    "a run without per-request phases",
  );
});

// O228 (r3 note × warm × remote-link, project-diagrams × warm × default): the candidate's "new" late movements were the
// release's own, made just before its DOM anchor in the 3 runs collected (and after it on other loads and profiles).
test("S6: a new late movement the release makes before its anchor is still new, and is named as such", () => {
  const cap = mv("figcaption.archer-note-figure-caption", 377, 377);
  const lower = { ...cap, to: { ...cap.to, y: 14 } };
  const run = (late, early) => ({
    readyAnchors: { dom: { domElements: 1, lateShiftElements: late, earlyShiftElements: early } },
  });
  const rel = [
    {
      page: "note",
      state: "warm",
      profile: "remote-link",
      readyAnchors: anchorsOverRuns([run([], [lower]), run([], [lower]), run([], [])]),
    },
  ];
  const cand = [
    {
      page: "note",
      state: "warm",
      profile: "remote-link",
      readyAnchors: anchorsOverRuns([run([lower], []), run([], [lower]), run([], [lower])]),
    },
  ];
  assert.equal(rel[0].readyAnchors.dom.earlyShiftElements.length, 1);
  const cell = lateShiftChanges(cand, rel).cells[0];
  assert.deepEqual(
    [cell.status, cell.releaseMakesBeforeAnchor],
    [FAIL, ["main > figcaption.archer-note-figure-caption Δx0 Δy4 Δw0 Δh0"]],
  );
  // A movement the release never makes is new without the note; rows without early records give no note.
  const other = lateShiftChanges([{ ...cand[0], readyAnchors: anchorsOverRuns([run([mv("p", 0, 3)], [])]) }], rel)
    .cells[0];
  assert.deepEqual([other.status, other.releaseMakesBeforeAnchor], [FAIL, undefined]);
  assert.equal(
    lateShiftChanges(cand, [{ ...rel[0], readyAnchors: { dom: { domElements: 1, lateShiftElements: [] } } }]).cells[0]
      .releaseMakesBeforeAnchor,
    undefined,
  );
});

// O229 (codex-301/307): movements compare by structural identity; one without it is not matched by description; a
// shift with no source is a movement too; a release control adds release evidence (O228, codex-302).
test("S6 identity: unidentified movements are NOT EVALUATED, a sourceless shift counts, release controls add evidence", async () => {
  const { shiftElements, movementKey } = await import("../lib/vitals.mjs");
  const row = (els, profile = "default") => ({
    page: "project-diagrams",
    state: "warm",
    profile,
    readyAnchors: { dom: { domElements: 1, lateShiftElements: els } },
  });
  const bare = { ...mv("span", 285, 293), path: undefined };
  const ne = lateShiftChanges([row([bare])], [row([bare])]).cells[0];
  assert.equal(ne.status, NOT_EVALUATED);
  assert.match(ne.reason, /without a structural identity/);
  assert.equal(lateShiftChanges([row([])], [row([bare])]).cells[0].status, PASS, "nothing late on the candidate");
  const none = shiftElements([{ startTime: 600, value: 0.002, sources: [] }]);
  assert.equal(
    lateShiftChanges([row(none)], [row([])]).cells[0].status,
    FAIL,
    "a shift with no source never passes silently",
  );
  // The facts line's movement, absent from the release's three runs, present in a release control: not new.
  const facts = mv("span", 285, 293, 513.3, "p.archer-project-facts > span[data-fact=notes]:2");
  const base = lateShiftChanges([row([facts])], [row([])]);
  assert.equal(base.cells[0].status, FAIL);
  const withControl = lateShiftChanges([row([facts])], [row([])], {
    releaseControls: [[row([{ ...facts, startTime: 520 }])]],
  }).cells[0];
  assert.deepEqual([withControl.status, withControl.matchedInReleaseControls], [PASS, [movementKey(facts)]]);
  // A control for another profile, or another element moving alike, does not match.
  assert.equal(
    lateShiftChanges([row([facts])], [row([])], { releaseControls: [[row([facts], "remote-link")]] }).cells[0].status,
    FAIL,
  );
  assert.equal(
    lateShiftChanges([row([facts])], [row([])], {
      releaseControls: [[row([{ ...facts, path: "p.archer-project-facts > span[data-fact=diagrams]:1" }])]],
    }).cells[0].status,
    FAIL,
  );
});

test("anchors over runs: only anchors every run has, max DOM and the union of shift signatures", () => {
  const a = anchorsOverRuns([
    { readyAnchors: { mark: { domElements: 230, lateShifts: ["a"] }, dom: { domElements: 337, lateShifts: [] } } },
    { readyAnchors: { mark: { domElements: 234, lateShifts: ["b"] } } },
  ]);
  assert.deepEqual(a, { mark: { domElements: 234, lateShifts: ["a", "b"] } });
  assert.equal(anchorsOverRuns([{ readyAnchors: { dom: { domElements: 1 } } }, {}]), undefined);
});

test("shift signature: React's generated ids are dropped, so the same element matches across builds", async () => {
  const { shiftSignature } = await import("../lib/vitals.mjs");
  const a = shiftSignature({ sources: [{ node: "div#_r_6_-diagrams.panel" }, { node: "button.archer-chat-fab" }] });
  const b = shiftSignature({ sources: [{ node: "div#_r_1a_-diagrams.panel" }, { node: "button.archer-chat-fab" }] });
  assert.equal(a, b);
  assert.equal(a, "button.archer-chat-fab | div.panel");
  assert.equal(shiftSignature({ sources: [{ node: "div#:r3:" }] }), "div");
  assert.equal(shiftSignature({ sources: [{ node: "main#app" }] }), "main#app");
  assert.equal(shiftSignature({}), "(no source)");
});

// O213 (codex-201, claude-201): G4 counted each build's requests by phase at its own ready source, the candidate's
// mark and v0.10.0's DOM anchor; the projects page's three compile reads then sat on either side of ready.
test("G4 requests by phase at the common anchor: the candidate's mark is not compared with the release's DOM anchor", () => {
  const phases = (data, idle) => ({ document: 1, boot: 2, data, stream: 1, prefetch: 0, idle });
  const req = (data, idle) => ({
    byRequest: { "GET /p/:project/api/x": { data, ...(idle ? { idle } : {}) } },
    requestTotals: { "GET /p/:project/api/x": data + idle },
  });
  const cand = [
    {
      page: "projects",
      state: "warm",
      byPhase: phases(8, 0),
      readyAnchors: {
        mark: { domElements: 700, byPhase: phases(8, 0), nearAnchor: 3, ...req(8, 0) },
        dom: { domElements: 700, byPhase: phases(5, 3), nearAnchor: 0, ...req(5, 3) },
      },
    },
  ];
  const rel = [
    {
      page: "projects",
      state: "warm",
      byPhase: phases(5, 3),
      readyAnchors: { dom: { domElements: 700, byPhase: phases(5, 3), nearAnchor: 1, ...req(5, 3) } },
    },
  ];
  const cells = ratchet(cand, rel).cells.filter((c) => c.metric.startsWith("byPhase."));
  const data = cells.find((c) => c.metric === "byPhase.data");
  assert.deepEqual([data.status, data.anchor, data.candidate, data.release], [PASS, "dom", 5, 5]);
  assert.ok(
    cells.every((c) => c.status === PASS),
    JSON.stringify(cells),
  );
  // Reads within a frame of the anchor are reported beside the count, never scored.
  assert.deepEqual(data.readsWithinAFrameOfAnchor, { candidate: 0, release: 1 });
  // Negative control: one more data read at the shared anchor still fails.
  const up = [
    {
      ...cand[0],
      readyAnchors: { ...cand[0].readyAnchors, dom: { domElements: 700, byPhase: phases(6, 3), ...req(6, 3) } },
    },
  ];
  const failed = ratchet(up, rel).cells.find((c) => c.metric === "byPhase.data");
  assert.deepEqual([failed.status, failed.anchor, failed.candidate, failed.release], [FAIL, "dom", 6, 5]);
  // A release whose anchor carries no phases (an older packet), or no anchor in common: NOT EVALUATED, never the
  // row's own-anchor counts.
  const old = ratchet(cand, [{ ...rel[0], readyAnchors: { dom: { domElements: 700 } } }]).cells.find(
    (c) => c.metric === "byPhase.data",
  );
  assert.equal(old.status, NOT_EVALUATED);
  assert.match(old.reason, /not phased at the common anchor \(dom\) on the last release/);
  const none = ratchet(cand, [{ ...rel[0], readyAnchors: {} }]).cells.find((c) => c.metric === "byPhase.data");
  assert.equal(none.status, NOT_EVALUATED);
  // Over runs: the max per phase at an anchor every run phased, and the most reads near it.
  const over = anchorsOverRuns([
    { readyAnchors: { dom: { domElements: 1, byPhase: phases(5, 3), nearAnchor: [{}] } } },
    { readyAnchors: { dom: { domElements: 1, byPhase: phases(6, 2), nearAnchor: [] } } },
  ]);
  assert.deepEqual([over.dom.byPhase.data, over.dom.byPhase.idle, over.dom.nearAnchor], [6, 3, 1]);
  assert.equal(
    anchorsOverRuns([
      { readyAnchors: { dom: { domElements: 1, byPhase: phases(5, 3) } } },
      { readyAnchors: { dom: { domElements: 1 } } },
    ]).dom.byPhase,
    undefined,
  );
});

// O234 (codex-401): the release's runs make one read each, once in data and once in idle (max 1 in each phase,
// total 1); the candidate makes both in one run (total 2). No phase's max rises, but the request does.
test("G4 per request: a read added in a phase the release used in another run still fails on the total", () => {
  const phases = (data, idle) => ({ document: 1, boot: 2, data, stream: 1, prefetch: 0, idle });
  const at = (data, idle, total) => ({
    domElements: 1,
    byPhase: phases(data, idle),
    byRequest: { "GET /p/:project/api/x": { data, idle } },
    requestTotals: { "GET /p/:project/api/x": total },
  });
  const row = (a) => [{ page: "project-notes", state: "cold", byPhase: a.byPhase, readyAnchors: { dom: a } }];
  const cells = ratchet(row(at(1, 1, 2)), row(at(1, 1, 1))).cells.filter((c) => c.metric.startsWith("byPhase."));
  for (const m of ["byPhase.data", "byPhase.idle"]) {
    const c = cells.find((x) => x.metric === m);
    assert.equal(c.status, FAIL, JSON.stringify(c));
    assert.match(c.reason, /2 reads over all phases against the release's 1/);
  }
  // Control: the same spread with equal totals passes.
  assert.ok(
    ratchet(row(at(1, 1, 1)), row(at(1, 1, 1)))
      .cells.filter((c) => c.metric.startsWith("byPhase."))
      .every((c) => c.status === PASS),
  );
});
