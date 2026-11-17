// node --test tools/perf/test/reconnect.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMA, classifyPath, s8Level, streamsPerTab, summarize } from "../lib/reconnect.mjs";

// A tiny capture builder: one tab "d" unless named; rows get ids r1, r2, …
function capture({
  fault = { start: 1000, end: 4000, kinds: ["restart"] },
  end = 20_000,
  retryMs = null,
  tabs = ["d"],
  rows = [],
  events = [],
  phase = "restart",
} = {}) {
  let n = 0;
  return {
    schema: SCHEMA,
    phase,
    t0: 0,
    end,
    fault,
    retryMs,
    tabs: tabs.map((id) => ({ id, path: "/x" })),
    rows: rows.map((r) => ({
      tab: "d",
      id: `r${++n}`,
      method: "GET",
      kind: classifyPath(r.path ?? "", r.method),
      ...r,
    })),
    events,
  };
}
const neg = (start, over = {}) => ({
  path: "/p/a/api/connection",
  start,
  end: start + 5,
  response: start + 4,
  status: 200,
  ...over,
});
const negFail = (start) => ({
  path: "/p/a/api/connection",
  start,
  end: start + 2,
  failed: true,
  errorText: "net::ERR_CONNECTION_REFUSED",
});
const stream = (start, over = {}) => ({ path: "/p/a/api/events", start, response: start + 3, status: 200, ...over });
const read = (start, path = "/p/a/api/diagrams", over = {}) => ({
  path,
  start,
  end: start + 10,
  response: start + 9,
  status: 200,
  ...over,
});
const ev = (row, at, name = "standing", data = '{"seq":7}', tab = "d") => ({ tab, row, at, name, data });

/** A healthy restart: the stream breaks at 1000, tries back off 300, 700, 1500 ms, the fourth connects. */
function healthy(over = {}) {
  return capture({
    rows: [
      neg(0),
      stream(10, { end: 1000 }),
      neg(20), // r1–r3: the working stream and its onopen negotiate
      negFail(1300),
      negFail(2002 + 0),
      negFail(3504), // r4–r6: refused (gaps 300, 700, 1500)
      neg(6506),
      stream(6512),
      neg(6516), // r7–r9: connects (gap 3000)
      read(6530),
      read(6531, "/p/a/api/diagrams/x"), // r10, r11: the page reads its state again
    ],
    events: [ev("r2", 14), ev("r8", 6516, "standing", '{"seq":2}')],
    ...over,
  });
}

test("classifyPath: stream, negotiate, api, other", () => {
  assert.equal(classifyPath("/p/a/api/events"), "stream");
  assert.equal(classifyPath("/p/a/api/connection"), "negotiate");
  assert.equal(classifyPath("/api/connection"), "negotiate");
  assert.equal(classifyPath("/p/a/api/diagrams"), "api");
  assert.equal(classifyPath("/projects/a/"), "other");
  assert.equal(classifyPath("/p/a/api/events", "POST"), "api");
});

test("pass: one stream per tab, attempts back off, bounded, reconnects; reads and time to first event measured", () => {
  const s = summarize(healthy());
  const t = s.tabs[0];
  assert.equal(t.ok, true, t.failures.join("; "));
  assert.equal(t.maxStreams, 1);
  assert.equal(t.attempts, 4);
  assert.deepEqual(
    t.timeline.attempts.map((a) => a.gapMs),
    [300, 700, 1500, 3000],
  );
  assert.equal(t.timeline.brokeAt, 1000);
  assert.equal(t.bounded, true);
  assert.equal(t.reads.count, 2);
  // The standing seq (2) differs from the one known before the fault (7): a restart's new count.
  assert.equal(t.reads.invalidated, 2);
  assert.equal(t.reads.negotiations, 1);
  assert.equal(t.timeToFirstEvent.fromFaultEndMs, 2516);
  assert.equal(t.timeToFirstEvent.fromOpenMs, 1);
  assert.equal(s8Level([s]).level, 3);
  assert.equal(s8Level([s]).provisional, true, "no baseline: the regression part is not evaluated");
});

