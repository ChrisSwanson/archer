// Reconnect cost (performance rubric §3 S8, §5 reconnect row): pure analysis of one reconnect capture.
// No I/O. The capture is what tools/devkit/journeys/perf/reconnect.mjs writes (one per fault phase); the
// user-flows journeys (J8a–c) can record the same shape and import these functions for the timing side,
// leaving correctness (drafts kept, exactly-once) to their own checks.
//
// ## Capture shape (`schema: "archer.perf.reconnect-capture/1"`)
//
// Every time is in milliseconds since the capture's own zero (`t0`, a wall-clock epoch ms), one clock for
// every tab.
//
//   {
//     schema: "archer.perf.reconnect-capture/1",
//     phase: "offline" | "restart" | "both" | string,
//     t0: number,                         // Date.now() at the capture's zero
//     end: number,                        // when the capture stopped
//     fault: { start: number, end: number, kinds: ["offline"|"restart"|"route", …] },
//                                         // the fault window: the network or service is unavailable inside it
//     retryMs: number | null,             // the `retry:` the service sent on the stream before the fault
//                                         // (null: none sent; the browser's default then applies)
//     tabs: [{ id: string, path: string }],
//     rows: [{                            // one row per request of every tab (CDP Network events)
//       tab: string, id: string,          // the tab's id; the CDP requestId
//       kind: "stream" | "negotiate" | "api" | "other",   // classifyPath(path, method)
//       method: string, path: string,     // path only: no origin, no query (tokens)
//       start: number,                    // requestWillBeSent
//       response?: number, status?: number,               // responseReceived
//       end?: number,                     // loadingFinished / loadingFailed (absent: still open at `end`)
//       failed?: boolean, errorText?: string, canceled?: boolean,
//       retryMs?: number | null,          // a stream's own `retry:` when its body was readable
//       seq?: number                      // the x-archer-event-seq response header (publication count)
//     }],
//     events: [{ tab: string, row: string, at: number, name: string, data?: string }]
//                                         // Network.eventSourceMessageReceived (data trimmed)
//   }
//
// ## Readings of the rubric text (S8), recorded where it is not explicit
//
// - *Stream*: a GET of `…/api/events`. It is open from its request until it ends (or the capture ends),
//   so a connection attempt that has not been answered yet also counts as a stream of its tab.
// - *Attempt*: one try to get a working stream back after it broke. The page first reads `api/connection`
//   and only then opens `api/events`, so a try is a negotiate row with the stream row it led to, or a
//   stream row on its own. A try *connects* when its stream answered 200 and delivered an event (or is
//   still open at the end); otherwise it fails at its last row's end.
// - *No sooner than `retry`*: the gap from one failure to the next try is ≥ the last `retry:` the service
//   sent on that tab (a stream's own value, else the capture's). With no `retry:` ever sent there is no
//   service floor: the check passes, and `floorMs: null` says so (WHATWG leaves the default to the browser).
// - *Backoff*: within one outage no gap falls under `shrinkRatio` (½) of the one before (jitter) unless it
//   reached `plateauMs`, and an outage of ≥ 3 tries ends with a gap at least twice its first (or at the plateau).
//   A run after the service's `event: reconnect` (a planned hand-over, ADR 0032) is exempt from backoff, not
//   from the floor. A try that starts within `wakeMs` of the fault's end in an `offline` fault is the page
//   answering the browser's `online` event: it is reported as `wake` and exempt from floor and backoff.
// - *Bounded*: after the fault ends the tab connects and makes no further try before the capture ends, and an
//   outage of ≥ `growthAfterGaps` gaps slows down: its last third's median gap is ≥ 2× its first third's (or at the plateau).
// - *Re-ask*: the page asks an unanswered negotiate once more after 250 ms; that second row is the same try.
// - *Reads after reconnect*: `api` rows (not `negotiate`, not streams) of the tab that start after its
//   connected stream answered. A read is *invalidated* when an event that says something changed came on
//   that tab between the connection and the read: any named event except `heartbeat`, `reconnect` and
//   `standing`, or a `standing` whose `seq` differs from the last count the tab knew before the fault.
// - *Time to first event*: from the fault's end to the first event on the tab's connected stream
//   (`fromFaultEndMs`, the headline; `fromOpenMs` is from that stream's answer).

export const SCHEMA = "archer.perf.reconnect-capture/1";

