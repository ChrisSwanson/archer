// Pure parts of the page-load lab: summarising one measured load, medians across runs, budgets,
// and the markdown summary. No browser here, so `node --test tools/perf/test/*.test.mjs` covers it.

import { failed } from "./budget.mjs";
import { classifyRequests, duplicatesOf, pollNameOf, requestKey } from "./requests.mjs";

/** Network profiles. `remote-link` is a remote reader over a VPN or similar link: ~20 Mbps, 40 ms RTT, a 4× slower CPU. */
export const PROFILES = {
  default: { network: null, cpu: 1 },
  "remote-link": {
    network: { latency: 40, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (20 * 1024 * 1024) / 8 },
    cpu: 4,
  },
};

/** Id-like path segments and query values do not distinguish one call from another. */
export function urlPattern(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return String(url).slice(0, 200);
  }
  const path = parsed.pathname
    .split("/")
    .map((s) => (/^(?:[0-9a-f]{12,}|[0-9]+)$/i.test(s) ? ":id" : s))
    .join("/");
  const names = [...new Set(parsed.searchParams.keys())];
  return `${path}${names.length ? `?${names.join("&")}` : ""}`;
}

/** Frames that only forward a request (fetch wrappers, promise plumbing) say nothing about who asked. */
const PLUMBING =
  /^(?:[\w$]+\.)*(fetch|\(anonymous\)|Promise|then|browserFetch|call|jsonRead|read|readJson|jsonResponse|request|send|get|post)$/; // "Ute.window.fetch": the telemetry wrapper

/**
 * A CDP `Network.requestWillBeSent` initiator → the call site that issued the request: up to 6 app frames
 * (`name file:line:col`, outermost last), sync stack first, then its async parents. Null for parser/other initiators.
 */
export function initiatorOf(initiator, depth = 6) {
  if (!initiator?.stack) return initiator?.type && initiator.type !== "script" ? initiator.type : null;
  const frames = [];
  for (let st = initiator.stack; st && frames.length < 40; st = st.parent)
    for (const f of st.callFrames ?? []) frames.push(f);
  const named = frames.filter((f) => f.url && !PLUMBING.test(f.functionName || "(anonymous)"));
  const pick = (named.length ? named : frames).slice(0, depth);
  return (
    pick
      .map(
        (f) =>
          `${f.functionName || "(anonymous)"} ${String(f.url).split("/").pop().split("?")[0].slice(0, 40)}:${f.lineNumber + 1}:${f.columnNumber + 1}`,
      )
      .join(" < ") || null
  );
}

const topCounts = (list, n = 3) => {
  const m = new Map();
  for (const x of list) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([site, count]) => ({ site, count }));
};

/** `total;dur=12.5, compile;dur=3` → `{total: 12.5, compile: 3}`. */
export function parseServerTiming(header) {
  const result = {};
  if (!header) return result;
  for (const metric of String(header).split(",")) {
    const [name, ...params] = metric.split(";").map((p) => p.trim());
    if (!name) continue;
    const dur = params.find((p) => p.toLowerCase().startsWith("dur="));
    const value = dur ? Number(dur.slice(4)) : 0;
    result[name] = Number.isFinite(value) ? value : 0;
  }
  return result;
}

/**
 * One load, from the requests the browser made and what the page reported.
 * `requests`: [{url, method, type, status, startMs, endMs, transferBytes, decodedBytes, fromCache, serverTiming, poll?}]
 * Duplicates and poll ticks come from the shared classifier (requests.mjs), as in the budget row.
 * `page`: {ttfb, fcp, lcp, cls, longTasks:[ms], heapUsedBytes, domNodes, telemetryWarnings?}
 */
