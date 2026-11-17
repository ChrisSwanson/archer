// node --test tools/devkit/test/flow-metrics.test.mjs
// The pure parts of the user-flows collectors: trace comparison, the stability rule, matrix cells and the §5 report.
// The browser-backed proofs (a pass and a seeded fault per collector) are flows/demo/prove-collectors.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareTrace,
  flowRecorder,
  installRevealWatch,
  kindOf,
  revealedAt,
  sameCounts,
} from "../harness/flow-metrics.mjs";
import { diffState } from "../harness/round-trip.mjs";
import { cellVerdict, cellsOf, commentSubmissionOf, pinCheck, stability } from "../journeys/flows/run.mjs";
import { buildReport, mergeRuns } from "../../quality/flow-report.mjs";

const pinned = [
  { action: "open project", class: "essential" },
  { action: "open diagram", class: "essential" },
];

test("a trace equal to its pinned baseline matches and passes the U2 ratchet", () => {
  const c = compareTrace(pinned, pinned);
  assert.equal(c.matches, true);
  assert.equal(c.ratchet, "pass");
  assert.deepEqual(c.counts, { essential: 2, safety: 0, overhead: 0, total: 2 });
});

test("an injected overhead action is extra, wherever it falls, and fails the ratchet", () => {
  const c = compareTrace([pinned[0], { action: "dismiss a tip", class: "overhead" }, pinned[1]], pinned);
  assert.deepEqual(
    c.extra.map((e) => e.action),
    ["dismiss a tip"],
  );
  assert.equal(c.missing.length, 0);
  assert.equal(c.overheadOverBaseline, 1);
  assert.equal(c.ratchet, "fail");
});

test("a safety action is not overhead (U2 boundary), and a skipped action is missing", () => {
  const c = compareTrace([pinned[0], { action: "confirm discard", class: "safety" }], pinned);
  assert.equal(c.ratchet, "pass");
  assert.deepEqual(
    c.missing.map((m) => m.action),
    ["open diagram"],
  );
  assert.equal(c.matches, false);
});

test("a class change on the same action is reported", () => {
  const c = compareTrace([pinned[0], { action: "open diagram", class: "overhead" }], pinned);
  assert.deepEqual(c.reclassed, [{ action: "open diagram", at: 1, baseline: "essential", now: "overhead" }]);
  assert.equal(c.ratchet, "fail");
});

test("the recorder counts agent calls made after the last action", async () => {
  const run = { steps: [], agentCalls: [] };
  const step = async (title, fn) => {
    const s = { title, ok: true };
    run.steps.push(s);
    try {
      return await fn();
    } catch {
      s.ok = false;
    }
  };
  const flow = flowRecorder({ step, run }, { id: "J0", baseline: pinned });
  await flow.act("open project", "essential", async () => {});
  run.agentCalls.push({ op: "list_diagrams", ok: true });
  assert.equal(JSON.parse(JSON.stringify(run)).flow.agentOps, 1);
  await assert.rejects(() => flow.act("x", "chore", async () => {}), /class must be one of/);
});

test("stability: run 1's counts must equal runs 2…N", () => {
  const a = { counts: { essential: 2, safety: 0, overhead: 0, total: 2 }, agentOps: 1 };
  const b = { counts: { essential: 2, safety: 0, overhead: 1, total: 3 }, agentOps: 1 };
  assert.equal(sameCounts(a, a), true);
  assert.equal(stability([a, a, a]).stable, true);
  assert.equal(stability([a, b, a]).stable, false);
  assert.equal(stability([a, null]).stable, false);
  assert.equal(stability([a, { ...a, agentOps: 2 }]).stable, false);
});

test("matrix: viewports × comment_submission; the default cell is 1440×900 immediate", () => {
  assert.deepEqual(
    cellsOf({ flow: {} }).map((c) => c.id),
    ["1440x900-immediate"],
  );
  assert.deepEqual(
    cellsOf({
      flow: {
        matrix: {
          viewports: [
            { width: 390, height: 844 },
            { width: 320, height: 640 },
          ],
          commentSubmission: ["immediate", "queued"],
        },
      },
    }).map((c) => c.id),
    ["390x844-immediate", "390x844-queued", "320x640-immediate", "320x640-queued"],
  );
  assert.equal(commentSubmissionOf({ configPath: "/nonexistent" }), "immediate");
  assert.equal(commentSubmissionOf({ commentSubmission: "queued" }), "queued");
});

test("round-trip diff: a dropped walkthrough step is a difference", () => {
  const want = {
    path: "/p/d.mmd",
    h1: "D",
    mode: "walkthrough",
    step: { n: 3, of: 4 },
    params: { walkthrough: "w", step: "3" },
  };
  assert.deepEqual(diffState(want, want, ["path", "mode", "step"]), []);
  const got = { ...want, step: { n: 1, of: 4 }, params: { walkthrough: "w" } };
  assert.deepEqual(
    diffState(want, got, ["path", "mode", "step", "params"]).map((d) => d.field),
    ["step", "params"],
  );
});