/** Event names that are bookkeeping, not news. `standing` is judged by its `seq` instead. */
const QUIET_EVENTS = new Set(["heartbeat", "reconnect", "standing", "message", ""]);

export const DEFAULTS = Object.freeze({
  /** Timer slack allowed under the floor and between gaps (ms). */
  toleranceMs: 5,
  /** A gap may shrink to this share of the one before (jitter: equal jitter, or a Retry-After wait of 1–1.25 s
   * followed by a backoff draw of 1–2 s) without counting as "no backoff". */
  shrinkRatio: 0.5,
  /** A gap at or above this is "at the cap": the page's 30 s ceiling with equal jitter is ≥ 15 s. */
  plateauMs: 15_000,
  /** How soon after an `offline` fault ends a try counts as the `online` wake (ms). */
  wakeMs: 250,
  /** A read the browser dropped unanswered is asked once more after 250 ms (`DROPPED_READ_RETRY_MS`,
   * ui/src/app/browser-resource.ts): a second negotiate this soon after an unanswered one is the same try. */
  reaskMs: 300,
  /** The page negotiates as its stream opens; a negotiate this soon after the stream's answer is that try's. */
  onopenMs: 50,
  /** An outage with at least this many gaps must show growth, or its attempts are unbounded. */
  growthAfterGaps: 6,
});

/**
 * The kind of a request from its path and method.
 * @param {string} path a path without origin or query
 * @param {string} [method]
 * @returns {"stream"|"negotiate"|"api"|"other"}
 */
