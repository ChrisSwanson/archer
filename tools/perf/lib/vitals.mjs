// Web vitals in the lab: the in-page observers (VITALS_SCRIPT) and the pure arithmetic over what they record
// (rubric docs/quality/rubrics/performance.md §6 INP and LoAF, criteria G7, S4, S5, S6).
//
//   import { VITALS_SCRIPT, inpOf, clsOf, loafSummary } from "../perf/lib/vitals.mjs";
//   await context.addInitScript(VITALS_SCRIPT);            // before the first document
//   await page.evaluate(() => window.__perfLab.flush());    // at a step's end: double rAF, then takeRecords()
//   const lab = await page.evaluate(() => window.__perfLab);
//   inpOf(lab.events)  // {inpMs, interactions, ignored}
//
// Times are page time (performance.now(), ms since the document's timeOrigin). Tests:
// node --test tools/perf/test/vitals.test.mjs

/**
 * Collects paint, layout, interaction and frame vitals in the page (no library). Sets `window.__perfLab`:
 *   fcp, lcp, ttfb (ms), cls (max session window, the web.dev rule), longTasks (durations, ms) — the page-load lab's
 *   original fields, unchanged —
 *   lcpElement {tag, id, cls} of the latest LCP candidate,
 *   shifts   every layout-shift: {value, startTime, hadRecentInput, sources: [{node, previousRect, currentRect}]},
 *   loaf     long-animation-frame: {startTime, duration, blockingDuration, renderStart, styleAndLayoutStart, scripts: [...]},
 *   events   Event Timing (durationThreshold 16): {name, interactionId, startTime, duration, processingStart, processingEnd, target},
 *   inputs   trusted inputs the page itself received ({name, startTime}: pointerdown, keydown, and wheel at most every
 *            100 ms), the proof that an input landed when Event Timing has no entry for it (it took < 16 ms),
 *   flush()  a promise: waits a double requestAnimationFrame, then takeRecords() on every observer.
 * Each list keeps its newest 2000 entries.
 */