test("reads after a standing with the same seq are not invalidated; level 2", () => {
  const c = healthy();
  c.events[1].data = '{"seq":7}';
  const s = summarize(c);
  assert.equal(s.tabs[0].reads.invalidated, 0);
  const l = s8Level([s]);
  assert.equal(l.level, 2);
  // A change event before a read invalidates it.
  c.events.push(ev("r8", 6530, "diagrams", "{}"));
  assert.equal(summarize(c).tabs[0].reads.invalidated, 2);
});

test("fail (level 0): two concurrent streams in one tab", () => {
  const c = healthy();
  // A second EventSource on the same URL, opened while the reconnected one is live.
  c.rows.push({
    tab: "d",
    id: "x1",
    method: "GET",
    kind: "stream",
    path: "/p/a/api/events",
    start: 8000,
    response: 8003,
    status: 200,
    end: 9000,
  });
  const per = streamsPerTab(c);
  assert.equal(per.d.max, 2);
  assert.deepEqual(per.d.overlaps, [["r8", "x1"]]);
  const s = summarize(c);
  assert.equal(s.tabs[0].oneStream, false);
  assert.equal(s8Level([s]).level, 0);
  // A stream that ended at the instant the next starts is not concurrent.
  const seq = capture({ rows: [stream(0, { end: 500 }), stream(500)], events: [ev("r1", 4), ev("r2", 504)] });
  assert.equal(streamsPerTab(seq).d.max, 1);
});

test("streams on two tabs are one per tab", () => {
  const c = capture({
    tabs: ["d", "p"],
    rows: [stream(0), { ...stream(5), tab: "p" }],
    events: [ev("r1", 4), ev("r2", 9, "standing", '{"seq":7}', "p")],
  });
  assert.deepEqual(
    Object.values(streamsPerTab(c)).map((t) => t.max),
    [1, 1],
  );
});

test("fail: an attempt 50 ms after a failure under a 1000 ms retry", () => {
  const c = capture({
    retryMs: 1000,
    rows: [neg(0), stream(10, { end: 1000 }), negFail(1050), negFail(2100), neg(4200), stream(4206)],
    events: [ev("r2", 14), ev("r6", 4210)],
  });
  const t = summarize(c).tabs[0];
  assert.equal(t.floorOk, false);
  assert.deepEqual(
    t.timeline.attempts.map((a) => [a.gapMs, a.floorOk]),
    [
      [50, false],
      [1048, true],
      [2098, true],
    ],
  );
  assert.match(t.failures.join(), /50 ms after a failure, under retry 1000 ms/);
  assert.equal(s8Level([summarize(c)]).level, 1);
  // A stream's own retry is the floor for the next try: here 1000 ms from the "opening" stream.
  const own = capture({
    rows: [
      neg(0),
      stream(10, { end: 1000 }),
      neg(1300),
      stream(1306, { end: 1310, retryMs: 1000 }),
      neg(1700),
      stream(1706),
    ],
    events: [ev("r2", 14), ev("r6", 1710)],
  });
  const a = summarize(own).tabs[0].timeline.attempts;
  assert.deepEqual(
    a.map((x) => [x.floorMs, x.floorOk]),
    [
      [null, true],
      [1000, false],
    ],
  );
});

test("fail (level 0): unbounded attempts — a try every 10 ms that never reconnects", () => {
  const rows = [neg(0), stream(10, { end: 1000 })];
  for (let at = 1010; at < 20_000; at += 10) rows.push(negFail(at));
  const s = summarize(capture({ rows, events: [ev("r2", 14)] }));
  const t = s.tabs[0];
  assert.equal(t.bounded, false);
  assert.equal(t.recovered, false);
  assert.equal(t.backoffOk, false);
  assert.equal(s8Level([s]).level, 0);
});