export function classifyPath(path, method = "GET") {
  if (method === "GET" && /\/api\/events$/.test(path)) return "stream";
  if (method === "GET" && /(^|\/)api\/connection$/.test(path)) return "negotiate";
  if (/(^|\/)api\//.test(path)) return "api";
  return "other";
}

/**
 * @param {object} capture
 * @param {string} tab
 * @returns {object[]} the tab's rows by start time
 */
function rowsOf(capture, tab) {
  return capture.rows.filter((r) => r.tab === tab).sort((a, b) => a.start - b.start);
}

/** When a row ended: a stream with no end is still open; any other row with an answer ended by it (CDP does not
 * always report loadingFinished for an empty answer). */
const endOf = (row, capture) => row.end ?? (row.kind === "stream" ? undefined : row.response) ?? capture.end;

/**
 * Streams open at once on each tab: the most at any instant, when, and every overlapping pair.
 * @param {object} capture
 * @returns {Record<string, {max: number, at: number|null, overlaps: [string, string][]}>}
 */
export function streamsPerTab(capture) {
  const out = {};
  for (const { id: tab } of capture.tabs) {
    const streams = rowsOf(capture, tab).filter((r) => r.kind === "stream");
    let max = streams.length > 0 ? 1 : 0,
      at = streams[0]?.start ?? null;
    const overlaps = [];
    for (const s of streams) {
      // Open at s.start: every earlier stream that has not ended yet (an end at the same instant is closed).
      const open = streams.filter((o) => o.start <= s.start && endOf(o, capture) > s.start);
      if (open.length > max) {
        max = open.length;
        at = s.start;
      }
      for (const o of open) if (o !== s) overlaps.push([o.id, s.id]);
    }
    out[tab] = { max, at, overlaps };
  }
  return out;
}

/**
 * The tab's tries in order: groups of a negotiate row and the stream it led to.
 * @param {object} capture
 * @param {string} tab
 * @returns {{start: number, rows: object[], stream: object|null, connected: boolean, connectedAt: number|null, failedAt: number|null, retryMs: number|null|undefined, handover: boolean}[]}
 */
export function triesOf(capture, tab, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const eventsByRow = new Map();
  for (const e of capture.events)
    if (e.tab === tab) (eventsByRow.get(e.row) ?? eventsByRow.set(e.row, []).get(e.row)).push(e);
  const tries = [];
  let current = null;
  for (const row of rowsOf(capture, tab)) {
    if (row.kind === "negotiate") {
      // The page negotiates again once a stream opens (onopen): that read belongs to the stream's try.
      const s = current?.stream;
      // A stream answered 200 and closed at once still gets that read, a moment later (and aborted).
      if (
        s &&
        s.response !== undefined &&
        row.start >= s.response &&
        (s.end === undefined || row.start < s.end || row.start - s.response <= o.onopenMs)
      ) {
        current.rows.push(row);
        continue;
      }
      // The one re-ask of a negotiate the browser dropped unanswered (no status): the same try, counted apart.
      const last = current?.rows.at(-1);
      if (
        current &&
        !s &&
        !current.reasks &&
        last?.kind === "negotiate" &&
        last.failed &&
        last.status === undefined &&
        row.start - endOf(last, capture) <= o.reaskMs
      ) {
        current.rows.push(row);
        current.reasks = 1;
        continue;
      }
      current = { start: row.start, rows: [row], stream: null, reasks: 0 };
      tries.push(current);
    } else if (row.kind === "stream") {
      const negotiated =
        current &&
        current.stream === null &&
        current.rows.every((r) => r.status === 200 && r.end !== undefined && !r.failed);
      if (negotiated) {
        current.stream = row;
        current.rows.push(row);
      } else {
        current = { start: row.start, rows: [row], stream: row, reasks: 0 };
        tries.push(current);
      }
    }
  }
  for (const t of tries) {
    const s = t.stream,
      events = s ? (eventsByRow.get(s.id) ?? []) : [];
    t.events = events;
    t.connected = Boolean(s && s.status === 200 && (events.length > 0 || s.end === undefined));
    t.connectedAt = t.connected ? (s.response ?? s.start) : null;
    // A try fails when its last row ends; a connected try fails when its stream ends.
    t.failedAt = t.connected ? (s.end ?? null) : Math.max(...t.rows.map((r) => endOf(r, capture)));
    t.retryMs = s?.retryMs;
    t.handover = events.some((e) => e.name === "reconnect");
  }
  return tries;
}

/**
 * The attempt timeline of one tab around the capture's fault, with the floor, backoff and bound checks.
 * @param {object} capture
 * @param {string} tab
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function attemptTimeline(capture, tab, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const tries = triesOf(capture, tab, o);
  const { start: faultStart, end: faultEnd, kinds = [] } = capture.fault;
  // The stream that was working when the fault began, and the tries after it.
  const before = tries.filter((t) => t.start < faultStart);
  const live = [...before].reverse().find((t) => t.connected) ?? null;
  const after = tries.filter((t) => t.start >= faultStart);
  let retry = capture.retryMs ?? null;
  for (const t of before) if (typeof t.retryMs === "number") retry = t.retryMs;
  let previous = live,
    handover = live?.handover ?? false;
  const attempts = [];
  for (const t of after) {
    if (typeof previous?.retryMs === "number") retry = previous.retryMs;
    const since = previous?.failedAt ?? null;
    const gap = since === null ? null : t.start - since;
    // The browser's `online` event can reach the page a moment before the script records the fault's end.
    const wake = kinds.includes("offline") && Math.abs(t.start - faultEnd) <= o.wakeMs;
    const floorOk = wake || retry === null || gap === null || gap >= retry - o.toleranceMs;
    attempts.push({
      at: t.start,
      gapMs: gap === null ? null : round(gap),
      floorMs: retry,
      floorOk,
      wake,
      handover,
      connected: t.connected,
      connectedAt: t.connectedAt,
      failedAt: t.failedAt,
      status: t.stream?.status ?? t.rows[0]?.status ?? null,
      requests: t.rows.filter((r) => r.kind !== "negotiate" || r.start < (t.connectedAt ?? Infinity)).length,
      reasks: t.reasks,
      error: t.rows.find((r) => r.errorText)?.errorText ?? null,
      rows: t.rows.map((r) => r.id),
      stream: t.stream?.id ?? null,
    });
    if (t.connected) handover = t.handover; // a new outage after this one starts from this stream's own say
    previous = t;
  }
  // Outages: runs of tries that end with a connected one (or the capture's end).
  const runs = [];
  let run = [];
  for (const a of attempts) {
    run.push(a);
    if (a.connected) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  const checkedRuns = runs.map((r) => {
    const gaps = r.filter((a) => !a.wake && a.gapMs !== null).map((a) => a.gapMs);
    const exempt = r[0]?.handover === true;
    let backoffOk = true;
    if (!exempt) {
      for (let i = 1; i < gaps.length; i++)
        if (gaps[i] < gaps[i - 1] * o.shrinkRatio - o.toleranceMs && gaps[i] < o.plateauMs) backoffOk = false;
      if (gaps.length >= 3 && !(gaps.at(-1) >= 2 * gaps[0] || gaps.at(-1) >= o.plateauMs)) backoffOk = false;
    }
    // Unbounded: a long outage whose tries do not slow down (the last third's median gap is under twice the
    // first third's and under the plateau). A hand-over run is short by design and is held to the same rule.
    let grows = true;
    if (gaps.length >= o.growthAfterGaps) {
      const third = Math.floor(gaps.length / 3),
        head = median(gaps.slice(0, third)),
        tail = median(gaps.slice(-third));
      grows = tail >= 2 * head || tail >= o.plateauMs;
    }
    return { tries: r.length, gapsMs: gaps, backoffOk, handover: exempt, grows, connected: r.at(-1).connected };
  });
  const lastConnect = attempts.findLast((a) => a.connected) ?? null;
  const triesAfterRecovery = lastConnect ? attempts.filter((a) => a.at > lastConnect.at).length : 0;
  const recovered = lastConnect !== null;
  const bounded =
    checkedRuns.every((r) => r.grows) && (attempts.length === 0 || (recovered && triesAfterRecovery === 0));
  return {
    tab,
    brokeAt: live?.failedAt ?? null,
    attempts,
    runs: checkedRuns,
    floorOk: attempts.every((a) => a.floorOk),
    backoffOk: checkedRuns.every((r) => r.backoffOk),
    bounded,
    recovered: attempts.length === 0 ? live !== null && live.failedAt === null : recovered,
    connectedAt: attempts.length === 0 ? (live?.connectedAt ?? null) : (lastConnect?.connectedAt ?? null),
    connectedStream: attempts.length === 0 ? (live?.stream?.id ?? null) : (lastConnect?.stream ?? null),
  };
}

/**
 * Reads after the tab reconnected, each marked invalidated or not, plus the negotiation reads.
 * @param {object} capture
 * @param {string} tab
 * @param {number|null} connectedAt when the tab's working stream answered after the fault
 */
export function readsAfterReconnect(capture, tab, connectedAt) {
  if (connectedAt === null || connectedAt < capture.fault.start)
    return { reads: [], count: 0, invalidated: 0, notModified: 0, negotiations: 0 };
  const rows = rowsOf(capture, tab);
  // The last publication count the tab knew before the fault: standing events and read headers.
  let known = null;
  for (const r of rows)
    if (typeof r.seq === "number" && endOf(r, capture) <= capture.fault.start) known = Math.max(known ?? r.seq, r.seq);
  for (const e of capture.events)
    if (e.tab === tab && e.name === "standing" && e.at <= capture.fault.start) {
      const s = seqOf(e);
      if (s !== null) known = Math.max(known ?? s, s);
    }
  const news = capture.events
    .filter(
      (e) =>
        e.tab === tab &&
        e.at >= connectedAt &&
        (!QUIET_EVENTS.has(e.name) || (e.name === "standing" && seqOf(e) !== known)),
    )
    .map((e) => e.at);
  const reads = rows
    .filter((r) => r.kind === "api" && r.start >= connectedAt)
    .map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      at: r.start,
      status: r.status ?? null,
      invalidated: news.some((t) => t <= r.start),
    }));
  return {
    reads,
    count: reads.length,
    invalidated: reads.filter((r) => r.invalidated).length,
    notModified: reads.filter((r) => r.status === 304).length,
    negotiations: rows.filter((r) => r.kind === "negotiate" && r.start >= connectedAt).length,
  };
}