export const VITALS_SCRIPT = `(() => {
  if (window.__perfLab) return;
  const lab = window.__perfLab = { fcp: null, lcp: null, cls: 0, longTasks: [], ttfb: null, lcpElement: null, shifts: [], loaf: [], events: [], inputs: [] };
  // Room for every resource of a load (thumbnails included): the first-load bytes are read from Resource Timing.
  try { performance.setResourceTimingBufferSize(5000); } catch {}
  const CAP = 2000;
  const push = (list, x) => { list.push(x); if (list.length > CAP) list.splice(0, list.length - CAP); };
  const r = (v) => typeof v === "number" ? Math.round(v * 10) / 10 : v;
  const describe = (n) => {
    if (!n) return null;
    if (n.nodeType !== 1) return n.nodeName ? n.nodeName.toLowerCase() : null;
    const id = n.id ? "#" + n.id : "";
    const cls = typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
    return (n.tagName.toLowerCase() + id + cls).slice(0, 120);
  };
  // Full precision (O229): rounded rects could turn a sub-pixel motion into "no motion".
  const rect = (x) => x ? { x: x.x, y: x.y, width: x.width, height: x.height } : null;
  // A source's structural identity (O229), independent of where the page placed it: each ancestor up to six levels,
  // or to one with an authored id, as tag, first two classes, data-fact/data-tab and its place among same-tag
  // siblings; a text node adds its place among its parent's text nodes. Two spans moving alike are two elements.
  const generated = /^(?:_r_|:r)/i;
  const identity = (n) => {
    if (!n) return null;
    const parts = [];
    let e = n.nodeType === 1 ? n : n.parentElement;
    for (let depth = 0; e && e.nodeType === 1 && depth < 6; depth++, e = e.parentElement) {
      const tag = e.tagName.toLowerCase(), own = e.id && !generated.test(e.id) ? e.id : "";
      const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
      const data = ["data-fact", "data-tab"].map((a) => (e.getAttribute && e.getAttribute(a) !== null ? "[" + a + "=" + e.getAttribute(a) + "]" : "")).join("");
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [e];
      parts.unshift(tag + (own ? "#" + own : "") + cls + data + (same.length > 1 ? ":" + (same.indexOf(e) + 1) : ""));
      if (own) break;
    }
    if (n.nodeType === 3 && n.parentNode) { const texts = [...n.parentNode.childNodes].filter((c) => c.nodeType === 3); parts.push("#text" + (texts.length > 1 ? ":" + (texts.indexOf(n) + 1) : "")); }
    return parts.join(" > ");
  };
  const observers = [];
  const observe = (type, fn, extra) => { try { const o = new PerformanceObserver((l) => fn(l.getEntries())); o.observe({ type, buffered: true, ...(extra || {}) }); observers.push([o, fn]); } catch {} };
  observe("paint", (es) => { for (const e of es) if (e.name === "first-contentful-paint") lab.fcp = e.startTime; });
  observe("largest-contentful-paint", (es) => { const e = es[es.length - 1]; if (e) { lab.lcp = e.startTime; const el = e.element; lab.lcpElement = el ? { tag: el.tagName.toLowerCase(), id: el.id || undefined, cls: typeof el.className === "string" ? el.className.slice(0, 120) || undefined : undefined } : null; } });
  let windowValue = 0, windowStart = -Infinity, last = -Infinity;
  observe("layout-shift", (es) => { for (const e of es) {
    push(lab.shifts, { value: e.value, startTime: e.startTime, hadRecentInput: e.hadRecentInput, sources: (e.sources || []).map((s) => ({ node: describe(s.node), path: identity(s.node), previousRect: rect(s.previousRect), currentRect: rect(s.currentRect) })) });
    if (e.hadRecentInput) continue; if (e.startTime - last > 1000 || e.startTime - windowStart > 5000) { windowValue = 0; windowStart = e.startTime; } windowValue += e.value; last = e.startTime; lab.cls = Math.max(lab.cls, windowValue); } });
  observe("longtask", (es) => { for (const e of es) lab.longTasks.push(e.duration); });
  observe("long-animation-frame", (es) => { for (const e of es) push(lab.loaf, { startTime: r(e.startTime), duration: r(e.duration), blockingDuration: r(e.blockingDuration), renderStart: r(e.renderStart), styleAndLayoutStart: r(e.styleAndLayoutStart),
    scripts: (e.scripts || []).map((s) => ({ invoker: s.invoker, invokerType: s.invokerType, sourceURL: s.sourceURL ? String(s.sourceURL).replace(/([?&]token=)[^&#]+/, "$1…") : "", sourceFunctionName: s.sourceFunctionName, sourceCharPosition: s.sourceCharPosition, duration: r(s.duration) })) }); });
  observe("event", (es) => { for (const e of es) push(lab.events, { name: e.name, interactionId: e.interactionId || 0, startTime: r(e.startTime), duration: e.duration, processingStart: r(e.processingStart), processingEnd: r(e.processingEnd), target: describe(e.target) }); }, { durationThreshold: 16 });
  let wheelAt = -Infinity;
  for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, (e) => { if (!e.isTrusted) return; if (type === "wheel") { if (e.timeStamp - wheelAt < 100) return; wheelAt = e.timeStamp; } push(lab.inputs, { name: type, startTime: r(e.timeStamp) }); }, { capture: true, passive: true });
  // A hidden page runs no rAF: after 1 s the records are taken anyway, and flush() resolves false.
  lab.flush = () => new Promise((done) => {
    let settled = false;
    const take = (framed) => { if (settled) return; settled = true; for (const [o, fn] of observers) { try { const es = o.takeRecords(); if (es.length) fn(es); } catch {} } done(framed); };
    requestAnimationFrame(() => requestAnimationFrame(() => take(true)));
    setTimeout(() => take(false), 1000);
  });
  addEventListener("load", () => { const n = performance.getEntriesByType("navigation")[0]; if (n) lab.ttfb = n.responseStart; });
})();`;

/**
 * Interactions from Event Timing entries: entries grouped by non-zero `interactionId`; an interaction's latency is
 * its longest entry (rubric §6 INP).
 * @param {{name:string, interactionId?:number, startTime:number, duration:number, target?:string}[]} events
 * @returns {{id:number, latencyMs:number, startTime:number, names:string[], target:string|null}[]} by startTime
 */
export function interactionsOf(events = []) {
  const byId = new Map();
  for (const e of events) {
    if (!e.interactionId) continue;
    const x = byId.get(e.interactionId) ?? {
      id: e.interactionId,
      latencyMs: 0,
      startTime: e.startTime,
      names: [],
      target: null,
    };
    if (e.duration > x.latencyMs) {
      x.latencyMs = e.duration;
      x.target = e.target ?? x.target;
    }
    x.startTime = Math.min(x.startTime, e.startTime);
    if (!x.names.includes(e.name)) x.names.push(e.name);
    byId.set(e.interactionId, x);
  }
  return [...byId.values()].sort((a, b) => a.startTime - b.startTime);
}

/** Interactions that start with these inputs: a tap or a drag (pointerdown … pointerup), a key press (keydown … keyup). */
export const INTERACTION_STARTS = new Set(["pointerdown", "keydown"]);