export function summariseLoad({ requests, page, wallMs, invalidations = [] }) {
  const counted = requests.filter((r) => r.type !== "EventSource");
  const byPattern = new Map(),
    serverTiming = {};
  for (const r of counted) {
    const pattern = `${r.method} ${urlPattern(r.url)}`;
    byPattern.set(pattern, (byPattern.get(pattern) ?? 0) + 1);
    for (const [name, dur] of Object.entries(r.serverTiming ?? {}))
      serverTiming[name] = (serverTiming[name] ?? 0) + dur;
  }
  const classified = classifyRequests(counted, { invalidations });
  // Scheduled poll ticks (the debug build's tag), per request: how often and at what median interval.
  const ticks = new Map();
  for (const c of classified) if (c.kind === "tick") (ticks.get(c.key) ?? ticks.set(c.key, []).get(c.key)).push(c);
  const polls = [...ticks]
    .map(([request, list]) => {
      const times = classified.filter((c) => c.key === request).map((c) => c.request.startMs ?? c.request.at ?? 0);
      const gaps = times
        .slice(1)
        .map((t, i) => t - times[i])
        .sort((a, b) => a - b);
      return {
        poll: pollNameOf(list[0].request),
        request: request.slice(0, 200),
        count: list.length,
        intervalMs: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null,
      };
    })
    .sort((a, b) => b.count - a.count);
  // With --initiators each request carries the call site that issued it: duplicates and top patterns name theirs.
  const sitesFor = (match) => topCounts(counted.filter(match).map((r) => r.initiator));
  const withSites = counted.some((r) => r.initiator !== undefined);
  const duplicates = duplicatesOf(classified).map((d) => ({
    ...d,
    ...(withSites ? { initiators: sitesFor((r) => requestKey(r) === d.request) } : {}),
  }));
  const slowest = [...counted]
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
    .slice(0, 8)
    .map((r) => ({
      request: `${r.method} ${urlPattern(r.url)}`,
      ms: Math.round(r.endMs - r.startMs),
      status: r.status,
      transferBytes: r.transferBytes,
      ...(r.serverTiming?.total !== undefined ? { serverMs: r.serverTiming.total } : {}),
    }));
  // Requests overlap, so their Server-Timing durations ADD UP to more than any wall-clock time: `serverTimingMs` is a
  // sum (kept under its name for the reports that read it); `serverBusyMs` is the wall-clock time at least one
  // request that reported a Server-Timing header was in flight (the union of their spans).
  const spans = counted
    .filter((r) => Object.keys(r.serverTiming ?? {}).length > 0)
    .map((r) => [r.startMs, r.endMs])
    .sort((a, b) => a[0] - b[0]);
  let serverBusyMs = 0,
    edge = -Infinity;
  for (const [a, b] of spans) {
    const from = Math.max(a, edge);
    if (b > from) serverBusyMs += b - from;
    edge = Math.max(edge, b);
  }
  const longTasks = page.longTasks ?? [];
  const document = counted.find((r) => r.type === "Document");
  return {
    wallMs: Math.round(wallMs),
    requests: counted.length,
    cachedRequests: counted.filter((r) => r.fromCache).length,
    transferBytes: sum(counted.map((r) => r.transferBytes ?? 0)),
    decodedBytes: sum(counted.map((r) => r.decodedBytes ?? 0)),
    documentDecodedBytes: document?.decodedBytes ?? null,
    failedRequests: counted.filter(failed).length,
    duplicateRequests: sum(duplicates.map((d) => d.count - 1)),
    duplicates: duplicates.slice(0, 10),
    polls: polls.slice(0, 5),
    topPatterns: [...byPattern]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([request, count]) => ({
        request,
        count,
        ...(withSites ? { initiators: sitesFor((r) => `${r.method} ${urlPattern(r.url)}` === request) } : {}),
      })),
    slowest,
    ttfbMs: round(page.ttfb),
    fcpMs: round(page.fcp),
    lcpMs: round(page.lcp),
    cls: page.cls === undefined || page.cls === null ? null : Math.round(page.cls * 1000) / 1000,
    longTasks: longTasks.length,
    longTaskMs: Math.round(sum(longTasks)),
    heapUsedMb: page.heapUsedBytes ? Math.round((page.heapUsedBytes / 1048576) * 10) / 10 : null,
    // After two forced GCs (report only): what the page keeps, main thread and its workers apart.
    heapAfterGcMb: mb(page.heapAfterGcBytes),
    workerHeapAfterGcMb: mb(page.workerHeapAfterGcBytes),
    domNodes: page.domNodes ?? null,
    serverTimingMs: Object.fromEntries(Object.entries(serverTiming).map(([k, v]) => [k, Math.round(v)])), // SUM over requests (they overlap): not a wall time
    serverBusyMs: Math.round(serverBusyMs),
    ...(page.telemetryWarnings ? { telemetryWarnings: page.telemetryWarnings } : {}),
  };
}

const sum = (values) => values.reduce((a, b) => a + b, 0);
const mb = (bytes) => (typeof bytes === "number" ? Math.round((bytes / 1048576) * 100) / 100 : null);