test("fail: no backoff — a steady 300 ms loop is under its floor-free bound but never grows", () => {
  const rows = [neg(0), stream(10, { end: 1000 })];
  for (let i = 1; i <= 4; i++) rows.push(negFail(1000 + i * 302));
  rows.push(neg(1000 + 5 * 302 + 2), stream(1000 + 5 * 302 + 8));
  const t = summarize(
    capture({
      rows,
      events: [ev("r2", 14), ev(`r${rows.length}`, 2600)],
      fault: { start: 1000, end: 2400, kinds: ["restart"] },
    }),
  ).tabs[0];
  assert.equal(t.backoffOk, false);
  assert.equal(t.bounded, true);
});

test("the browser-level re-ask of an unanswered negotiate (250 ms later) is the same try, counted apart", () => {
  // As measured on v0.9.0: each backed-off try is a dropped connection read and its one re-ask.
  const c = capture({
    rows: [
      neg(0),
      stream(10, { end: 1000 }),
      negFail(1267),
      negFail(1519),
      negFail(2329),
      negFail(2581),
      neg(4531),
      stream(4537),
    ],
    events: [ev("r2", 14), ev("r8", 4540)],
  });
  const t = summarize(c).tabs[0];
  assert.equal(t.attempts, 3);
  assert.equal(t.reasks, 2);
  assert.equal(t.attemptRequests, 6);
  assert.deepEqual(
    t.timeline.attempts.map((a) => a.gapMs),
    [267, 808, 1948],
  );
  assert.equal(t.ok, true, t.failures.join("; "));
  // Only one re-ask per try: a third quick row is a new try (and shrinks the gap).
  c.rows.splice(4, 0, {
    tab: "d",
    id: "q",
    method: "GET",
    kind: "negotiate",
    path: "/p/a/api/connection",
    start: 1780,
    end: 1782,
    failed: true,
  });
  assert.equal(summarize(c).tabs[0].attempts, 4);
});

test("a long outage that never slows down is unbounded even when it reconnects", () => {
  const rows = [neg(0), stream(10, { end: 1000 })];
  let at = 1000;
  for (let i = 0; i < 12; i++) rows.push(negFail((at += 300)));
  rows.push(neg((at += 300)), stream(at + 6));
  const t = summarize(
    capture({
      rows,
      events: [ev("r2", 14), ev(`r${rows.length}`, at + 10)],
      fault: { start: 1000, end: at, kinds: ["restart"] },
    }),
  ).tabs[0];
  assert.equal(t.recovered, true);
  assert.equal(t.bounded, false);
  assert.equal(t.timeline.runs[0].grows, false);
});

test("a stream answered 200 that closes at once keeps its onopen negotiate (aborted just after) in its try", () => {
  // As measured with PERF_SEED_FAULT=slow-retry: 200 `retry: 5000`, closed; the onopen read starts 0.7 ms after.
  const c = capture({
    rows: [
      neg(0),
      stream(10, { end: 1000 }),
      neg(1300),
      stream(1306, { end: 1310, response: 1309, retryMs: 5000 }),
      { path: "/p/a/api/connection", start: 1310.7, end: 1311, failed: true, errorText: "net::ERR_ABORTED" },
      neg(3300),
      stream(3306),
    ],
    events: [ev("r2", 14), ev("r7", 3310)],
  });
  const a = summarize(c).tabs[0].timeline.attempts;
  assert.equal(a.length, 2);
  assert.deepEqual(
    a.map((x) => [x.gapMs, x.floorMs, x.floorOk]),
    [
      [300, null, true],
      [1989, 5000, false],
    ],
  );
});