/**
 * Interactions that landed but have no Event Timing entry (each took under 16 ms): the page received more
 * interaction starts (pointerdown, keydown) than there are timed interactions. Never negative: an interaction
 * timed before the input recorder was installed is still timed.
 * @param {{name:string}[]} inputs VITALS_SCRIPT `inputs` in the window
 * @param {object[]} events Event Timing entries in the same window
 * @returns {number}
 */
export function untimedInteractions(inputs = [], events = []) {
  const landed = inputs.filter((i) => INTERACTION_STARTS.has(i.name)).length;
  return Math.max(0, landed - interactionsOf(events).length);
}

/**
 * A journey's INP: its worst interaction, ignoring the highest one per 50 interactions (rubric §6).
 * `untimed` counts interactions that landed (the page received the input) but have no Event Timing entry: they took
 * under the 16 ms durationThreshold, and count towards the "per 50". With no timed interaction left after the
 * ignore rule, inpMs is null and `under16` is true when any interaction landed (else the caller reports NOT EVALUATED).
 * @param {object[]} events Event Timing entries, as interactionsOf takes them
 * @param {{untimed?:number}} [options]
 * @returns {{inpMs:number|null, interactions:number, ignored:number, worst:object|null, under16?:boolean}}
 */
export function inpOf(events = [], { untimed = 0 } = {}) {
  const timed = interactionsOf(events);
  const total = timed.length + untimed;
  if (total === 0) return { inpMs: null, interactions: 0, ignored: 0, worst: null };
  const sorted = [...timed].sort((a, b) => b.latencyMs - a.latencyMs);
  const ignored = Math.floor(total / 50);
  const worst = sorted[ignored] ?? null;
  return worst === null
    ? { inpMs: null, interactions: total, ignored, worst: null, under16: true }
    : { inpMs: worst.latencyMs, interactions: total, ignored, worst };
}

/**
 * CLS: layout shifts without recent input, in session windows (a gap over 1 s or a window over 5 s starts a new
 * one); the score is the largest window's sum.
 * @param {{value:number, startTime:number, hadRecentInput?:boolean}[]} shifts
 * @returns {{cls:number, windows:{startTime:number, endTime:number, value:number, count:number}[]}}
 */
export function clsOf(shifts = []) {
  const windows = [];
  let cur = null;
  for (const s of [...shifts].filter((x) => !x.hadRecentInput).sort((a, b) => a.startTime - b.startTime)) {
    if (cur === null || s.startTime - cur.endTime > 1000 || s.startTime - cur.startTime > 5000) {
      cur = { startTime: s.startTime, endTime: s.startTime, value: 0, count: 0 };
      windows.push(cur);
    }
    cur.value += s.value;
    cur.endTime = s.startTime;
    cur.count++;
  }
  const cls = windows.reduce((m, w) => Math.max(m, w.value), 0);
  return { cls: Math.round(cls * 1e6) / 1e6, windows };
}

/**
 * Shifts after route-ready (S6 "no shift after route-ready"): those starting after readyMs, without recent input.
 * @param {object[]} shifts layout-shift records (VITALS_SCRIPT `shifts`)
 * @param {number} readyMs route-ready in page time (the `archer:interactive` mark's startTime)
 * @returns {object[]} the late shifts, with their sources
 */
export function shiftsAfter(shifts = [], readyMs) {
  if (typeof readyMs !== "number") return [];
  return shifts.filter((s) => !s.hadRecentInput && s.startTime > readyMs);
}

/**
 * What moved in a shift, for telling a release's shift from a new one (S6 "new since last release"): the sorted
 * source nodes, e.g. "button.archer-chat-fab", with React's generated ids (`#_r_6_-diagrams`) dropped, since they
 * differ between builds. Geometry and time are left out: the same element moving at a different moment or by a
 * different amount is the same shift for identity. A label for reports: S6 compares `shiftElements` (O215).
 */
