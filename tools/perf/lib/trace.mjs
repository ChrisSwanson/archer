// What the main thread did inside a long animation frame (performance rubric S5, §6 LoAF: an unattributed long
// frame passes when its cause is named "from styleAndLayoutStart, renderStart or a trace"). Pure: a Chrome trace's
// events in, a time breakdown out. Used by tools/devkit/journeys/perf/canvas-pan.mjs's traced steps (codex-10: the
// 107.7 ms scriptless frame on entering the editor).
//
// Trace times are microseconds on the trace clock; LoAF times are page milliseconds (performance.now). The journey
// puts a `performance.mark` in the page at the step's start: its trace event's `ts` minus the mark's `startTime`
// is the offset between the two (`clockOffset`).

/** Event names by what they are; the first match wins. Everything else on the main thread is `other` (task glue). */
export const CLASSES = [
  ["gc", /^(MinorGC|MajorGC|V8\.GC|BlinkGC\.|ThreadState::|V8\.ScavengeTask|V8\.GCScavenger|V8\.GC_|CppGC)/],
  // Blink's own scopes (Document::recalcStyle, LocalFrameView::performLayout, Blink.*.UpdateTime) are the innermost
  // events in a real trace (canvas-pan's enter-edit step, 2026-11-04): without them style and layout read as `other`.
  [
    "style",
    /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|StyleRecalc|Document::(updateStyle|recalcStyle|rebuildLayoutTree|UpdateStyleAndLayout)|Blink\.(Style|ForcedStyleAndLayout)\.)/,
  ],
  [
    "layout",
    /^(Layout|LocalFrameView::(layout|performLayout|UpdateStyleAndLayout|RunStyleAndLayoutLifecyclePhases)|UpdateLayout|InlineNode::|LayoutView::|Blink\.Layout\.|IntersectionObserverController::computeIntersections|ResizeObserver)/,
  ],
  [
    "paint",
    /^(Paint|PrePaint|Blink\.(PrePaint|Paint|CompositingCommit|UpdateLayers?)\.|Layerize|UpdateLayer|UpdateLayerTree|CompositeLayers|Commit|PaintImage|Decode)/,
  ],
  ["parse", /^(ParseHTML)/],
  [
    "script",
    /^(FunctionCall|EvaluateScript|v8\.|V8\.|RunMicrotasks|TimerFire|FireAnimationFrame|EventDispatch|XHRReadyStateChange|HandlePostMessage|ScheduledAction|RequestAnimationFrame|v8\.callFunction|v8\.run|v8\.compile)/,
  ],
];
const classOf = (name) => CLASSES.find(([, re]) => re.test(name))?.[0] ?? "other";

/** The trace's thread names, by "pid:tid". */
export function threadNames(events) {
  const names = new Map();
  for (const e of events)
    if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
  return names;
}

/** The renderer main thread that holds `markName` (the step's mark), as {pid, tid, ts}; null when absent. */
export function markThread(events, markName) {
  const m = events.find((e) => e.name === markName && /user_timing|blink/.test(e.cat ?? ""));
  return m ? { pid: m.pid, tid: m.tid, ts: m.ts } : null;
}

/** Trace µs minus page ms × 1000 for a mark whose page `startTime` is known. */
export const clockOffset = (markTs, markStartMs) => markTs - markStartMs * 1000;

/**
 * Exclusive time by class on one thread inside [fromUs, toUs] (trace µs): complete events (`ph: "X"`) nest by
 * time and each instant goes to the innermost event's class; time inside no event is `idle`. Returns ms, rounded
 * to 0.1, plus the longest tasks (top-level events) overlapping the window with their biggest child.
 */
