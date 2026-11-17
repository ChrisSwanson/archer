// node --test tools/perf/test/vitals.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VITALS_SCRIPT,
  clsOf,
  frameIntervals,
  inpOf,
  interactionsOf,
  loafSummary,
  p95,
  shiftsAfter,
  untimedInteractions,
} from "../lib/vitals.mjs";

const ev = (interactionId, name, startTime, duration, target = "button") => ({
  interactionId,
  name,
  startTime,
  duration,
  target,
});

test("interactionsOf: entries grouped by non-zero interactionId; latency is the longest entry", () => {
  const list = interactionsOf([
    ev(1, "pointerdown", 100, 24),
    ev(1, "pointerup", 140, 40),
    ev(1, "click", 141, 32),
    ev(0, "mouseover", 90, 80),
    ev(2, "keydown", 500, 16),
  ]);
  assert.equal(list.length, 2, "the interactionId 0 entry is no interaction");
  assert.deepEqual(
    list.map((x) => [x.id, x.latencyMs, x.startTime]),
    [
      [1, 40, 100],
      [2, 16, 500],
    ],
  );
  assert.deepEqual(list[0].names, ["pointerdown", "pointerup", "click"]);
});

test("inpOf: an interaction at 210 ms fails a 200 ms band; one at 200 ms passes it", () => {
  const bad = inpOf([ev(1, "click", 0, 48), ev(2, "click", 1000, 210)]);
  assert.equal(bad.inpMs, 210);
  assert.ok(bad.inpMs > 200, "fails the G7 band");
  assert.equal(bad.ignored, 0, "fewer than 50 interactions: nothing ignored");
  assert.ok(inpOf([ev(1, "click", 0, 200)]).inpMs <= 200, "exactly 200 ms is in the band (rubric boundary example)");
});

test("inpOf: the highest interaction per 50 is ignored (49 → none, 50 → one, 100 → two)", () => {
  const many = (n, spikes) => Array.from({ length: n }, (_, i) => ev(i + 1, "click", i * 100, spikes[i] ?? 24));
  assert.equal(inpOf(many(49, { 3: 400 })).inpMs, 400, "49 interactions: the spike counts");
  const fifty = inpOf(many(50, { 3: 400 }));
  assert.deepEqual(
    [fifty.inpMs, fifty.ignored, fifty.interactions],
    [24, 1, 50],
    "50 interactions: the single spike is ignored",
  );
  assert.equal(inpOf(many(50, { 3: 400, 7: 300 })).inpMs, 300, "a second spike in 50 is not");
  assert.equal(inpOf(many(100, { 3: 400, 7: 300, 9: 250 })).inpMs, 250, "100 interactions: two ignored");
  assert.deepEqual(inpOf([]), { inpMs: null, interactions: 0, ignored: 0, worst: null });
});

test("untimed interactions: a landed input with no entry is < 16 ms; with no input at all there is nothing to say", () => {
  const inputs = [
    { name: "pointerdown", startTime: 10 },
    { name: "keydown", startTime: 400 },
    { name: "wheel", startTime: 900 },
  ];
  assert.equal(
    untimedInteractions(inputs, [ev(1, "click", 12, 40)]),
    1,
    "the key press took < 16 ms; wheel is no interaction",
  );
  assert.equal(untimedInteractions([], [ev(1, "click", 12, 40)]), 0, "never negative");
  const fast = inpOf([], { untimed: 2 });
  assert.deepEqual([fast.inpMs, fast.under16, fast.interactions], [null, true, 2], "every interaction under 16 ms");
  assert.equal(inpOf([]).under16, undefined, "no interaction landed: the caller reports NOT EVALUATED");
  assert.equal(
    inpOf([ev(1, "click", 0, 300)], { untimed: 49 }).inpMs,
    null,
    "50 interactions, the one slow one ignored, the rest < 16 ms",
  );
});

test("clsOf: session windows (1 s gap, 5 s cap), recent input excluded, the largest window wins", () => {
  const s = (startTime, value, hadRecentInput = false) => ({ startTime, value, hadRecentInput });
  assert.equal(clsOf([s(0, 0.05), s(500, 0.05), s(2000, 0.08)]).cls, 0.1, "a 1.5 s gap splits: 0.1 vs 0.08");
  assert.equal(clsOf([s(0, 0.05), s(500, 0.5, true), s(900, 0.03)]).cls, 0.08, "a shift after input does not count");
  // Shifts every 900 ms keep one window going until it would pass 5 s.
  const chain = Array.from({ length: 8 }, (_, i) => s(i * 900, 0.02));
  const r = clsOf(chain);
  assert.equal(r.windows.length, 2, "the 5 s cap opens a second window");
  assert.equal(r.cls, 0.12);
  assert.ok(clsOf([s(0, 0.11)]).cls > 0.1, "0.11 fails the 0.1 band");
});