/**
 * Bytes on the wire for what a page needs to start, from the page's Resource Timing (the navigation entry plus
 * resources): the document, scripts, workers (a worker's script is initiatorType "other"; the page's CDP session
 * never sees its response), styles and fonts. API reads, images and data: URIs are left out (an inline asset is
 * part of the page). `transferSize` is 0 for a cache hit, so a warm load shows what revalidation costs.
 * Returns null without entries. Report only: nothing gates on it yet.
 */
export function firstLoadBytes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const out = { page: 0, scripts: 0, workers: 0, styles: 0, fonts: 0, total: 0, decoded: 0, files: 0 };
  for (const e of entries) {
    const path = String(e.name ?? "").replace(/[?#].*$/, "");
    const kind =
      e.entryType === "navigation"
        ? "page"
        : /\.(?:woff2?|ttf|otf)$/i.test(path)
          ? "fonts"
          : /\.css$/i.test(path)
            ? "styles"
            : /\.m?js$/i.test(path)
              ? e.initiatorType === "other"
                ? "workers"
                : "scripts"
              : null;
    if (kind === null) continue;
    out[kind] += e.transferSize ?? 0;
    out.total += e.transferSize ?? 0;
    out.decoded += e.decodedBodySize ?? 0;
    out.files++;
  }
  return out;
}

/**
 * Where a page's elements are: the shell (everything outside <main>), tree and table rows (`[role=row]`; a row
 * holding a column header is a header), and the rest of <main>. `rows`/`headers`: elements per row, the row
 * itself included; `main`: elements in <main> (itself included) or null without one. Separates growth from more
 * content (more rows) from heavier rows. Report only.
 */
export function domShape({ total, main, rows, headers }) {
  const rowElements = sum(rows),
    headerElements = sum(headers);
  return {
    total,
    shell: main === null ? null : total - main,
    rows: rows.length,
    rowElements,
    perRow: rows.length ? Math.round((rowElements / rows.length) * 10) / 10 : null,
    maxPerRow: rows.length ? Math.max(...rows) : null,
    headers: headers.length,
    headerElements,
    otherInMain: main === null ? null : main - rowElements - headerElements,
  };
}

/** The in-page half of domShape: run with page.evaluate(DOM_SHAPE_SCRIPT). */
export const DOM_SHAPE_SCRIPT = `(() => {
  const size = (el) => el.getElementsByTagName("*").length + 1;
  const main = document.querySelector("main");
  const rows = [], headers = [];
  for (const row of document.querySelectorAll("[role=row]")) (row.querySelector("[role=columnheader]") ? headers : rows).push(size(row));
  return { total: document.getElementsByTagName("*").length, main: main ? size(main) : null, rows, headers };
})()`;
const round = (v) => (v === undefined || v === null || !Number.isFinite(v) ? null : Math.round(v));

/** Numeric fields take the median across runs; the rest come from the median-wall-time run. */
export function medianOf(runs) {
  if (runs.length === 1) return runs[0];
  const byWall = [...runs].sort((a, b) => a.wallMs - b.wallMs),
    base = { ...byWall[Math.floor(byWall.length / 2)] };
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "number") continue;
    const values = runs
      .map((r) => r[key])
      .filter((v) => typeof v === "number")
      .sort((a, b) => a - b);
    base[key] = values[Math.floor(values.length / 2)];
  }
  base.runs = runs.length;
  return base;
}

/** Fields a budget may cap, with how to seed a cap from a measured value. */
export const BUDGET_FIELDS = {
  transferBytes: (v) => Math.ceil((v * 1.15) / 1024) * 1024,
  decodedBytes: (v) => Math.ceil((v * 1.15) / 1024) * 1024,
  requests: (v) => Math.ceil(v * 1.15 + 2),
  // No head-room: the release check allows 0 duplicates per page (config.json maxDuplicateRequestsPerPage), so a lab cap above the measured count would only hide one.
  duplicateRequests: (v) => v,
  lcpMs: (v) => Math.ceil((v * 1.3 + 200) / 100) * 100,
  wallMs: (v) => Math.ceil((v * 1.3 + 300) / 100) * 100,
  longTaskMs: (v) => Math.ceil((v * 1.3 + 100) / 50) * 50,
  domNodes: (v) => Math.ceil(v * 1.2 + 50),
};

