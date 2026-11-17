// S5 step traces (tools/perf/lib/trace.mjs): a long frame's time by class from a Chrome trace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { breakdown, clockOffset, frameBreakdown, markThread } from "../lib/trace.mjs";

const P = 10,
  T = 1,
  W = 7;
const X = (name, ts, dur, tid = T) => ({ ph: "X", name, ts, dur, pid: P, tid, cat: "devtools.timeline" });
const events = [
  { ph: "M", name: "thread_name", pid: P, tid: T, args: { name: "CrRendererMain" } },
  { ph: "M", name: "thread_name", pid: P, tid: W, args: { name: "DedicatedWorker thread" } },
  { ph: "R", name: "perf:step", cat: "blink.user_timing", pid: P, tid: T, ts: 1_000_000 },
  // A 60 ms task: 40 ms of script holding 10 ms of GC, then 10 ms of task glue; 5 ms idle; 20 ms of style and layout.
  X("RunTask", 1_000_000, 60_000),
  X("FunctionCall", 1_000_000, 40_000),
  X("MinorGC", 1_010_000, 10_000),
  X("RunTask", 1_065_000, 20_000),
  X("UpdateLayoutTree", 1_065_000, 12_000),
  X("Layout", 1_077_000, 8_000),
  // The worker busy for 30 ms meanwhile.
  X("RunTask", 1_000_000, 30_000, W),
  X("FunctionCall", 1_000_000, 30_000, W),
];

test("breakdown: exclusive time by class with nested events, idle where no task runs", () => {
  const b = breakdown(events, { pid: P, tid: T, fromUs: 1_000_000, toUs: 1_090_000 });
  assert.deepEqual(b.ms, { script: 30, gc: 10, style: 12, layout: 8, paint: 0, parse: 0, other: 20, idle: 10 });
  assert.equal(b.windowMs, 90);
  assert.equal(b.longest[0].durMs, 60);
  assert.equal(b.longest[0].biggestChild.name, "FunctionCall");
});

test("frameBreakdown: a LoAF frame in page ms, mapped by the step mark, split at renderStart, with worker load", () => {
  const main = markThread(events, "perf:step");
  assert.deepEqual(main, { pid: P, tid: T, ts: 1_000_000 });
  const offsetUs = clockOffset(main.ts, 7000); // the mark was at page time 7000 ms
  const f = frameBreakdown(
    events,
    { startTime: 7000, duration: 85, renderStart: 7065, styleAndLayoutStart: 7065, scripts: [] },
    { offsetUs, main },
  );
  assert.deepEqual(f.beforeRender.ms, {
    script: 30,
    gc: 10,
    style: 0,
    layout: 0,
    paint: 0,
    parse: 0,
    other: 20,
    idle: 5,
  });
  assert.deepEqual([f.render.ms.style, f.render.ms.layout], [12, 8]);
  assert.deepEqual(f.workers, [{ thread: "DedicatedWorker thread", busyMs: 30 }]);
});

test("classes: Blink's own style, layout and paint scopes are classed, not left as other", async () => {
  const { CLASSES } = await import("../lib/trace.mjs");
  const cls = (n) => CLASSES.find(([, re]) => re.test(n))?.[0] ?? "other";
  assert.equal(cls("Document::recalcStyle"), "style");
  assert.equal(cls("Blink.ForcedStyleAndLayout.UpdateTime"), "style");
  assert.equal(cls("LocalFrameView::performLayout"), "layout");
  assert.equal(cls("InlineNode::ShapeTextIncludingFirstLine"), "layout");
  assert.equal(cls("Blink.PrePaint.UpdateTime"), "paint");
  assert.equal(cls("V8.GC_SCAVENGER_SCAVENGE_PARALLEL"), "gc");
  assert.equal(cls("FunctionCall"), "script");
  assert.equal(cls("ThreadControllerImpl::RunTask"), "other");
});

test("markThread: a trace without the step's mark gives null (the journey reports the trace NOT EVALUATED)", () => {
  assert.equal(markThread(events, "perf:step:other"), null);
  assert.equal(markThread([], "perf:step"), null);
});
