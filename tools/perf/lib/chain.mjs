// Request dependency depth on the critical path (performance rubric S1 "chain depth"). Pure: rows in, depth out.
import { createHash } from "node:crypto";
//
// A request's depth is 1 for the document (2 after an alias redirect) and otherwise 1 + the deepest of its parents:
// - its initiator (CDP `Network.requestWillBeSent` `initiator`): the parser's or preload's document; for a script
//   initiator the resource holding the stack's top frame with a URL (an external script's request, or the document
//   for an inline script); anything else (an EventSource, `other`) hangs off the document.
// - for a script-initiated request whose stack crossed an async boundary (an `await`, a `.then`, a timer: the stack
//   has a `parent`), the data response it waited for. CDP does not name which response a continuation awaited, so the
//   collector takes the latest-ending data request (Fetch/XHR, not a stream, not a prefetch) that ended before this
//   one started, at most `gapMs` earlier: start-after-end, never one with the same initiator stack (`stackKey`: the
//   same code in the same continuation, a sibling however late the host let it start; claude-308). A request issued
//   synchronously when a script ran has no async parent; two requests issued in one task are siblings, not a chain.
//   Limit: a loop awaiting each read from one call site issues its 3rd and later reads with one stack, so the
//   loop reads one level from its 2nd read on (shown in chain-live.test.mjs).
// Async boundaries need async stacks (`page-load.mjs --initiators` sets Runtime.setAsyncCallStackDepth). Without
// them every script request is treated as possibly async, which gives an upper bound, reported as such.
//
// The depth of a load is the longest chain among the rows on the critical path: those starting no later than
// route-ready (all rows when it is unknown), streams and prefetches left out. Validated on serial, parallel, chained
// (script → script → data) and worker controls in tools/perf/test/chain.test.mjs, against a real Chromium in
// tools/perf/test/chain-live.test.mjs.

/** The default async gap (ms) between a response ending and the request that waited for it starting. */
export const CHAIN_GAP_MS = 250;

/**
 * What the collector keeps of a CDP initiator: type, the parser's URL, the top frame with a URL, and whether (and
 * through what) the stack crossed an async boundary. Stored on every lab row as `initiatorInfo`.
 */
export function chainInitiator(initiator) {
  if (!initiator) return null;
  let frameUrl = null;
  for (let st = initiator.stack; st && !frameUrl; st = st.parent)
    frameUrl = (st.callFrames ?? []).find((f) => f.url)?.url ?? null;
  const parent = initiator.stack?.parent ?? null;
  return {
    type: initiator.type ?? null,
    url: initiator.url ?? null,
    frameUrl,
    async: parent !== null,
    asyncKind: parent?.description ?? null,
    ...(initiator.stack ? { stackKey: stackKey(initiator.stack) } : {}),
  };
}

/**
 * The call site of a request as its whole initiator stack, every segment's boundary and frames by script position
 * (url:line:column), hashed short. Requests with one key were issued by the same code from the same continuation:
 * the project badges' three `comment-activity` reads, issued as siblings after the catalog's answer, share one
 * (claude-308).
 */