/**
 * `{"<page>/<profile>/<state>": {field: max}}` from a report, with head-room for noise. `previous` (the budget file
 * being replaced) refuses a row whose count caps would fall below `SEED_MAX_DROP` of the old ones: the first seed
 * baked in editor pages at 9 DOM nodes from a half-applied change. `acceptDrop` takes such drops as real.
 */
export function seedBudgets(report, note, { previous, acceptDrop = false } = {}) {
  const budgets = {},
    refused = [];
  for (const r of report.results) {
    const key = `${r.page}/${r.profile}/${r.state}`;
    // A broken row (it failed, asked the service nothing, or drew an all-but-empty page) would seed caps that
    // bless the breakage: such a row is refused and named, never written as a budget.
    const why = seedRefusal(r);
    if (why !== null) {
      refused.push({ key, reason: why });
      continue;
    }
    const caps = {};
    for (const [field, seed] of Object.entries(BUDGET_FIELDS))
      if (typeof r.metrics[field] === "number") caps[field] = seed(r.metrics[field]);
    const drop = acceptDrop ? null : seedDrop(caps, previous?.budgets?.[key]);
    if (drop !== null) {
      refused.push({ key, reason: drop });
      continue;
    }
    budgets[key] = caps;
  }
  return {
    generatedAt: report.generatedAt,
    base: report.base,
    ...(note ? { note } : {}),
    budgets,
    ...(refused.length ? { refused } : {}),
  };
}

/** Fewer DOM nodes than this is a blank or error page, not the page being measured. */
export const SEED_MIN_DOM_NODES = 50;
/** A new cap below this share of the old one, for a count that does not move with load, needs `acceptDrop`. */
export const SEED_MAX_DROP = 0.5;
/** A cold load that moved less than this share of its document's decoded bytes was served from the cache. */
export const SEED_MIN_COLD_SHARE = 0.1;
const DROP_FIELDS = ["domNodes", "requests"];

/** Why a lab row must not seed a budget, or null when it may. */
export function seedRefusal(r) {
  if (r.error) return `the load failed: ${String(r.error).slice(0, 120)}`;
  const api = r.budgetRow?.apiRequests ?? r.metrics?.apiRequests;
  if (api === 0) return "no API request: the page never reached the service";
  const dom = r.metrics?.domNodes;
  if (typeof dom === "number" && dom < SEED_MIN_DOM_NODES)
    return `${dom} DOM nodes (< ${SEED_MIN_DOM_NODES}): a blank or error page`;
  const moved = r.metrics?.transferBytes,
    document = r.metrics?.documentDecodedBytes;
  if (
    r.state === "cold" &&
    typeof moved === "number" &&
    typeof document === "number" &&
    moved < document * SEED_MIN_COLD_SHARE
  )
    return `a cold load moved ${moved} bytes for a ${document}-byte document: it came from the cache`;
  return null;
}

/** Why caps falling this far from `old` look like a broken page, or null. */
function seedDrop(caps, old) {
  if (old === undefined) return null;
  const drops = DROP_FIELDS.filter(
    (f) => typeof caps[f] === "number" && typeof old[f] === "number" && caps[f] < old[f] * SEED_MAX_DROP,
  ).map((f) => `${f} ${caps[f]} (was ${old[f]})`);
  return drops.length
    ? `caps would fall below half the budget being replaced: ${drops.join(", ")}; a half-drawn page? Check it, then --accept-drop`
    : null;
}

/** Every measured value over its cap. Pages/fields absent from the budget are not checked. */
export function overBudget(report, budgetFile) {
  const failures = [];
  for (const r of report.results) {
    const caps = budgetFile.budgets?.[`${r.page}/${r.profile}/${r.state}`];
    if (!caps) continue;
    for (const [field, cap] of Object.entries(caps)) {
      const value = r.metrics[field];
      if (typeof value === "number" && typeof cap === "number" && value > cap)
        failures.push({ key: `${r.page}/${r.profile}/${r.state}`, field, value, cap });
    }
  }
  return failures;
}

const kb = (b) =>
  b === null || b === undefined ? "–" : b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${Math.round(b / 1024)} KB`;
const ms = (v) => (v === null || v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`);

