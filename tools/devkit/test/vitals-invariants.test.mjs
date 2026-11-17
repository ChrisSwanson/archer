// node --test tools/devkit/test/vitals-invariants.test.mjs
// interaction-latency and long-frame (rubric docs/quality/rubrics/performance.md S4, S5, §6 INP and LoAF).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interactionLatency,
  longFrames,
  resolveInvariants,
  runInvariants,
  summaryVitals,
} from "../harness/invariants.mjs";

const ev = (interactionId, name, startTime, duration) => ({
  interactionId,
  name,
  startTime,
  duration,
  target: "button.x",
});
const step = (events = [], inputs = [], loaf = []) => ({ from: 0, to: 10_000, events, inputs, loaf });
const fresh = () => ({ events: [], untimed: 0 });

test("interaction-latency: report only by default; with failAtMs 200 a 300 ms click fails, a 40 ms one passes", () => {
  const slow = step(
    [ev(1, "pointerdown", 100, 24), ev(1, "click", 110, 304)],
    [{ name: "pointerdown", startTime: 100 }],
  );
  const reported = interactionLatency(slow, fresh(), resolveInvariants()["interaction-latency"]);
  assert.equal(reported.ok, true, "report only by default");
  assert.deepEqual(
    [reported.details.worstMs, reported.details.journey.inpMs, reported.details.overBand],
    [304, 304, true],
  );
  const gated = interactionLatency(slow, fresh(), { failAtMs: 200 });
  assert.equal(gated.ok, false);
  assert.match(gated.details.reason, /304 ms, over 200 ms/);
  const quick = interactionLatency(
    step([ev(1, "click", 110, 40)], [{ name: "pointerdown", startTime: 100 }]),
    fresh(),
    { failAtMs: 200 },
  );
  assert.deepEqual([quick.ok, quick.details.worstMs, quick.details.overBand], [true, 40, false]);
});

test("interaction-latency: a landed input with no entry is < 16 ms; a declared input that never landed is NOT EVALUATED", () => {
  const r = interactionLatency(step([], [{ name: "keydown", startTime: 50 }]), fresh(), {});
  assert.deepEqual([r.ok, r.details.worstMs, r.details.under16, r.details.journey.inpMs], [true, "< 16", 1, "< 16"]);
  const missing = interactionLatency(step([], []), fresh(), {}, { interaction: true });
  assert.match(missing.skipped, /^NOT EVALUATED/);
  assert.match(interactionLatency(null, fresh(), {}, { interaction: true }).skipped, /^NOT EVALUATED/);
  assert.equal(
    interactionLatency(step([], []), fresh(), {}).skipped,
    "no input in this step",
    "a step without input is not an interaction step",
  );
});

test("interaction-latency: the journey INP spans steps, and the one-per-50 rule keeps a single spike from failing later steps", () => {
  const j = fresh();
  const s1 = interactionLatency(step([ev(1, "click", 0, 260)], [{ name: "pointerdown", startTime: 0 }]), j, {
    failAtMs: 200,
  });
  assert.equal(s1.ok, false);
  const s2 = interactionLatency(step([ev(2, "click", 0, 30)], [{ name: "pointerdown", startTime: 0 }]), j, {
    failAtMs: 200,
  });
  assert.equal(s2.ok, true, "a quick step after the slow one passes");
  assert.equal(s2.details.journey.inpMs, 260, "the journey INP remembers the spike");
  // 48 more quick interactions, the 50th interaction lets the spike be ignored.
  const s3 = interactionLatency(
    step(
      [],
      Array.from({ length: 48 }, (_, i) => ({ name: "keydown", startTime: i })),
    ),
    j,
    { failAtMs: 200 },
  );
  assert.deepEqual(
    [s3.details.journey.interactions, s3.details.journey.ignored, s3.details.journey.inpMs],
    [50, 1, 30],
  );
});