export function breakdown(events, { pid, tid, fromUs, toUs }) {
  const xs = events
    .filter(
      (e) =>
        e.ph === "X" &&
        e.pid === pid &&
        e.tid === tid &&
        typeof e.dur === "number" &&
        e.ts < toUs &&
        e.ts + e.dur > fromUs,
    )
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const totals = { script: 0, gc: 0, style: 0, layout: 0, paint: 0, parse: 0, other: 0, idle: 0 };
  // A stack sweep (events on one thread nest): each instant goes to the innermost open event, idle when none.
  const stack = [];
  let cur = fromUs;
  const advance = (t) => {
    while (cur < t) {
      const top = stack.at(-1),
        topEnd = top ? Math.min(top.ts + top.dur, toUs) : Infinity,
        next = Math.min(t, topEnd);
      if (next > cur) totals[top ? classOf(top.name) : "idle"] += next - cur;
      cur = Math.max(cur, next);
      if (top && topEnd <= cur) stack.pop();
      else break;
    }
    while (stack.length && Math.min(stack.at(-1).ts + stack.at(-1).dur, toUs) <= cur) stack.pop();
  };
  for (const e of xs) {
    advance(Math.max(e.ts, fromUs));
    stack.push(e);
  }
  advance(toUs);
  const top = [];
  for (const e of xs) if (!top.some((t) => t.ts <= e.ts && t.ts + t.dur >= e.ts + e.dur)) top.push(e);
  const longest = top
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 5)
    .map((t) => {
      const children = xs.filter((c) => c !== t && c.ts >= t.ts && c.ts + c.dur <= t.ts + t.dur);
      const big = children.sort((a, b) => b.dur - a.dur)[0];
      return {
        name: t.name,
        startUs: t.ts,
        durMs: Math.round(t.dur / 100) / 10,
        biggestChild: big
          ? {
              name: big.name,
              durMs: Math.round(big.dur / 100) / 10,
              ...(big.args?.data?.url
                ? { url: String(big.args.data.url).replace(/([?&]token=)[^&#\s"]+/gi, "$1REDACTED") }
                : {}),
              ...(big.args?.data?.functionName ? { functionName: big.args.data.functionName } : {}),
            }
          : null,
      };
    });
  const ms = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v / 100) / 10]));
  return { windowMs: Math.round((toUs - fromUs) / 100) / 10, ms, longest };
}

/**
 * One long animation frame explained from the trace: the renderer main thread before `renderStart` (where a frame
 * with no script attribution spends its time) and from there to its end, and how busy each worker thread was over
 * the whole frame. `frame`: a LoAF record (page ms); `offsetUs`: clockOffset; `main`: {pid, tid}.
 */
export function frameBreakdown(events, frame, { offsetUs, main }) {
  const start = frame.startTime * 1000 + offsetUs,
    end = (frame.startTime + frame.duration) * 1000 + offsetUs;
  const render =
    typeof frame.renderStart === "number" && frame.renderStart > 0 ? frame.renderStart * 1000 + offsetUs : end;
  const names = threadNames(events);
  const workers = [...names]
    .filter(([key, n]) => key.startsWith(`${main.pid}:`) && /worker/i.test(n))
    .map(([key, n]) => {
      const tid = Number(key.split(":")[1]);
      const b = breakdown(events, { pid: main.pid, tid, fromUs: start, toUs: end });
      return { thread: n, busyMs: Math.round((b.windowMs - b.ms.idle) * 10) / 10 };
    });
  return {
    frame: {
      startTime: frame.startTime,
      duration: frame.duration,
      renderStart: frame.renderStart ?? null,
      styleAndLayoutStart: frame.styleAndLayoutStart ?? null,
      blockingDuration: frame.blockingDuration ?? null,
      scripts: (frame.scripts ?? []).length,
    },
    beforeRender: breakdown(events, { ...main, fromUs: start, toUs: render }),
    render: breakdown(events, { ...main, fromUs: render, toUs: end }),
    workers,
  };
}

/** Chrome trace categories for a step trace: main-thread tasks, V8 execution and GC, rendering, user timing. */
export const STEP_TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "v8.execute",
  "v8",
  "blink.user_timing",
  "toplevel",
  "disabled-by-default-v8.gc",
  "blink",
  "cc",
  "gpu",
];