const stripGeneratedIds = (n) => n.replace(/#(?:_r_[0-9a-z]+_|:r[0-9a-z]+:)[\w-]*/gi, "");
export const shiftSignature = (s) =>
  [
    ...new Set(
      (s.sources ?? [])
        .map((x) => x.node)
        .filter(Boolean)
        .map(stripGeneratedIds),
    ),
  ]
    .sort()
    .join(" | ") || "(no source)";

/**
 * Each element's own movement in a list of shifts (S6 identity, O215): one record per shift source, `{node, from, to,
 * startTime}` with the node described as in shiftSignature (generated ids dropped), its previous and current rects
 * and the shift's unrounded start. The browser batches the sources that moved in one frame into one entry, and which
 * ones share an entry varies between loads and builds (a tab alone, or with its text and counter): comparing whole
 * entries read the same motion, grouped differently, as a new shift (codex-207, claude-205).
 */
export function shiftElements(shifts = []) {
  // A shift with no source keeps a record "(no source)", so it is never silently dropped; `path` is the source's
  // structural identity when the lab recorded one (O229).
  return shifts.flatMap((s) =>
    (s.sources?.length ? s.sources : [{ node: null, previousRect: null, currentRect: null }]).map((x) => ({
      node: x.node ? stripGeneratedIds(x.node) : "(no source)",
      ...(x.path ? { path: x.path } : {}),
      from: x.previousRect ?? null,
      to: x.currentRect ?? null,
      startTime: s.startTime,
    })),
  );
}

/**
 * An element movement's identity: the element and how it moved, exactly: its displacement and size change (dx, dy,
 * dw, dh, from the previous and current rects); not when it moved, with what, or where the page placed it. The live
 * run (O215) found the candidate's project tabs 4 px lower than v0.10.0's (the page above them changed) making the
 * same motion: by absolute rects that read as new. The element is its structural `path` when recorded (O229: a bare
 * `span` matched any other span moving alike), else its description. A different motion of the same element (tabs that start 2 px
 * narrower and widen 8, not 6) is still a different movement. A source without both rects keys by its rects' absence;
 * one whose rects are equal keys as moved with its box size (the spec's starting point moved; the rects do not show how).
 */
const delta = (v) => Number(v.toFixed(3));
export const movementKey = (e) => {
  const { from: a, to: b } = e,
    who = e.path ?? e.node;
  if (!a || !b) return `${who} ${a ? "" : "-"}→${b ? "" : "-"}`;
  const dx = delta(b.x - a.x),
    dy = delta(b.y - a.y),
    dw = delta(b.width - a.width),
    dh = delta(b.height - a.height);
  // A source is listed only when its starting point moved 3 px or more (Layout Instability §2.1–2.2), so equal rects
  // never mean "no motion": Chrome gives a text node whose text changed its new box as both rects (O223: a tab count
  // "…" → "30" moved its text 3 px; the entry's score is exactly a 3 px move over the two 16 × 15 boxes). The rects do
  // not say how it moved, so the key does not claim a motion; it is still a movement, and still counts.
  if (dx === 0 && dy === 0 && dw === 0 && dh === 0)
    return `${who} moved, rects unchanged (${delta(b.width)}×${delta(b.height)})`;
  return `${who} Δx${dx} Δy${dy} Δw${dw} Δh${dh}`;
};

/** A long frame with no script that names where it came from (rendering-only work, or work in a worker). */
export const unattributed = (f) => !(f.scripts ?? []).some((s) => s.sourceURL || s.sourceFunctionName || s.invoker);

/**
 * LoAF frames in a window: count, total blocking ms, and each frame that lacks script attribution (with
 * styleAndLayoutStart and renderStart, so a reviewer can name the cause, rubric §6 LoAF).
 * @param {object[]} loaf VITALS_SCRIPT `loaf` records
 * @param {{fromMs?:number, toMs?:number, minMs?:number}} window page-time bounds (by startTime); minMs: only frames longer (default 50)
 * @returns {{count:number, blockingMs:number, longestMs:number, frames:object[], unattributed:object[]}}
 */
export function loafSummary(loaf = [], { fromMs = -Infinity, toMs = Infinity, minMs = 50 } = {}) {
  const frames = loaf.filter((f) => f.startTime >= fromMs && f.startTime <= toMs && f.duration > minMs);
  const round = (v) => Math.round(v * 10) / 10;
  return {
    count: frames.length,
    blockingMs: round(frames.reduce((s, f) => s + (f.blockingDuration ?? 0), 0)),
    longestMs: round(frames.reduce((m, f) => Math.max(m, f.duration), 0)),
    frames: frames.map((f) => ({ ...f, attributed: !unattributed(f) })),
    unattributed: frames.filter(unattributed).map((f) => ({
      startTime: f.startTime,
      duration: f.duration,
      blockingDuration: f.blockingDuration,
      renderStart: f.renderStart,
      styleAndLayoutStart: f.styleAndLayoutStart,
      scripts: f.scripts ?? [],
    })),
  };
}

/**
 * Intervals between consecutive requestAnimationFrame timestamps (ms), in order.
 * @param {number[]} timestamps
 * @returns {number[]}
 */
export function frameIntervals(timestamps = []) {
  const t = [...timestamps].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < t.length; i++) out.push(t[i] - t[i - 1]);
  return out;
}

/**
 * The 95th percentile, nearest-rank (the smallest value with at least 95% of values at or below it); null when empty.
 * @param {number[]} values
 * @returns {number|null}
 */
export function p95(values = []) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
}