test("long-frame: attributed frames list their scripts; an unattributed one on an interaction step lists render timings, and fails when asked", () => {
  const loaf = [
    {
      startTime: 100,
      duration: 130,
      blockingDuration: 80,
      renderStart: 225,
      styleAndLayoutStart: 226,
      scripts: [
        {
          invoker: "FrameRequestCallback",
          invokerType: "user-callback",
          sourceURL: "http://h/projects/a/app.js",
          sourceFunctionName: "tick",
          sourceCharPosition: 42,
          duration: 120,
        },
      ],
    },
    { startTime: 400, duration: 90, blockingDuration: 40, renderStart: 405, styleAndLayoutStart: 410, scripts: [] },
  ];
  const v = step([], [{ name: "pointerdown", startTime: 90 }], loaf);
  const r = longFrames(v, resolveInvariants()["long-frame"]);
  assert.equal(r.ok, true, "report only by default");
  assert.deepEqual([r.details.count, r.details.blockingMs, r.details.interactionStep], [2, 120, true]);
  assert.deepEqual(r.details.attributed[0].scripts[0], {
    invoker: "FrameRequestCallback",
    invokerType: "user-callback",
    source: "app.js:42",
    fn: "tick",
    duration: 120,
  });
  assert.deepEqual(
    [
      r.details.unattributed[0].styleAndLayoutStart,
      r.details.unattributed[0].renderStart,
      r.details.unattributed[0].renderMs,
    ],
    [410, 405, 85],
  );
  assert.equal(longFrames(v, { failOnUnattributed: true }).ok, false);
  assert.equal(
    longFrames(step([], [], loaf), { failOnUnattributed: true }).ok,
    true,
    "not an interaction step: reported, not failed",
  );
  assert.equal(longFrames(v, { failAtMs: 100 }).ok, false, "a 130 ms frame over a 100 ms cap");
  assert.deepEqual(longFrames(step([], [], [{ startTime: 1, duration: 30, scripts: [] }]), {}).details, {
    count: 0,
    interactionStep: false,
  });
});

test("runInvariants runs both by default and leaves the others alone when the page has no observers", async () => {
  const names = Object.keys(resolveInvariants());
  assert.ok(names.includes("interaction-latency") && names.includes("long-frame"));
  assert.deepEqual(
    Object.keys(resolveInvariants({ "interaction-latency": false, "long-frame": false })).sort(),
    names.filter((n) => n !== "interaction-latency" && n !== "long-frame").sort(),
  );
  const only = resolveInvariants(
    Object.fromEntries(names.filter((n) => n !== "interaction-latency" && n !== "long-frame").map((n) => [n, false])),
  );
  const win = {
    pageErrors: [],
    console: [],
    failed: [],
    responses: [],
    requests: [],
    csp: [],
    navigations: [],
    keys: [],
  };
  const rs = await runInvariants(
    {
      page: null,
      window: win,
      warnings: [],
      meta: {},
      journey: fresh(),
      vitals: step([ev(1, "click", 5, 312)], [{ name: "pointerdown", startTime: 1 }]),
    },
    { ...only, "interaction-latency": { ...only["interaction-latency"], failAtMs: 200 } },
  );
  assert.deepEqual(
    rs.map((r) => [r.name, r.ok]),
    [
      ["interaction-latency", false],
      ["long-frame", true],
    ],
  );
  const none = await runInvariants({ page: null, window: win, warnings: [], meta: {} }, only);
  assert.deepEqual(
    none.map((r) => r.skipped),
    ["no vitals in this step", "no vitals in this step"],
  );
});

test("summaryVitals: telemetry INP wins; without it the last interaction-latency journey INP, named; no record stays absent", () => {
  const il = (inpMs, interactions) => ({
    name: "interaction-latency",
    ok: true,
    details: { worstMs: 40, journey: { inpMs, interactions, ignored: 2 } },
  });
  const steps = [
    { title: "a", invariants: [il(60, 10)] },
    { title: "b", invariants: [{ name: "interaction-latency", ok: true, skipped: "no input in this step" }] },
    { title: "c", invariants: [il(104, 115)] },
    { title: "d", invariants: [] },
  ];
  assert.deepEqual(summaryVitals({ CLS: 0.01, INP: 80 }, steps), { CLS: 0.01, INP: 80, INPSource: "telemetry" });
  const prod = summaryVitals(null, steps);
  assert.equal(prod.INP, 104);
  assert.equal(prod.interactions, 115);
  assert.match(prod.INPSource, /interaction-latency invariant.*"c"/);
  assert.equal(summaryVitals({ CLS: 0.02, INP: null }, steps).INP, 104);
  assert.equal(
    summaryVitals(null, [
      { title: "x", invariants: [{ name: "interaction-latency", ok: true, skipped: "no input in this step" }] },
    ]),
    null,
  );
  assert.deepEqual(summaryVitals({ CLS: 0 }, []), { CLS: 0 });
});