test("backoff allows jitter (a gap down to half the one before) but not a collapse", () => {
  const run = (gaps) => {
    const rows = [neg(0), stream(10, { end: 1000 })];
    let failed = 1000; // each try fails 2 ms after it starts; a gap runs from that failure to the next try
    for (const g of gaps.slice(0, -1)) {
      rows.push(negFail(failed + g));
      failed += g + 2;
    }
    const at = failed + gaps.at(-1);
    rows.push(neg(at), stream(at + 6));
    const t = summarize(
      capture({
        rows,
        events: [ev("r2", 14), ev(`r${rows.length}`, at + 10)],
        fault: { start: 1000, end: at, kinds: ["restart"] },
      }),
    ).tabs[0];
    assert.deepEqual(
      t.timeline.attempts.map((x) => x.gapMs),
      gaps,
    );
    return t;
  };
  // A Retry-After wait (1–1.25 s) then a backoff draw (1–2 s): shrinks a little, still backoff.
  assert.equal(run([400, 800, 1240, 1010]).backoffOk, true);
  assert.equal(run([400, 1000, 320, 2000]).backoffOk, false);
});

test("tries after reconnecting make the attempts unbounded", () => {
  const c = healthy();
  c.rows.push({
    tab: "d",
    id: "late",
    method: "GET",
    kind: "negotiate",
    path: "/p/a/api/connection",
    start: 12_000,
    end: 12_005,
    status: 200,
  });
  c.rows.find((r) => r.id === "r8").end = 11_000;
  const t = summarize(c).tabs[0];
  assert.equal(t.bounded, false);
});

test("an offline fault's `online` wake is exempt from floor and backoff", () => {
  const c = capture({
    phase: "offline",
    fault: { start: 1000, end: 5000, kinds: ["offline"] },
    retryMs: 1000,
    rows: [neg(0), stream(10, { end: 1000 }), negFail(2100), negFail(4200), neg(5050), stream(5056)],
    events: [ev("r2", 14), ev("r6", 5060, "standing", '{"seq":7}')],
  });
  const t = summarize(c).tabs[0];
  assert.deepEqual(
    t.timeline.attempts.map((a) => a.wake),
    [false, false, true],
  );
  assert.equal(t.ok, true, t.failures.join("; "));
  assert.equal(t.timeToFirstEvent.fromFaultEndMs, 60);
});

test("a stream that survives the fault: no attempts, nothing to read again, level 3 (vacuous)", () => {
  const c = capture({
    phase: "offline",
    fault: { start: 1000, end: 4000, kinds: ["offline"] },
    rows: [neg(0), stream(10)],
    events: [ev("r2", 14)],
  });
  const t = summarize(c).tabs[0];
  assert.equal(t.attempts, 0);
  assert.equal(t.recovered, true);
  assert.equal(t.reads.count, 0);
  assert.equal(t.timeToFirstEvent.fromFaultEndMs, null);
});

test("a planned hand-over run (event: reconnect) is exempt from backoff, not from the floor", () => {
  const rows = [neg(0), stream(10, { end: 1000, retryMs: 250 })];
  for (let i = 1; i <= 4; i++) rows.push(negFail(1000 + i * 260));
  rows.push(neg(2310), stream(2316));
  const c = capture({
    rows,
    events: [ev("r2", 14), ev("r2", 999, "reconnect", '{"reason":"handover"}'), ev(`r${rows.length}`, 2320)],
    fault: { start: 1000, end: 2300, kinds: ["restart"] },
  });
  const t = summarize(c).tabs[0];
  assert.equal(t.timeline.runs[0].handover, true);
  assert.equal(t.backoffOk, true);
  assert.equal(t.floorOk, true);
});