export function markdown(report, failures = []) {
  const lines = [
    `# Archer page-load lab`,
    "",
    `${report.generatedAt} · ${report.base} · project \`${report.project}\` · diagram \`${report.diagram ?? "–"}\` · runs ${report.runs}`,
    "",
  ];
  if (report.knownBaseline) lines.push(`Known baseline: ${report.knownBaseline}`, "");
  lines.push(
    "| page | profile | load | wall | transfer | decoded | requests | dup | TTFB | FCP | LCP | CLS | long tasks | heap | DOM | server total (sum) | server busy (wall) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of report.results) {
    const m = r.metrics;
    if (r.error) {
      lines.push(
        `| ${r.page} | ${r.profile} | ${r.state} | failed: ${r.error.replaceAll("|", "/").slice(0, 120)} |||||||||||||`,
      );
      continue;
    }
    lines.push(
      `| ${r.page} | ${r.profile} | ${r.state} | ${ms(m.wallMs)} | ${kb(m.transferBytes)} | ${kb(m.decodedBytes)} | ${m.requests} | ${m.duplicateRequests} | ${ms(m.ttfbMs)} | ${ms(m.fcpMs)} | ${ms(m.lcpMs)} | ${m.cls ?? "–"} | ${m.longTasks} (${ms(m.longTaskMs)}) | ${m.heapUsedMb ?? "–"} MB | ${m.domNodes ?? "–"} | ${m.serverTimingMs?.total !== undefined ? ms(m.serverTimingMs.total) : "–"} | ${m.serverBusyMs ? ms(m.serverBusyMs) : "–"} |`,
    );
  }
  const shaped = report.results.filter((r) => !r.error && (r.metrics?.firstLoad || r.metrics?.dom));
  if (shaped.length) {
    lines.push(
      "",
      "## First load and DOM shape (report only)",
      "",
      "Transfer bytes from Resource Timing; DOM: elements outside `<main>` (shell), per `[role=row]` row and header, and the rest of `<main>`.",
      "",
      "| page | profile | load | document | scripts | workers | styles | fonts | total | rows × elements (max) | headers | shell | rest of main |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of shaped) {
      const f = r.metrics.firstLoad,
        d = r.metrics.dom;
      lines.push(
        `| ${r.page} | ${r.profile} | ${r.state} | ${f ? [f.page, f.scripts, f.workers, f.styles, f.fonts, f.total].map(kb).join(" | ") : "– | – | – | – | – | –"} | ${d ? `${d.rows} × ${d.perRow ?? "–"} (${d.maxPerRow ?? "–"})` : "–"} | ${d ? `${d.headers} (${d.headerElements})` : "–"} | ${d?.shell ?? "–"} | ${d?.otherInMain ?? "–"} |`,
      );
    }
  }
  lines.push("", "## Where the requests go (default profile, cold)", "");
  for (const r of report.results.filter((x) => x.profile === "default" && x.state === "cold" && !x.error)) {
    lines.push(
      `### ${r.page} — \`${r.path}\``,
      "",
      "Most frequent: " + (r.metrics.topPatterns ?? []).map((p) => `\`${p.request}\` ×${p.count}`).join(", "),
      "",
    );
    if (r.metrics.polls?.length)
      lines.push(
        "Polling: " +
          r.metrics.polls
            .map((p) => `\`${p.request.slice(0, 100)}\` every ${ms(p.intervalMs)} (×${p.count})`)
            .join(", "),
        "",
      );
    if (r.metrics.duplicates?.length)
      lines.push(
        "Duplicates: " +
          r.metrics.duplicates
            .slice(0, 5)
            .map((d) => `\`${d.request.slice(0, 100)}\` ×${d.count}`)
            .join(", "),
        "",
      );
    for (const d of (r.metrics.duplicates ?? []).filter((x) => x.initiators?.length).slice(0, 5))
      lines.push(
        `- \`${d.request.slice(0, 80)}\` from: ${d.initiators.map((i) => `\`${i.site}\` ×${i.count}`).join("; ")}`,
      );
    if (r.metrics.duplicates?.some((x) => x.initiators?.length)) lines.push("");
    lines.push(
      "Slowest: " +
        (r.metrics.slowest ?? [])
          .slice(0, 5)
          .map(
            (s) =>
              `\`${s.request}\` ${ms(s.ms)} (${kb(s.transferBytes)}${s.serverMs !== undefined ? `, server ${ms(Math.round(s.serverMs))}` : ""})`,
          )
          .join(", "),
      "",
    );
  }
  if (failures.length) {
    lines.push("## Over budget", "", "| page/profile/load | metric | measured | budget |", "|---|---|---|---|");
    for (const f of failures) lines.push(`| ${f.key} | ${f.field} | ${f.value} | ${f.cap} |`);
  }
  return lines.join("\n") + "\n";
}
