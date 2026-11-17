// The one request classifier: the smoke harness's live counter and duplicate invariant, the page-load lab's report
// and the archer-budget/1 rows all ask it whether a request repeats work. Pure: no browser, no files.

/**
 * The debug build tags each request a scheduled tick makes (ui/src/app/polls.ts) with `<poll>#<tick>`: the poll's
 * name and that tick's number, passed explicitly down the tick's own fetch path.
 */
export const POLL_HEADER = "x-archer-poll";
const POLL_TAG = /^([a-z][a-z-]*)#(\d+)$/;

/**
 * Event-stream messages that carry no data: the service's keep-alive. Every other message (a write, a presentation,
 * `standing`, a hand-over's `reconnect`) may change what the page should show, so a read after it is legitimate.
 */
export const TRANSPORT_EVENTS = new Set(["heartbeat"]);
/** Whether an event-stream message named `eventName` is a reason to read again. */
export const invalidates = (eventName) => !TRANSPORT_EVENTS.has(eventName);

/**
 * A committed edit (`POST …/api/authoring/edit`): one change a person made (a marquee delete is a chain of them, one
 * undo step). The per-view API cap is about what the page reads, so edits are counted apart; the same edit sent
 * twice is gated by `duplicate-writes` and `ui.edit.double-commit`. Same rule as ui/src/telemetry/requests.ts.
 */
export const isCommittedEdit = (r) => r.method === "POST" && /\/api\/authoring\/edit(?:[?#]|$)/.test(r.url);

/**
 * The page's scheduled polls by the name the debug build tags them with (ui/src/app/polls.ts POLL_INTERVAL_MS, the
 * one home of their intervals), each with the URLs its tick may read. A tagged request is a tick only when its tag
 * names a poll here that reads its URL: an unknown name, or a poll's tag on another URL, stays a duplicate.
 */
export const SCHEDULED_POLLS = [
  // SearchPage and WorkspaceNavigation: the project catalog.
  { name: "project-catalog", match: /\/api\/browser-projects(?:[?#]|$)/ },
  // workspace-notifications.tsx: the bell's reads, the catalog it shares included.
  {
    name: "notifications",
    match: /\/api\/(?:comments\?|(?:comment-activity|bootstrap|connection|browser-projects)(?:[?#]|$))/,
  },
];

/** Identity of a request: method, URL and (writes) body. */
export const requestKey = (r) => `${r.method} ${r.url}${r.body ? ` ${r.body}` : ""}`;

/** When a row started: `at` (harness, epoch ms) or `startMs` (lab, CDP ms). */
export const timeOf = (r) => r.at ?? r.startMs ?? 0;

/** The poll tag a row carries: `poll`, or the header among its request headers. Null when untagged. */
export function pollTagOf(r) {
  if (typeof r.poll === "string" && r.poll) return r.poll;
  for (const [k, v] of Object.entries(r.headers ?? {})) if (k.toLowerCase() === POLL_HEADER && v) return String(v);
  return null;
}

/** The poll's name in a row's tag (`project-catalog` of `project-catalog#12`), or null. */
export const pollNameOf = (r) => POLL_TAG.exec(pollTagOf(r) ?? "")?.[1] ?? null;

/**
 * The tick `r` was made by (its whole tag, `<poll>#<tick>`), when that tag names a poll here that reads its URL;
 * else null. An unknown name, a poll's tag on another URL, or a tag without a tick number is no tick.
 */
export function tickOf(r, polls = SCHEDULED_POLLS) {
  const tag = pollTagOf(r),
    name = POLL_TAG.exec(tag ?? "")?.[1];
  return name !== undefined && polls.some((p) => p.name === name && p.match.test(r.url)) ? tag : null;
}

/** Whether `r` is a tick of a scheduled poll: tagged by the debug build with a poll that reads its URL. */
export const isPollTick = (r, polls = SCHEDULED_POLLS) => tickOf(r, polls) !== null;

/**
 * Each request of one page view, in time order, with its kind:
 *   first     the first copy in this view
 *   tick      a repeat that a scheduled poll's tick made, once per tick (a second copy in the same tick is not)
 *   again     a repeat after something that changes what the page should show: a person's input or a service
 *             event (`invalidations`, times on the rows' clock, between the two copies; no heartbeat), or another
 *             answer (ETag)
 *   duplicate any other repeat: the page asked twice for the same thing
 * A harness step boundary is not an invalidation: an assertion-only step changes nothing (Codex pass-1 review 5).
 */
export function classifyRequests(requests, { polls = SCHEDULED_POLLS, invalidations = [] } = {}) {
  const marks = [...invalidations].sort((a, b) => a - b);
  const between = (from, to) => {
    for (const t of marks) {
      if (t > to) return false;
      if (t > from) return true;
    }
    return false;
  };
  const last = new Map(),
    asked = new Set();
  return [...requests]
    .sort((a, b) => timeOf(a) - timeOf(b))
    .map((r) => {
      const key = requestKey(r),
        prev = last.get(key),
        tick = tickOf(r, polls);
      last.set(key, r);
      // One copy of each request per tick: the tick's first ask is its own, a second is the page asking twice.
      const firstOfTick = tick !== null && !asked.has(`${tick} ${key}`);
      if (tick !== null) asked.add(`${tick} ${key}`);
      const kind =
        prev === undefined
          ? "first"
          : firstOfTick
            ? "tick"
            : typeof r.etag === "string" && typeof prev.etag === "string" && r.etag !== prev.etag
              ? "again"
              : between(timeOf(prev), timeOf(r))
                ? "again"
                : "duplicate";
      return { request: r, key, kind };
    });
}

/** Duplicates per request identity, most first: [{request, count}] where count includes the first copy. */
export function duplicatesOf(classified) {
  const extra = new Map();
  for (const c of classified) if (c.kind === "duplicate") extra.set(c.key, (extra.get(c.key) ?? 0) + 1);
  return [...extra].map(([request, n]) => ({ request, count: n + 1 })).sort((a, b) => b.count - a.count);
}