const pinned = (c, jitter = "fixed 0.75") => ({ ...c, jitter });
test("level 1: attempts or reads regressed against the last release; level 2 when no worse", () => {
  const base = summarize(pinned(healthy()));
  const more = pinned(healthy());
  more.rows.push({
    tab: "d",
    id: "extra",
    method: "GET",
    kind: "api",
    path: "/p/a/api/notes",
    start: 6600,
    end: 6610,
    status: 200,
  });
  const l = s8Level([summarize(more)], [base]);
  assert.equal(l.level, 1);
  assert.match(l.reasons.join(), /reads after reconnect 2 → 3/);
  const same = s8Level([summarize(pinned(healthy()))], [base], { ttfeFloorMs: 100 });
  assert.equal(same.level, 3);
  assert.equal(same.provisional, false);
  // Time to first event later than the floor allows: level 1.
  const slow = pinned(healthy());
  for (const e of slow.events) if (e.row === "r8") e.at += 400;
  assert.equal(s8Level([summarize(slow)], [base], { ttfeFloorMs: 100 }).level, 1);
  // Within the floor: no regression (level 2: the later standing no longer precedes the reads).
  assert.equal(s8Level([summarize(slow)], [base], { ttfeFloorMs: 500 }).level, 2);
  // The paired estimator's verdicts win over the direct comparison.
  assert.equal(
    s8Level([summarize(more)], [base], {
      comparison: { attemptsRegressed: false, readsRegressed: false, ttfeRegressed: false },
    }).level,
    3,
  );
});

test("summarize refuses a capture of another shape", () => {
  assert.throws(() => summarize({ schema: "nope" }), /not a reconnect capture/);
});

// O217 (claude-207): the comparison had no floor. Attempts in a 6 s fault are 3–5 a tab on either build under the
// page's random equal jitter, and time to first event was compared at a 0 ms floor, so v0.10.0 against itself
// scored level 1.
test("S8 A/A: identical transport compares equal; native-jitter attempts and floorless time to first event are not regressions", () => {
  // One more refused try before connecting (a different jitter draw): attempts 4 → 5.
  const oneMore = () => {
    const c = healthy();
    c.rows.splice(6, 0, {
      tab: "d",
      id: "extra",
      method: "GET",
      kind: "negotiate",
      path: "/p/a/api/connection",
      start: 5000,
      end: 5002,
      failed: true,
      errorText: "net::ERR_CONNECTION_REFUSED",
    });
    return c;
  };
  assert.equal(summarize(oneMore()).tabs[0].attempts, summarize(healthy()).tabs[0].attempts + 1);
  // Native jitter on both sides (captures before O217 included): attempts are not compared, so not level 1.
  const native = s8Level([summarize(oneMore())], [summarize(healthy())]);
  assert.notEqual(native.level, 1, JSON.stringify(native));
  assert.equal(native.provisional, true);
  assert.match(native.notEvaluated.join(), /attempts 4 → 5 not compared: jitter native → native/);
  // The same build against itself with its later first event: no floor, so NOT EVALUATED, not level 1.
  const later = healthy();
  for (const e of later.events) if (e.row === "r8") e.at += 400;
  const aa = s8Level([summarize(pinned(later))], [summarize(pinned(healthy()))]);
  assert.notEqual(aa.level, 1);
  assert.match(aa.notEvaluated.join(), /time to first event .* not compared: no A\/A floor/);
  // Identical fixed-jitter captures: equal, and with a floor nothing is left unevaluated.
  const equal = s8Level([summarize(pinned(healthy()))], [summarize(pinned(healthy()))], { ttfeFloorMs: 0 });
  assert.deepEqual([equal.level, equal.provisional], [3, false]);
  // Negative control: under the same pinned jitter, one more try is a regression.
  const more = s8Level([summarize(pinned(oneMore()))], [summarize(pinned(healthy()))], { ttfeFloorMs: 1000 });
  assert.equal(more.level, 1);
  assert.match(more.reasons.join(), /attempts 4 → 5 \(fixed 0.75\)/);
  // Different pins are not compared either.
  assert.match(
    s8Level([summarize(pinned(oneMore(), "fixed 0.25"))], [summarize(pinned(healthy()))]).notEvaluated.join(),
    /jitter fixed 0.75 → fixed 0.25/,
  );
});