const flows = (overhead, verdict = "PASS") => ({
  journeys: [
    {
      id: "J2",
      baseline: pinned,
      cells: [
        {
          id: "1440x900-immediate",
          verdict,
          stable: true,
          runs: [
            {
              ok: verdict === "PASS",
              unseededErrors: 0,
              durationMs: 1,
              flow: {
                counts: { essential: 2, safety: 0, overhead, total: 2 + overhead },
                agentOps: 0,
                agentCalls: [],
                goal: { reached: true },
                comparison: compareTrace(
                  [...pinned, ...Array.from({ length: overhead }, () => ({ action: "detour", class: "overhead" }))],
                  pinned,
                ),
              },
            },
          ],
        },
      ],
    },
    {
      id: "J5",
      baseline: [],
      cells: [{ id: "1440x900-queued", verdict: "NOT EVALUATED", reason: "needs a queued sandbox", runs: [] }],
    },
  ],
});

test("report: the first round sets the baseline; NOT EVALUATED rows keep their reason", () => {
  const r = buildReport(mergeRuns([flows(0)]), null);
  assert.equal(r.baselineSet, true);
  assert.deepEqual(r.ratchetFailures, []);
  assert.equal(r.rows.find((x) => x.key === "overhead J2").comparison, "baseline set");
  assert.equal(r.rows.find((x) => x.key === "completion J5 1440x900-queued").reason, "needs a queued sandbox");
  assert.ok(r.notEvaluated.some((x) => x.key === "time J2"));
});

test("report: more overhead than the baseline, or a cell that stopped passing, is a ratchet failure", () => {
  const base = buildReport(mergeRuns([flows(0)]), null);
  assert.deepEqual(buildReport(mergeRuns([flows(0)]), base).ratchetFailures, []);
  assert.deepEqual(buildReport(mergeRuns([flows(1)]), base).ratchetFailures.sort(), [
    "overhead J2",
    "u2 J2 1440x900-immediate",
  ]);
  assert.ok(
    buildReport(mergeRuns([flows(0, "FAIL")]), base).ratchetFailures.includes("completion J2 1440x900-immediate"),
  );
});

test("a helper that does several actions in one step records each; a step adapter records only baseline actions", async () => {
  // The state journeys (J6–J9) act through ui.* helpers (one step, several actions) and through helpers that take a
  // `step` (composeComment, addComment): both must leave the trace the runner needs (summary.flow), or every cell fails.
  const baseline = [
    { action: "click Edit", class: "essential" },
    { action: "double-click node a", class: "essential" },
    { action: "type the new label", class: "essential" },
    { action: "press Enter", class: "essential" },
    { action: "click Discard (confirm)", class: "safety" },
  ];
  const run = { steps: [], agentCalls: [] };
  const step = async (title, fn) => {
    const s = { title, ok: true };
    run.steps.push(s);
    try {
      return await fn();
    } catch {
      s.ok = false;
    }
  };
  const flow = flowRecorder({ step, run }, { id: "J0", baseline });
  await flow.act("click Edit", "essential", async () => {});
  await flow.actions(baseline.slice(1, 4), async () => {});
  const traced = flow.stepFor(baseline);
  await traced("the page says it is saved", async () => {});
  await traced("click Discard (confirm)", async () => {});
  const f = JSON.parse(JSON.stringify(run)).flow;
  assert.deepEqual(
    f.actions.map((a) => [a.action, a.class, a.kind]),
    [
      ["click Edit", "essential", "click"],
      ["double-click node a", "essential", "click"],
      ["type the new label", "essential", "type"],
      ["press Enter", "essential", "key"],
      ["click Discard (confirm)", "safety", "click"],
    ],
  );
  assert.equal(f.comparison.matches, true);
  assert.equal(run.steps.length, 4);
  await assert.rejects(() => flow.actions([{ action: "x", class: "chore" }], async () => {}), /class must be one of/);
});

test("an action's kind from its words", () => {
  assert.deepEqual(
    [
      "click Save",
      "person two: double-click node b",
      "type the comment",
      "press c",
      "reload (F5)",
      "close the tab (Ctrl+W)",
      "scroll to: open project",
    ].map(kindOf),
    ["click", "click", "type", "key", "key", "key", "scroll"],
  );
});

