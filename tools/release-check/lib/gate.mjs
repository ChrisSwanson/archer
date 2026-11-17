// Pure gate logic for `npm run release-check`: archer-budget/1 blocks, warnings, failed requests,
// vitest results and page size in, {id, ok, title, details[]} checks out. No files, no processes.
// Config: tools/release-check/config.json; allow-list: tools/release-check/allowed-warnings.json.

const fmtBytes = (b) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;

/** "GET http://127.0.0.1:9/p/a/api/x?token=…" → "GET /p/a/api/x?token=…": allow-lists match method + path, never the port. */
export function requestPath(request) {
  return String(request)
    .replace(/\bhttps?:\/\/[^/\s]+/g, "")
    .replace(/([?&]token=)[^&#\s]+/g, "$1…");
}

const regex = (entry) => new RegExp(entry.match);
const TIMING_FIELDS = new Set(["lcpMs", "wallMs", "longTaskMs"]);

/**
 * Per page view, from every archer-budget/1 block: duplicate requests (none unless allow-listed), API requests
 * (poll ticks excluded), bytes on the wire, duplicate writes, and the lab's own over-budget rows and errors.
 * `sources`: [{run, budget}]. Returns one check per rule.
 */
export function checkBudgets(sources, config) {
  const dupDetails = [],
    apiDetails = [],
    thumbDetails = [],
    bytesDetails = [],
    writeDetails = [],
    labDetails = [],
    timingDetails = [];
  const allow = (config.allowedDuplicates ?? []).map((e) => ({ ...e, re: regex(e) }));
  let pages = 0;
  for (const { run, budget } of sources) {
    for (const p of budget.pages ?? []) {
      pages++;
      const where = `${run} ${p.key} ${requestPath(p.url ?? "")}`;
      // Duplicates: each listed request's extra copies, minus what an allow-list entry explains.
      let explained = 0,
        listed = 0;
      const unexplained = [];
      for (const d of p.duplicates ?? []) {
        const req = requestPath(d.request),
          extra = d.count - 1;
        listed += extra;
        const entry = allow.find((e) => e.re.test(req));
        const ok = entry
          ? Math.min(extra, entry.maxCopies === undefined ? extra : Math.max(0, entry.maxCopies - 1))
          : 0;
        explained += ok;
        if (extra > ok) unexplained.push(`${req} ×${d.count}`);
      }
      const hidden = Math.max(0, (p.duplicateRequests ?? 0) - listed);
      const over = (p.duplicateRequests ?? 0) - explained;
      if (over > (config.maxDuplicateRequestsPerPage ?? 0))
        dupDetails.push(
          `${where}: ${unexplained.join(", ")}${hidden ? `${unexplained.length ? "; " : ""}${hidden} not listed (top 10 only)` : ""}`,
        );
      const api = (p.apiRequests ?? 0) - (p.pollTicks ?? 0);
      if (config.maxApiRequestsPerPage !== undefined && api > config.maxApiRequestsPerPage)
        apiDetails.push(`${where}: ${api} API requests > ${config.maxApiRequestsPerPage}`);
      if (
        config.maxThumbnailRequestsPerPage !== undefined &&
        (p.thumbnailRequests ?? 0) > config.maxThumbnailRequestsPerPage
      )
        thumbDetails.push(`${where}: ${p.thumbnailRequests} thumbnail images > ${config.maxThumbnailRequestsPerPage}`);
      if (
        config.maxTransferBytesPerPage !== undefined &&
        typeof p.transferBytes === "number" &&
        p.transferBytes > config.maxTransferBytesPerPage
      )
        bytesDetails.push(`${where}: ${fmtBytes(p.transferBytes)} > ${fmtBytes(config.maxTransferBytesPerPage)}`);
      // A warm reload (lab rows "<page>/<profile>/warm") re-downloading the page means caching headers regressed.
      if (
        config.maxWarmTransferBytes !== undefined &&
        /\/warm$/.test(p.key) &&
        typeof p.transferBytes === "number" &&
        p.transferBytes > config.maxWarmTransferBytes
      )
        bytesDetails.push(
          `${where}: warm reload moved ${fmtBytes(p.transferBytes)} > ${fmtBytes(config.maxWarmTransferBytes)} (caching headers?)`,
        );
    }
    if ((budget.totals?.duplicateWrites ?? 0) > 0)
      writeDetails.push(`${run}: ${budget.totals.duplicateWrites} step(s) sent the same write twice`);
    // Timings move with machine load: over the cap is a warning, over `timingFailFactor` × the cap a failure.
    // Counts, bytes and DOM size do not move with load: over the cap fails.
    for (const o of budget.overBudget ?? []) {
      const timing = TIMING_FIELDS.has(o.field),
        factor = config.timingFailFactor === undefined ? 2 : config.timingFailFactor;
      const line = `${o.key} ${o.field} ${o.value} > ${o.cap}`;
      if (timing && (factor === null || o.value <= o.cap * factor))
        timingDetails.push(`${line} (warn${factor === null ? "" : `: fails above ${factor}× the cap`})`);
      else labDetails.push(timing ? `${line} (over ${factor}× the cap)` : line);
    }
    for (const e of budget.errors ?? []) labDetails.push(`${e.key}: ${e.error}`);
  }
  const check = (id, title, details) => ({ id, ok: details.length === 0, title, details });
  const out = [
    check(
      "duplicate-requests",
      `duplicate requests per page view (${pages} views, allowed ${config.maxDuplicateRequestsPerPage ?? 0} + allow-list)`,
      dupDetails,
    ),
    check(
      "api-requests-per-page",
      `API requests per page view ≤ ${config.maxApiRequestsPerPage} (poll ticks and thumbnail images excluded)`,
      apiDetails,
    ),
    ...(config.maxThumbnailRequestsPerPage === undefined
      ? []
      : [
          check(
            "thumbnail-requests-per-page",
            `thumbnail images per page view ≤ ${config.maxThumbnailRequestsPerPage}`,
            thumbDetails,
          ),
        ]),
    check(
      "transfer-bytes-per-page",
      `bytes per page view ≤ ${fmtBytes(config.maxTransferBytesPerPage ?? 0)}`,
      bytesDetails,
    ),
    check("duplicate-writes", "no write sent twice", writeDetails),
  ];
  if (sources.some((s) => s.budget.source === "page-load")) {
    out.push(
      check(
        "lab-budget",
        "page-load lab: counts, bytes and DOM within the lab budget file, timings within its factor, every row completed",
        labDetails,
      ),
    );
    out.push({
      id: "lab-timing",
      ok: true,
      warn: timingDetails.length > 0,
      title: "page-load lab timings within their caps",
      details: timingDetails,
    });
  }
  return out;
}

/**
 * Warning budget. `warnings`: [{run, code, msg|null}]. Every `ui.*`/`svc.*` code fails unless an allow-list entry
 * `{code, reason, match?, run?, max?}` covers it: `match` (a regex on the message) only covers warnings whose message
 * is known; `run` (a regex on the run name: a journey, or "lab") limits it to some runs; `max` caps the total across
 * the whole gate. Other codes (`harness.*`) are reported, never gated.
 */
export function checkWarnings(warnings, allowList) {
  const entries = allowList.map((e) => ({
    ...e,
    re: e.match ? regex(e) : null,
    runRe: e.run ? new RegExp(e.run) : null,
    count: 0,
  }));
  const denied = new Map(),
    notes = new Map();
  for (const w of warnings) {
    if (!/^(ui|svc)\./.test(w.code ?? "")) {
      notes.set(w.code, (notes.get(w.code) ?? 0) + 1);
      continue;
    }
    const entry = entries.find(
      (e) =>
        e.code === w.code &&
        (e.runRe === null || e.runRe.test(w.run ?? "")) &&
        (e.re === null || (typeof w.msg === "string" && e.re.test(w.msg))),
    );
    if (entry) {
      entry.count++;
      continue;
    }
    const d = denied.get(w.code) ?? { count: 0, example: null, runs: new Set() };
    d.count++;
    d.runs.add(w.run);
    d.example ??= w.msg;
    denied.set(w.code, d);
  }
  const details = [];
  for (const [code, d] of [...denied].sort((a, b) => b[1].count - a[1].count))
    details.push(
      `${code} ×${d.count} not allowed (${[...d.runs].slice(0, 4).join(", ")}${d.runs.size > 4 ? ", …" : ""})${d.example ? `: ${d.example.slice(0, 140)}` : ""}`,
    );
  for (const e of entries)
    if (e.max !== undefined && e.count > e.max)
      details.push(
        `${e.code}${e.match ? ` /${e.match}/` : ""} ×${e.count} over its allowance of ${e.max} (${e.reason})`,
      );
  return {
    id: "warnings",
    ok: details.length === 0,
    title: "warning budget: every ui.*/svc.* code allow-listed (tools/release-check/allowed-warnings.json)",
    details,
    allowed: entries
      .filter((e) => e.count > 0)
      .map((e) => ({ code: e.code, match: e.match, count: e.count, max: e.max, reason: e.reason })),
    notGated: Object.fromEntries(notes),
  };
}

/**
 * Failed requests from the harness's requests.jsonl rows: HTTP ≥ 400 or a network error. An aborted request
 * (navigation cancelled it: net::ERR_ABORTED) is not a failure; `/-/debug/` uploads are not the app's.
 * `allowList`: [{match, reason}] on "METHOD /path".
 */
export function checkFailedRequests(sources, allowList = []) {
  const allow = allowList.map((e) => ({ ...e, re: regex(e) }));
  const seen = new Map();
  for (const { run, requests } of sources)
    for (const r of requests) {
      if (/\/-\/debug\//.test(r.url)) continue;
      const aborted = r.status == null && /ERR_ABORTED|canceled/i.test(String(r.error ?? r.failure ?? ""));
      const failed =
        (typeof r.status === "number" && r.status >= 400) || (r.status == null && !aborted && (r.error || r.failure));
      if (!failed) continue;
      const req = requestPath(`${r.method} ${r.url}`).replace(/\?.*$/, "");
      if (allow.some((e) => e.re.test(req))) continue;
      const key = `${r.status ?? r.error ?? r.failure} ${req}`;
      const s = seen.get(key) ?? { count: 0, runs: new Set() };
      s.count++;
      s.runs.add(run);
      seen.set(key, s);
    }
  const details = [...seen].map(([k, s]) => `${k} ×${s.count} (${[...s.runs].slice(0, 3).join(", ")})`);
  return {
    id: "failed-requests",
    ok: details.length === 0,
    title: "no failed requests (HTTP ≥ 400 or network error; aborted excluded)",
    details,
  };
}

/**
 * A vitest JSON report → PASS / WARN / FAIL. Failures that are all a missing ripgrep (the retrieval evaluation's
 * "ripgrep (rg) is not installed", or a bare `spawnSync rg ENOENT`) while ripgrep is not on PATH
 * are an environment gap (WARN, named), not a pass and not an app failure. A missing report or a suite that failed
 * to load is a FAIL.
 */
export function classifyVitest(report, { exitCode, rgOnPath = false } = {}) {
  if (!report)
    return {
      status: "FAIL",
      details: [`no JSON report (exit ${exitCode}): the run crashed or was killed; see the log`],
    };
  const failed = [];
  for (const file of report.testResults ?? []) {
    const tests = (file.assertionResults ?? []).filter((t) => t.status === "failed");
    if (tests.length === 0 && file.status === "failed")
      failed.push({ name: `${file.name} (suite)`, message: file.message ?? "" });
    for (const t of tests)
      failed.push({
        name: `${file.name.replace(/^.*?\/(test|tests)\//, "$1/")} > ${t.fullName}`,
        message: (t.failureMessages ?? []).join("\n"),
      });
  }
  const counts = `${report.numPassedTests ?? "?"} passed, ${failed.length} failed, ${report.numPendingTests ?? 0} skipped`;
  if (failed.length === 0)
    return exitCode === 0
      ? { status: "PASS", details: [counts] }
      : { status: "FAIL", details: [counts, `vitest exited ${exitCode} with no failed test: see the log`] };
  const envGap = (f) => /spawnSync rg ENOENT|ripgrep \(rg\) is not installed/.test(f.message);
  if (!rgOnPath && failed.every(envGap))
    return {
      status: "WARN",
      details: [
        counts,
        `all ${failed.length} failure(s) are a missing ripgrep: ripgrep (rg) is not installed here. Environment gap, not a pass: install rg and re-run.`,
        ...failed.slice(0, 4).map((f) => `  skipped: ${f.name}`),
      ],
    };
  return {
    status: "FAIL",
    details: [
      counts,
      ...failed
        .filter((f) => rgOnPath || !envGap(f))
        .slice(0, 12)
        .map((f) => `  ✗ ${f.name}: ${f.message.split("\n")[0].slice(0, 160)}`),
    ],
  };
}

/** Production page size: raw, gzip and brotli bytes against caps. */
export function checkPageSize(size, caps, label = "production page") {
  const details = [];
  const exact = (b) => `${b.toLocaleString("en-US")} B`;
  for (const [field, cap] of [
    ["raw", caps.maxRawBytes],
    ["gzip", caps.maxGzipBytes],
    ["brotli", caps.maxBrotliBytes],
  ]) {
    if (cap !== undefined && size[field] > cap)
      details.push(`${field} ${exact(size[field])} > ${exact(cap)} (+${exact(size[field] - cap)})`);
  }
  return {
    id: "page-size",
    ok: details.length === 0,
    title: `${label} ${fmtBytes(size.raw)} (gzip ${fmtBytes(size.gzip)}, br ${fmtBytes(size.brotli)})`,
    details,
  };
}

export { fmtBytes };

/**
 * The built page without what the working tree added to ui/index.html beyond HEAD (a dev-only helper such as the
 * Impeccable live tag, with its token): each added non-blank line is removed verbatim from the build. `external`
 * lists every remaining `<script src="http…">` that HEAD's index.html does not have: the caller fails on it.
 */
export function cleanPage(html, { head, work }) {
  const headLines = new Set(head.split(/\r?\n/).map((l) => l.trim()));
  const added = work
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !headLines.has(l) && !/^<\/(body|html)>$/.test(l));
  let out = html;
  const removed = [];
  for (const line of added)
    if (out.includes(line)) {
      out = out.split(line).join("");
      removed.push(line.replace(/token=[^"&\s]+/g, "token=…"));
    }
  const external = [...out.matchAll(/<script[^>]*\ssrc="(https?:\/\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !head.includes(src));
  return { html: out, removed, external };
}