const round = (x) => Math.round(x * 10) / 10;

function median(xs) {
  const v = [...xs].sort((a, b) => a - b),
    m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function seqOf(event) {
  try {
    const s = JSON.parse(event.data ?? "null")?.seq;
    return Number.isSafeInteger(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Time from the fault's end (and from the stream's answer) to the first event on the tab's working stream.
 * @param {object} capture
 * @param {string} tab
 * @param {string|null} streamId
 */
export function timeToFirstEvent(capture, tab, streamId) {
  if (streamId === null) return { fromFaultEndMs: null, fromOpenMs: null, event: null };
  const row = capture.rows.find((r) => r.tab === tab && r.id === streamId);
  const first = capture.events.filter((e) => e.tab === tab && e.row === streamId).sort((a, b) => a.at - b.at)[0];
  if (!first) return { fromFaultEndMs: null, fromOpenMs: null, event: null };
  return {
    fromFaultEndMs: round(Math.max(0, first.at - capture.fault.end)),
    fromOpenMs: round(first.at - (row?.response ?? row?.start ?? first.at)),
    event: first.name,
  };
}

/**
 * Everything S8 measures for one capture, per tab, and whether the per-capture predicate holds.
 * @param {object} capture
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function summarize(capture, options = {}) {
  if (capture?.schema !== SCHEMA) throw new Error(`not a reconnect capture (schema ${capture?.schema})`);
  const streams = streamsPerTab(capture);
  const tabs = capture.tabs.map(({ id }) => {
    const timeline = attemptTimeline(capture, id, options);
    const reads = readsAfterReconnect(capture, id, timeline.attempts.length ? timeline.connectedAt : null);
    const first = timeline.attempts.length
      ? timeToFirstEvent(capture, id, timeline.connectedStream)
      : { fromFaultEndMs: null, fromOpenMs: null, event: null };
    const oneStream = streams[id].max <= 1;
    const failures = [];
    if (!oneStream) failures.push(`${streams[id].max} streams open at once at ${streams[id].at} ms`);
    for (const a of timeline.attempts)
      if (!a.floorOk)
        failures.push(`try at ${a.at} ms came ${a.gapMs} ms after a failure, under retry ${a.floorMs} ms`);
    for (const r of timeline.runs)
      if (!r.backoffOk) failures.push(`no backoff over ${r.tries} tries (gaps ${r.gapsMs.join(", ")} ms)`);
    if (!timeline.bounded)
      failures.push(
        `attempts not bounded (${timeline.runs.map((r) => `${r.tries} tries${r.grows ? "" : " that never slow down"}`).join("; ")}${timeline.recovered ? "" : "; never reconnected"})`,
      );
    if (!timeline.recovered) failures.push("did not reconnect before the capture ended");
    return {
      tab: id,
      phase: capture.phase,
      maxStreams: streams[id].max,
      overlaps: streams[id].overlaps,
      attempts: timeline.attempts.length,
      attemptRequests: timeline.attempts.reduce((n, a) => n + a.requests, 0),
      reasks: timeline.attempts.reduce((n, a) => n + a.reasks, 0),
      timeline,
      reads,
      timeToFirstEvent: first,
      oneStream,
      floorOk: timeline.floorOk,
      backoffOk: timeline.backoffOk,
      bounded: timeline.bounded,
      recovered: timeline.recovered,
      ok: failures.length === 0,
      failures,
    };
  });
  const jitter = jitterOf(capture);
  for (const t of tabs) t.jitter = jitter;
  return {
    phase: capture.phase,
    fault: capture.fault,
    retryMs: capture.retryMs ?? null,
    jitter,
    tabs,
    ok: tabs.every((t) => t.ok),
  };
}

/**
 * The reconnect delays' randomness a capture ran with (O217): `"native"` (the page's own Math.random: equal jitter,
 * so the number of tries in a fixed outage varies between captures of one build: 3–5 a tab measured), or
 * `"fixed <v>"` when the journey's `--jitter <v>` pinned Math.random for the lab's control. Captures before O217
 * carry nothing and are native.
 */
export function jitterOf(capture) {
  return typeof capture?.jitter === "string" && /^fixed \d*\.?\d+$/.test(capture.jitter) ? capture.jitter : "native";
}

/**
 * S8's level (rubric §3 levels table) from the candidate's summaries and, optionally, the last release's.
 * Top-down, first match wins:
 *   0  unbounded attempts or > 1 stream per tab
 *   1  attempts or reads regressed — and (reading) any other failed predicate part: floor, backoff, no
 *      reconnect, or time to first event regressed. The table leaves those cells empty; 1 is the nearest.
 *   2  the predicate holds
 *   3  the predicate holds and every read after reconnect was invalidated
 * Without a baseline the "no worse than last release" part is NOT EVALUATED and the level is provisional.
 * Reads compare directly. Attempts compare only between captures with the same pinned jitter (`--jitter`; O217),
 * and time to first event only against an A/A floor (`ttfeFloorMs`); otherwise each is NOT EVALUATED, never a
 * regression. The paired estimator (§5) may pass its own verdicts in `comparison`.
 * @param {ReturnType<typeof summarize>[]} candidate one summary per phase
 * @param {ReturnType<typeof summarize>[]} [baseline] the last release's, matched by phase and tab
 * @param {{ttfeFloorMs?: number, comparison?: {attemptsRegressed?: boolean, readsRegressed?: boolean, ttfeRegressed?: boolean}}} [options]
 */
export function s8Level(candidate, baseline, options = {}) {
  const reasons = [],
    notEvaluated = [];
  const tabs = candidate.flatMap((s) => s.tabs);
  if (tabs.length === 0) return { level: null, reasons: ["no tabs captured"], notEvaluated: ["S8"], provisional: true };
  for (const t of tabs) {
    if (!t.oneStream) reasons.push(`${t.phase}/${t.tab}: ${t.maxStreams} streams at once`);
    if (!t.bounded) reasons.push(`${t.phase}/${t.tab}: unbounded attempts`);
  }
  if (reasons.length) return { level: 0, reasons, notEvaluated, provisional: false };

  // Time to first event is a timing (§5): compared only against an A/A floor; without one it is NOT EVALUATED, not
  // compared at zero (O217: v0.10.0 against itself scored level 1 on it alone, claude-207).
  const floor = Number.isFinite(options.ttfeFloorMs) ? options.ttfeFloorMs : null;
  let attemptsRegressed = options.comparison?.attemptsRegressed,
    readsRegressed = options.comparison?.readsRegressed,
    ttfeRegressed = options.comparison?.ttfeRegressed;
  if (baseline && (attemptsRegressed === undefined || readsRegressed === undefined || ttfeRegressed === undefined)) {
    const base = new Map(baseline.flatMap((s) => s.tabs).map((t) => [`${t.phase}/${t.tab}`, t]));
    const reg = { attempts: [], reads: [], ttfe: [] };
    for (const t of tabs) {
      const b = base.get(`${t.phase}/${t.tab}`);
      if (!b) {
        notEvaluated.push(`${t.phase}/${t.tab}: no last-release capture`);
        continue;
      }
      // Attempts follow the delays' jitter: two captures compare only when both pinned the same jitter (O217);
      // with the page's own randomness one build against itself gives 3–5 tries a tab, a difference of chance.
      const tj = t.jitter ?? "native",
        bj = b.jitter ?? "native";
      if (tj === bj && tj !== "native") {
        if (t.attempts > b.attempts)
          reg.attempts.push(`${t.phase}/${t.tab}: attempts ${b.attempts} → ${t.attempts} (${tj})`);
        else if (t.attemptRequests > b.attemptRequests)
          reg.attempts.push(
            `${t.phase}/${t.tab}: attempt requests ${b.attemptRequests} → ${t.attemptRequests} (${tj})`,
          );
      } else
        notEvaluated.push(
          `${t.phase}/${t.tab}: attempts ${b.attempts} → ${t.attempts} not compared: jitter ${bj} → ${tj} (compare captures with the same --jitter)`,
        );
      if (t.reads.count > b.reads.count)
        reg.reads.push(`${t.phase}/${t.tab}: reads after reconnect ${b.reads.count} → ${t.reads.count}`);
      const ct = t.timeToFirstEvent.fromFaultEndMs,
        bt = b.timeToFirstEvent.fromFaultEndMs;
      if (floor === null) {
        if (bt !== null || ct !== null)
          notEvaluated.push(
            `${t.phase}/${t.tab}: time to first event ${bt} → ${ct} ms not compared: no A/A floor (§5)`,
          );
      } else if (bt !== null && (ct === null || ct - bt > floor))
        reg.ttfe.push(`${t.phase}/${t.tab}: time to first event ${bt} → ${ct} ms`);
    }
    attemptsRegressed ??= reg.attempts.length > 0;
    readsRegressed ??= reg.reads.length > 0;
    ttfeRegressed ??= reg.ttfe.length > 0;
    reasons.push(...reg.attempts, ...reg.reads, ...reg.ttfe);
  } else if (!baseline && options.comparison === undefined) {
    notEvaluated.push("no regression check: no last-release capture");
  }
  if (attemptsRegressed || readsRegressed) return { level: 1, reasons, notEvaluated, provisional: false };
  const failed = tabs.filter((t) => !t.ok);
  for (const t of failed) reasons.push(...t.failures.map((f) => `${t.phase}/${t.tab}: ${f}`));
  if (failed.length || ttfeRegressed) return { level: 1, reasons, notEvaluated, provisional: false };
  const provisional = notEvaluated.length > 0;
  const onlyInvalidated = tabs.every((t) => t.reads.invalidated === t.reads.count);
  if (onlyInvalidated)
    return { level: 3, reasons: ["only invalidated reads after reconnect"], notEvaluated, provisional };
  const uninvalidated = tabs.reduce((n, t) => n + t.reads.count - t.reads.invalidated, 0);
  return {
    level: 2,
    reasons: [`${uninvalidated} read(s) after reconnect not preceded by a change event`],
    notEvaluated,
    provisional,
  };
}