test("report: collector checks per cell, and lost state or a duplicate effect is a ratchet failure", () => {
  const run = (checks) => ({
    run: 1,
    ok: true,
    flow: null,
    summary: "/nonexistent",
    unseededErrors: 0,
    durationMs: 1,
    flowChecks: checks,
  });
  const cellOf = (checks) => ({
    journeys: [
      {
        id: "J8d",
        name: "j08d",
        baseline: [],
        cells: [{ id: "1440x900-immediate", verdict: "PASS", stable: true, runs: [run(checks), run(checks)] }],
      },
    ],
  });
  const clean = buildReport(
    mergeRuns([
      cellOf([
        { gate: "G1", boundary: "b", ok: true },
        { gate: "G5", boundary: "one effect", ok: true },
        { gate: "G4", boundary: "true", ok: true },
      ]),
    ]),
    null,
  );
  assert.deepEqual(clean.rows.find((x) => x.key === "lost-dup J8d").detail, { lost: 0, duplicates: 0, checked: 4 });
  assert.equal(clean.rows.find((x) => x.key === "lost-dup J8d").comparison, "baseline set");
  assert.deepEqual(
    clean.checks.map((k) => [k.gate, k.held, k.failed]),
    [
      ["G1", 2, 0],
      ["G5", 2, 0],
      ["G4", 2, 0],
    ],
  );
  const dup = buildReport(mergeRuns([cellOf([{ gate: "G5", boundary: "one effect", ok: false }])]), null);
  assert.ok(dup.ratchetFailures.includes("lost-dup J8d"));
  assert.equal(dup.rows.find((x) => x.key === "lost-dup J8d").detail.duplicates, 2);
});

// claude-07, codex-05: Playwright's click scrolls a hidden target into view by itself, so the trace missed a scroll the
// person needs (J1 and J2: Pageturner at y = 1611 in a 900 px window; J10 at 320: the note link clipped by the sheet).
test("a target is revealed when its centre is inside the viewport and every clipping ancestor", () => {
  const viewport = { width: 1440, height: 900 };
  const at = (top, height = 20) => ({ left: 100, top, width: 200, height });
  assert.deepEqual(revealedAt({ rect: at(100), viewport, clips: [] }), { revealed: true });
  assert.deepEqual(revealedAt({ rect: at(1611), viewport, clips: [] }), { revealed: false, hiddenBy: "viewport" });
  assert.deepEqual(revealedAt({ rect: at(-40), viewport, clips: [] }), { revealed: false, hiddenBy: "viewport" });
  // Partly cut by the window's edge, its centre still showing: a person presses the part they see.
  assert.deepEqual(revealedAt({ rect: at(880, 30), viewport, clips: [] }), { revealed: true });
  // Inside the window but scrolled out of its sheet's body (J10 at 320×640: the link under the sheet's header).
  const sheet = { left: 0, top: 380, right: 320, bottom: 640, name: "div.archer-dock-sheet-body" };
  assert.deepEqual(revealedAt({ rect: at(296), viewport: { width: 320, height: 640 }, clips: [sheet] }), {
    revealed: false,
    hiddenBy: "div.archer-dock-sheet-body",
  });
  assert.deepEqual(revealedAt({ rect: at(457), viewport: { width: 320, height: 640 }, clips: [sheet] }), {
    revealed: true,
  });
  // Nothing measurable (no box): not judged here; the action's own wait reports it.
  assert.deepEqual(revealedAt({ rect: { left: 0, top: 2000, width: 0, height: 0 }, viewport, clips: [] }), {
    revealed: true,
  });
});

/** A stand-in for Playwright's Locator: `box` is what the page would measure for it. */
class FakeLocator {
  constructor(geometry) {
    this.geometry = geometry;
    this.clicks = 0;
  }
  async waitFor() {}
  async evaluate() {
    return this.geometry;
  }
  async click() {
    this.clicks++;
  }
}
const fakePage = { locator: () => new FakeLocator(null) };

test("an action on a hidden target records the scroll a person needs first; a shown one records none", async () => {
  installRevealWatch(fakePage);
  const run = { steps: [], agentCalls: [] };
  const step = async (title, fn) => {
    const s = { title, ok: true };
    run.steps.push(s);
    try {
      return await fn();
    } catch {
      s.ok = false;
    }
  };
  const viewport = { width: 1440, height: 900 };
  const below = new FakeLocator({ rect: { left: 0, top: 1611, width: 90, height: 20 }, viewport, clips: [] });
  const shown = new FakeLocator({ rect: { left: 0, top: 200, width: 90, height: 20 }, viewport, clips: [] });
  const flow = flowRecorder({ step, run, faults: new Set() }, { id: "J0", baseline: [] });
  await flow.act("open project Pageturner", "essential", () => below.click());
  await flow.act("open diagram Checkout", "essential", () => shown.click());
  // Outside an action (a setup step) nothing is recorded.
  await below.click();
  assert.equal(below.clicks, 2);
  const f = JSON.parse(JSON.stringify(run)).flow;
  assert.deepEqual(
    f.actions.map((a) => [a.action, a.class, a.kind]),
    [
      ["scroll to: open project Pageturner", "essential", "scroll"],
      ["open project Pageturner", "essential", "click"],
      ["open diagram Checkout", "essential", "click"],
    ],
  );
});