export function stackKey(stack) {
  const parts = [];
  for (let st = stack, d = 0; st && d < 16; st = st.parent, d++)
    parts.push(
      `${st.description ?? ""}|${(st.callFrames ?? []).map((f) => `${f.url}:${f.lineNumber}:${f.columnNumber}`).join(",")}`,
    );
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

const isData = (r) => /^(fetch|xhr)$/i.test(r.type ?? "");
const isStream = (r) => /^eventsource$/i.test(r.type ?? "");
const isDocument = (r) => /^document$/i.test(r.type ?? "");
const strip = (u) => String(u ?? "").split("#")[0];

/**
 * Depth per row and for the load. `rows`: lab rows ({requestId?, url, type, startMs, endMs, status?,
 * initiatorInfo?}); `readyMs`: route-ready on the rows' clock, or null; `isPrefetch(row)`: rows to leave out of the
 * critical path (the manifest's measured prefetch phase); `asyncStacks`: whether the rows were recorded with async
 * stacks. Returns {depth, chain: [url…] (the longest path, root first), method, gapMs, rows: [{url, depth, parent}]}.
 */
export function chainDepth(
  rows,
  { readyMs = null, isPrefetch = () => false, asyncStacks = true, gapMs = CHAIN_GAP_MS } = {},
) {
  const sorted = [...rows].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  const depth = new Map(),
    parentOf = new Map();
  const documentRow =
    sorted.find((r) => isDocument(r) && !(r.status >= 300 && r.status < 400)) ?? sorted.find(isDocument) ?? null;
  const byUrlBefore = (url, before) =>
    sorted
      .filter((q) => q !== before && strip(q.url) === strip(url) && (q.startMs ?? 0) <= (before.startMs ?? 0))
      .at(-1) ?? null;
  for (const r of sorted) {
    const info = r.initiatorInfo ?? null,
      parents = [];
    if (isDocument(r)) {
      // An alias: the redirect answer is the same request id, recorded first.
      const redirect = sorted.find(
        (q) =>
          q !== r &&
          q.requestId !== undefined &&
          q.requestId === r.requestId &&
          q.status >= 300 &&
          q.status < 400 &&
          (q.startMs ?? 0) <= (r.startMs ?? 0),
      );
      if (redirect && depth.has(redirect)) parents.push(redirect);
    } else {
      let initiatorRow = null;
      if (info?.type === "script" && info.frameUrl) initiatorRow = byUrlBefore(info.frameUrl, r);
      else if ((info?.type === "parser" || info?.type === "preload") && info.url)
        initiatorRow = byUrlBefore(info.url, r);
      initiatorRow ??= documentRow !== r ? documentRow : null;
      if (initiatorRow && depth.has(initiatorRow)) parents.push(initiatorRow);
      const maybeAsync = info?.type === "script" ? (asyncStacks ? info.async : true) : false;
      if (maybeAsync && typeof r.startMs === "number") {
        // A request with the same initiator stack as this one is a sibling from the same code and continuation,
        // never the response it awaited (claude-308): under host load the second of three sibling badge reads can
        // start after the first ends, and start-after-end alone then chained them, so depth followed the load.
        const key = info?.stackKey ?? null;
        const waited = sorted
          .filter(
            (q) =>
              q !== r &&
              depth.has(q) &&
              isData(q) &&
              !isPrefetch(q) &&
              typeof q.endMs === "number" &&
              q.endMs <= r.startMs &&
              r.startMs - q.endMs <= gapMs &&
              !(key !== null && q.initiatorInfo?.stackKey === key),
          )
          .reduce((best, q) => (best === null || q.endMs > best.endMs ? q : best), null);
        if (waited) parents.push(waited);
      }
    }
    const best = parents.reduce((b, p) => (b === null || depth.get(p) > depth.get(b) ? p : b), null);
    depth.set(r, best ? depth.get(best) + 1 : 1);
    parentOf.set(r, best);
  }
  const critical = sorted.filter(
    (r) =>
      !isStream(r) && !isPrefetch(r) && (readyMs === null || typeof r.startMs !== "number" || r.startMs <= readyMs),
  );
  const deepest = critical.reduce((b, r) => (b === null || depth.get(r) > depth.get(b) ? r : b), null);
  const chain = [];
  for (let r = deepest; r; r = parentOf.get(r)) chain.unshift(r.url);
  return {
    depth: deepest ? depth.get(deepest) : 0,
    chain,
    gapMs,
    method: asyncStacks
      ? "initiators + async stacks, start-after-end for awaited data"
      : "initiators without async stacks: every script request may wait (an upper bound)",
    rows: sorted.map((r) => ({ url: r.url, depth: depth.get(r), parent: parentOf.get(r)?.url ?? null })),
  };
}
