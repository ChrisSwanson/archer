// Machine-readable budget results, one shape for the smoke harness (summary.json → `budget`) and the page-load lab
// (<out>/summary.json → `budget`), so a release check can gate on either without knowing which produced it.
// Pure: no browser, no files. Field reference: docs/devkit/agent-harness.md "Budget results".

export const BUDGET_SCHEMA = "archer-budget/1";

import { SCHEDULED_POLLS, classifyRequests, duplicatesOf, isCommittedEdit } from "./requests.mjs";

/**
 * One page view (one document load, or one lab load) summarised for gating.
 * `requests`: [{method, url, type?, at|startMs, transferBytes?, decodedBytes?, status?, body?, etag?, poll?, headers?}]
 * already limited to that view; `invalidations`: times (the rows' clock) of a person's inputs and service events
 * (harness only). Ticks and duplicates come from the shared classifier (requests.mjs classifyRequests): a repeat is
 * a duplicate unless the debug build tagged it as a scheduled poll, an invalidation came between, or its ETag changed.
 * Thumbnail images (`api/thumbnails/`: immutable, cached a year, fetched ahead at low priority once per session
 * for every listed project) are `thumbnailRequests`, not `apiRequests`: the API cap is about the page's reads.
 * Committed edits (requests.mjs isCommittedEdit: one per change a person made) are `editRequests`, for the same reason.
 */
export function pageBudget({
  key,
  url,
  requests,
  polls = SCHEDULED_POLLS,
  invalidations = [],
  isApi = (u) => /\/api\//.test(u),
  isThumbnail = (u) => /\/api\/thumbnails\//.test(u),
  extra = {},
}) {
  const counted = requests.filter((r) => !/^eventsource$/i.test(r.type ?? ""));
  const classified = classifyRequests(counted, { polls, invalidations });
  const thumbnails = counted.filter((r) => isThumbnail(r.url)).length;
  const edits = counted.filter(isCommittedEdit).length;
  const api = counted.filter((r) => !isThumbnail(r.url) && isApi(r.url) && !isCommittedEdit(r)).length;
  // A tick lowers the gated API count (gate.mjs: apiRequests - pollTicks), so only an API request's tick is one.
  const ticks = classified.filter(
    (c) => c.kind === "tick" && !isThumbnail(c.request.url) && isApi(c.request.url),
  ).length;
  const duplicates = duplicatesOf(classified).map((d) => ({ ...d, request: d.request.slice(0, 240) }));
  const bytes = (f) =>
    counted.some((r) => typeof r[f] === "number") ? counted.reduce((a, r) => a + (r[f] ?? 0), 0) : null;
  return {
    key,
    url,
    requests: counted.length,
    apiRequests: api,
    thumbnailRequests: thumbnails,
    editRequests: edits,
    pollTicks: ticks,
    duplicateRequests: duplicates.reduce((a, d) => a + d.count - 1, 0),
    duplicates: duplicates.slice(0, 10),
    transferBytes: bytes("transferBytes"),
    decodedBytes: bytes("decodedBytes"),
    failedRequests: counted.filter(failed).length,
    ...extra,
  };
}

/**
 * HTTP >= 400, or no response at all. A request the browser cancelled (a navigation or an AbortController:
 * net::ERR_ABORTED, `canceled`) is not a failure: the same rule as the release check's failed-requests gate.
 */
export function failed(r) {
  if (typeof r.status === "number") return r.status >= 400;
  if (r.status !== null && r.status !== undefined) return false;
  return !(r.canceled === true || /ERR_ABORTED|canceled|cancelled/i.test(String(r.error ?? r.failure ?? "")));
}

/** Count codes: ["a","b","a"] or [{code}] → {a: 2, b: 1}. */
export function countCodes(list) {
  const out = {};
  for (const x of list) {
    const c = typeof x === "string" ? x : (x?.code ?? "(none)");
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

const addCounts = (into, from) => {
  for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + v;
  return into;
};

/**
 * The `budget` block. `pages` from pageBudget; `warnings` a {code: count} map; `failures` (harness only) a list of
 * {kind, invariant?}. `duplicateWrites` counts identical write bodies (harness only).
 */
export function budgetResults({
  source,
  name,
  generatedAt = new Date().toISOString(),
  pages,
  warnings = {},
  failures = null,
  duplicateWrites = null,
  overBudget = null,
}) {
  const max = (f) => pages.reduce((a, p) => Math.max(a, p[f] ?? 0), 0);
  const total = (f) =>
    pages.some((p) => typeof p[f] === "number") ? pages.reduce((a, p) => a + (p[f] ?? 0), 0) : null;
  const byCode = addCounts({}, warnings);
  return {
    schema: BUDGET_SCHEMA,
    source,
    name,
    generatedAt,
    totals: {
      pages: pages.length,
      requests: total("requests"),
      apiRequests: total("apiRequests"),
      duplicateRequests: total("duplicateRequests"),
      ...(duplicateWrites === null ? {} : { duplicateWrites }),
      transferBytes: total("transferBytes"),
      failedRequests: total("failedRequests"),
      maxApiRequestsPerPage: max("apiRequests"),
      maxDuplicateRequestsPerPage: max("duplicateRequests"),
    },
    warnings: { total: Object.values(byCode).reduce((a, b) => a + b, 0), byCode },
    ...(failures === null
      ? {}
      : {
          failures: {
            total: failures.length,
            byInvariant: countCodes(failures.filter((f) => f.kind === "invariant").map((f) => f.invariant)),
            actions: failures.filter((f) => f.kind !== "invariant").length,
          },
        }),
    ...(overBudget === null ? {} : { overBudget }),
    pages,
  };
}