test("seeded fault drop-reveal-scroll: the collector forgets the scroll, and the pinned trace reports it missing", async () => {
  installRevealWatch(fakePage);
  const baseline = [
    { action: "scroll to: open project Pageturner", class: "essential" },
    { action: "open project Pageturner", class: "essential" },
  ];
  const below = new FakeLocator({
    rect: { left: 0, top: 1611, width: 90, height: 20 },
    viewport: { width: 1440, height: 900 },
    clips: [],
  });
  const trace = async (faults) => {
    const run = { steps: [], agentCalls: [] };
    const step = async (title, fn) => {
      run.steps.push({ title, ok: true });
      return fn();
    };
    const flow = flowRecorder({ step, run, faults }, { id: "J1", baseline });
    await flow.act("open project Pageturner", "essential", () => below.click());
    return JSON.parse(JSON.stringify(run)).flow.comparison;
  };
  assert.equal((await trace(new Set())).matches, true);
  const faulted = await trace(new Set(["drop-reveal-scroll"]));
  assert.equal(faulted.matches, false);
  assert.deepEqual(
    faulted.missing.map((m) => m.action),
    ["scroll to: open project Pageturner"],
  );
});

test("report: U2 has one row per cell that ran, each against its own pinned trace (PC-11)", () => {
  const cell = (id, overhead) => ({
    id,
    verdict: "PASS",
    stable: true,
    runs: [
      {
        ok: true,
        unseededErrors: 0,
        durationMs: 1,
        flow: {
          counts: { essential: 2, safety: 0, overhead, total: 2 + overhead },
          agentOps: 0,
          agentCalls: [],
          goal: { reached: true },
          comparison: compareTrace(
            [...pinned, ...Array.from({ length: overhead }, () => ({ action: "detour", class: "overhead" }))],
            pinned,
          ),
        },
      },
    ],
  });
  const r = buildReport(
    mergeRuns([
      {
        journeys: [
          { id: "J10", baseline: pinned, cells: [cell("1440x900-immediate", 0), cell("320x640-immediate", 1)] },
        ],
      },
    ]),
    null,
  );
  assert.deepEqual(
    r.rows.filter((x) => x.metric === "Overhead vs pinned trace (U2)").map((x) => [x.cell, x.comparison]),
    [
      ["1440x900-immediate", "pass"],
      ["320x640-immediate", "ratchet FAIL"],
    ],
  );
  assert.ok(r.ratchetFailures.includes("u2 J10 320x640-immediate"));
});

// A trace that misses its pinned actions used to print PASS (O96): the cell verdict judged ok and stability only.
const runOf = (run, actions, ok = true) => ({
  run,
  ok,
  flow: { counts: compareTrace(actions, pinned).counts, agentOps: 0, comparison: compareTrace(actions, pinned) },
});

test("pin rule: every run on its pinned trace passes", () => {
  const v = cellVerdict([runOf(1, pinned), runOf(2, pinned), runOf(3, pinned)], 3);
  assert.equal(v.verdict, "PASS");
  assert.equal(v.pin.matches, true);
});

test("pin rule: a run missing a pinned action fails the cell, though ok and stable, and the diff names it", () => {
  const short = [pinned[1]]; // "open project" not done
  const v = cellVerdict([runOf(1, short), runOf(2, short), runOf(3, short)], 3);
  assert.equal(v.ok, true);
  assert.equal(v.stable, true);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(
    v.pin.diff.map((d) => [d.run, d.missing.map((m) => m.action)]),
    [
      [1, ["open project"]],
      [2, ["open project"]],
      [3, ["open project"]],
    ],
  );
  assert.match(v.pin.text, /run 1: trace differs from the pinned trace\n {2}- open project \(essential, pinned at 1\)/);
});

test("pin rule: an extra essential action (a scroll the pin lacks) and a class change fail too", () => {
  const extra = cellVerdict([runOf(1, [{ action: "scroll to: open project", class: "essential" }, ...pinned])], 1);
  assert.equal(extra.verdict, "FAIL");
  assert.match(extra.pin.text, /\+ scroll to: open project \(essential, done at 1\)/);
  const reclassed = pinCheck([runOf(1, [pinned[0], { action: "open diagram", class: "safety" }])]);
  assert.equal(reclassed.matches, false);
  assert.match(reclassed.text, /~ open diagram: pinned essential, now safety/);
});

test("pin rule: a run with no trace fails", () => {
  const v = cellVerdict([{ run: 1, ok: true, flow: null }], 1);
  assert.equal(v.verdict, "FAIL");
  assert.match(v.pin.text, /no action trace/);
});