test("shiftsAfter: a shift after route-ready is found; one before it, or after input, is not", () => {
  const shifts = [
    { startTime: 300, value: 0.02, hadRecentInput: false },
    { startTime: 900, value: 0.01, hadRecentInput: false, sources: [{ node: "div.archer-diagram-panel" }] },
    { startTime: 950, value: 0.4, hadRecentInput: true },
  ];
  const late = shiftsAfter(shifts, 800);
  assert.equal(late.length, 1);
  assert.equal(late[0].sources[0].node, "div.archer-diagram-panel");
  assert.deepEqual(shiftsAfter(shifts, 1000), [], "nothing after a later ready: passes");
  assert.deepEqual(
    shiftsAfter(shifts, undefined),
    [],
    "no ready mark: nothing to judge (the caller reports it NOT EVALUATED)",
  );
});

test("loafSummary: frames in the window, blocking summed, an unattributed long frame is flagged", () => {
  const loaf = [
    {
      startTime: 100,
      duration: 130,
      blockingDuration: 80,
      renderStart: 220,
      styleAndLayoutStart: 222,
      scripts: [
        { invoker: "FrameRequestCallback", sourceURL: "http://h/app.js", sourceFunctionName: "tick", duration: 120 },
      ],
    },
    { startTime: 400, duration: 90, blockingDuration: 40, renderStart: 410, styleAndLayoutStart: 412, scripts: [] },
    { startTime: 700, duration: 40, blockingDuration: 0, scripts: [] },
    { startTime: 5000, duration: 200, blockingDuration: 150, scripts: [] },
  ];
  const s = loafSummary(loaf, { fromMs: 0, toMs: 1000 });
  assert.deepEqual(
    [s.count, s.blockingMs, s.longestMs],
    [2, 120, 130],
    "the 40 ms frame is not long; the 5000 ms one is outside",
  );
  assert.equal(s.unattributed.length, 1);
  assert.deepEqual(
    [s.unattributed[0].startTime, s.unattributed[0].styleAndLayoutStart, s.unattributed[0].renderStart],
    [400, 412, 410],
  );
  assert.equal(s.frames[0].attributed, true);
  const clean = loafSummary(loaf.slice(0, 1), { fromMs: 0, toMs: 1000 });
  assert.equal(clean.unattributed.length, 0, "an attributed frame passes the attribution rule");
});

test("frameIntervals and p95: steady 16.7 ms pacing vs one 120 ms stall", () => {
  const steady = Array.from({ length: 60 }, (_, i) => i * 16.7);
  assert.ok(Math.abs(p95(frameIntervals(steady)) - 16.7) < 1e-6);
  const stalled = [
    ...steady.slice(0, 30),
    ...steady.slice(30).map((t) => t + 120),
    ...Array.from({ length: 5 }, (_, i) => steady[59] + 120 + (i + 1) * 120),
  ];
  assert.ok(p95(frameIntervals(stalled)) >= 120, "repeated stalls raise the p95");
  assert.equal(p95([]), null);
  assert.equal(p95([5, 1, 3]), 5);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19, "nearest rank: ceil(0.95·20) = 19th value");
});

test("VITALS_SCRIPT keeps the page-load lab's fields and adds the new ones", () => {
  for (const f of [
    "fcp:",
    "lcp:",
    "cls:",
    "longTasks:",
    "ttfb:",
    "setResourceTimingBufferSize(5000)",
    "shifts:",
    "loaf:",
    "events:",
    "lcpElement:",
    "flush",
    "takeRecords",
    "durationThreshold: 16",
    "long-animation-frame",
  ])
    assert.ok(VITALS_SCRIPT.includes(f), f);
  assert.doesNotThrow(() => new Function(VITALS_SCRIPT), "it parses");
});

// O215: shift times were rounded to 0.1 ms while route-ready kept its precision, so a shift in the anchor's own frame
// could fall on either side of it.
test("VITALS_SCRIPT keeps a layout shift's start time unrounded", () => {
  const observers = {};
  class PerformanceObserver {
    constructor(fn) {
      this.fn = fn;
    }
    observe({ type }) {
      observers[type] = this.fn;
    }
    takeRecords() {
      return [];
    }
  }
  const window = {};
  const env = {
    window,
    PerformanceObserver,
    performance: { setResourceTimingBufferSize() {}, getEntriesByType: () => [] },
    addEventListener() {},
    requestAnimationFrame() {},
    document: { addEventListener() {} },
  };
  new Function(...Object.keys(env), VITALS_SCRIPT)(...Object.values(env));
  observers["layout-shift"]({
    getEntries: () => [{ value: 0.01, startTime: 500.04, hadRecentInput: false, sources: [] }],
  });
  assert.equal(window.__perfLab.shifts[0].startTime, 500.04);
  assert.deepEqual(shiftsAfter(window.__perfLab.shifts, 500.03).length, 1, "after a ready at 500.03 ms");
});
