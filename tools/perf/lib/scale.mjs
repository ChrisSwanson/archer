// Pure parts of the scale count gates (tools/perf/scale-gates.mjs): turning one measured load into counts, and
// judging the counts of the S, M (and opt-in L) corpora against tools/perf/scale-budgets.json. No browser, no files.
//
// Counts gate; timings warn (decision D5: no quiet runner yet).

/** Request paths. The catalog is the global project list; comment fetches are the per-target thread reads. */
export const isCatalog = (url) => /\/api\/(?:browser-)?projects(?:\?|$)/.test(url);
export const isCommentFetch = (r) => r.method === "GET" && /\/api\/comments(?:\?|$)/.test(r.url);

/** The counts of one load. `requests` as the lab records them; `domNodes` and `commits` as the page reported them. */
export function countsOf({ requests, domNodes, commits, apiRequests }) {
  const counted = requests.filter((r) => !/^eventsource$/i.test(r.type ?? ""));
  const catalog = counted.filter((r) => isCatalog(r.url));
  return {
    apiRequests,
    commentFetches: counted.filter(isCommentFetch).length,
    // The largest catalog body seen in the load, as decoded bytes (what the page has to parse).
    catalogBytes: catalog.reduce((a, r) => Math.max(a, r.decodedBytes ?? 0), 0),
    domNodes: domNodes ?? null,
    commits: commits ?? null,
  };
}

/** The counts that must stay under a cap, and the ones that only grow with the corpus (judged by ratio). */
export const CAPPED = ["apiRequests", "commentFetches", "catalogBytes", "domNodes", "commits"];

/**
 * Judge a run. `measured`: { S: { views, pages: { <page>: counts }, probe: { contentEncoding }, timings }, M: {...}, L?: {...} }.
 * `budgets`: tools/perf/scale-budgets.json: per size and page the caps; `growth` the allowed ratio M/S per field;
 * `timings` the warn-only limits. Returns { failures, warnings, notes }; a failure is a string a person can act on.
 */
export function judge(measured, budgets) {
  const failures = [],
    warnings = [],
    notes = [];
  for (const [size, result] of Object.entries(measured)) {
    const caps = budgets.sizes?.[size];
    if (caps === undefined) {
      notes.push(`${size}: no caps in scale-budgets.json; counts reported only`);
    }
    // The first page request after a start is compressed (slice 4): it carries a content-encoding.
    if (!["gzip", "br"].includes(result.probe?.contentEncoding ?? "")) {
      failures.push(
        `${size}: the first page request after the sandbox started came back ${result.probe?.contentEncoding ?? "uncompressed"} (${result.probe?.bytes ?? "?"} bytes); it must carry content-encoding gzip or br`,
      );
    }
    for (const [page, counts] of Object.entries(result.pages)) {
      for (const field of CAPPED) {
        const cap = caps?.[page]?.[field];
        const value = counts[field];
        if (cap === undefined || cap === null || value === null || value === undefined) continue;
        if (value > cap)
          failures.push(`${size}/${page} ${field} ${value} > ${cap}${tightenNote(budgets, size, page, field)}`);
      }
    }
    for (const red of result.knownRed ?? []) warnings.push(red);
    for (const [key, limit] of Object.entries(budgets.timings ?? {}).filter(([k]) => !k.startsWith("$"))) {
      const value = result.timings?.[key];
      if (typeof value === "number" && value > limit)
        warnings.push(`${size} ${key} ${value} ms > ${limit} ms (timings warn, they do not fail)`);
    }
  }
  const small = measured.S,
    mid = measured.M;
  if (small && mid) {
    for (const [field, factor] of Object.entries(budgets.growth ?? {}).filter(([k]) => !k.startsWith("$"))) {
      for (const page of Object.keys(mid.pages)) {
        const a = small.pages[page]?.[field],
          b = mid.pages[page]?.[field];
        if (typeof a !== "number" || typeof b !== "number") continue;
        const ratio = b / Math.max(a, 1);
        if (ratio > factor)
          failures.push(
            `growth S->M ${page} ${field}: ${a} -> ${b} is x${ratio.toFixed(2)} > x${factor}${tightenNote(budgets, "growth", page, field)}`,
          );
      }
    }
  }
  return { failures, warnings, notes };
}

/** A loose budget names the slice that should tighten it: `tighten["<size>/<page>/<field>"]`. */
function tightenNote(budgets, size, page, field) {
  const slice = budgets.tighten?.[`${size}/${page}/${field}`] ?? budgets.tighten?.[`${size}/${field}`];
  return slice ? ` (set to today's value; ${slice} should tighten it)` : "";
}

/** The Event Timing entries of one interaction: the longest `duration` (input to next paint) per event name. */
export function inputToPaint(entries, names) {
  const worst = {};
  for (const e of entries) {
    if (!names.includes(e.name)) continue;
    worst[e.name] = Math.max(worst[e.name] ?? 0, e.duration);
  }
  return worst;
}

/** A short markdown table of a run, for the report. */
export function markdown(measured, verdict) {
  const lines = [
    "# Scale count gates",
    "",
    verdict.failures.length ? `**FAIL**: ${verdict.failures.length} over` : "**PASS**",
    "",
  ];
  lines.push(
    "| size | page | apiRequests | commentFetches | catalogBytes | domNodes | commits |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [size, result] of Object.entries(measured))
    for (const [page, c] of Object.entries(result.pages))
      lines.push(`| ${size} | ${page} | ${CAPPED.map((f) => c[f] ?? "-").join(" | ")} |`);
  const shaped = Object.entries(measured).flatMap(([size, result]) =>
    Object.entries(result.pages)
      .filter(([, c]) => c.dom)
      .map(([page, c]) => [size, page, c.dom]),
  );
  if (shaped.length) {
    lines.push(
      "",
      "DOM shape (report only): elements outside `<main>`, `[role=row]` rows × elements per row (max), headers, rest of `<main>`.",
      "",
      "| size | page | shell | rows × per row (max) | headers | rest of main |",
      "|---|---|---|---|---|---|",
    );
    for (const [size, page, d] of shaped)
      lines.push(
        `| ${size} | ${page} | ${d.shell ?? "-"} | ${d.rows} × ${d.perRow ?? "-"} (${d.maxPerRow ?? "-"}) | ${d.headers} (${d.headerElements}) | ${d.otherInMain ?? "-"} |`,
      );
  }
  lines.push(
    "",
    ...verdict.failures.map((f) => `- FAIL ${f}`),
    ...verdict.warnings.map((w) => `- warn ${w}`),
    ...verdict.notes.map((n) => `- note ${n}`),
    "",
  );
  return lines.join("\n");
}
