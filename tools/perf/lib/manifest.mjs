// The request manifest (performance rubric G1, S1): every request a page makes in its window must match an entry
// for its surface and state in tools/perf/manifests.json — method, pattern, target, phase, max count and a reason
// or PERF-EX id. A read whose target is not the shown view matches only a `prefetch` entry naming its trigger and
// byte cost. Pure: no browser, no files. Used by `page-load.mjs --manifest/--write-manifest` and
// `tools/perf/manifest-tool.mjs` (offline checks of saved rows, the B baseline's included).

export const MANIFEST_SCHEMA = "archer-perf-manifest/1";
export const PHASES = ["document", "boot", "data", "stream", "prefetch", "idle"];
export const TARGETS = ["route", "none", "other"];

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** POST bodies: the fields that name what a write or read is about (`op`, `target.kind`). */
const bodyOf = (r) => {
  const raw = r.body ?? r.bodyPrefix;
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * The URL pattern an entry matches: the path with the project slug, view ids, note paths and asset hashes replaced
 * (`/p/:project/api/emphasis/:view`, `/-/page-assets/elk-layout-worker-:hash.js`), query keys sorted without
 * values, and for POSTs the body's `op` (presentation reads and saves differ). Documents keep their query keys
 * (`?tab`, `?edit`) so the list tabs stay apart.
 */
export function manifestPattern(r) {
  let u;
  try {
    u = new URL(r.url);
  } catch {
    return `${r.method} ${String(r.url).slice(0, 120)}`;
  }
  let path = u.pathname
    .replace(/^\/p\/[^/]+\//, "/p/:project/")
    .replace(/\/api\/(diagrams|emphasis|thumbnails)\/[^/?#]+/, "/api/$1/:view")
    .replace(/-[A-Za-z0-9_-]{8}\.(js|css|woff2?)$/, "-:hash.$1");
  if (/^document$/i.test(r.type ?? ""))
    path = path
      .replace(/^\/projects\/[^/]+\/.+$/, "/projects/:project/:file")
      .replace(/^\/projects\/[^/]+\/$/, "/projects/:project/");
  const keys = [...new Set(u.searchParams.keys())].sort();
  const tab = /^document$/i.test(r.type ?? "") && u.searchParams.get("tab") ? `=${u.searchParams.get("tab")}` : "";
  const query = keys.length ? `?${keys.map((k) => (k === "tab" ? `tab${tab}` : k)).join("&")}` : "";
  const body = bodyOf(r),
    prefixOp = /^\{"op":"([a-z-]+)"/.exec(r.body ?? r.bodyPrefix ?? "")?.[1];
  const op = body && typeof body.op === "string" ? ` op=${body.op}` : prefixOp ? ` op=${prefixOp}` : "";
  return `${r.method} ${path}${query}${op}`;
}

/**
 * What a request is about: the view and note identities its URL or body names (`view:<id>`, `note:<path>`).
 * Embedded figures are `view:<note path>#<name>`. A request naming none (the catalog, the stream, assets) is about
 * nothing in particular and gets target `none`.
 */
export function identitiesOf(r) {
  const ids = new Set();
  let u;
  try {
    u = new URL(r.url);
  } catch {
    return [];
  }
  const m = /\/api\/(?:diagrams|emphasis|thumbnails)\/([^/?#]+)/.exec(u.pathname);
  if (m) ids.add(`view:${decode(m[1])}`);
  for (const [k, v] of u.searchParams) {
    if (k === "viewId" && v) ids.add(`view:${v}`);
    else if (k === "target" && /^(view|note):/.test(v)) ids.add(v);
    else if (k === "path" && v) ids.add(`note:${v}`);
    else if (k === "address" && v) ids.add(`view:${v}`);
  }
  const body = bodyOf(r);
  // A saved row may hold only a prefix of the body (the lab keeps 200 characters): read the names it can.
  if (!body && typeof (r.body ?? r.bodyPrefix) === "string")
    for (const m of (r.body ?? r.bodyPrefix).matchAll(/"viewId":"([^"]+)"/g)) ids.add(`view:${m[1]}`);
  if (body) {
    const t = body.target;
    if (typeof body.viewId === "string") ids.add(`view:${body.viewId}`);
    if (t && typeof t === "object") {
      if (typeof t.viewId === "string") ids.add(`view:${t.viewId}`);
      if (t.kind === "note" && typeof t.path === "string") ids.add(`note:${t.path}`);
    }
  }
  return [...ids];
}

/** The project a request is scoped to: the slug in `/p/<slug>/…`, or null for the global routes (`/api/…`, assets). */
export function projectOf(r) {
  try {
    return decode(/^\/p\/([^/]+)\//.exec(new URL(r.url).pathname)?.[1] ?? "") || null;
  } catch {
    return null;
  }
}

/**
 * Requests for content that can sit outside the first view: a gallery thumbnail and a note's embedded figure. For
 * these the lab's in-view identities at route-ready (`inView`) decide the measured phase: in view is `data`, out of
 * view `prefetch` (rubric §6: needed only if visible content uses it at once).
 */
export const VISIBLE_ASSET = (r) => /\/api\/thumbnails\/|\/api\/notes\/diagram(?:[?#]|$)/.test(String(r.url));

/**
 * What the route shows, as a predicate over a request's identities. `shown`: {views?: string[], notes?: string[],
 * thumbnails?: "*"}: a diagram page shows its view; a note page its note and the figures embedded in it
 * (`<note>#…`); the Diagrams gallery shows every view's thumbnail (`thumbnails: "*"`) but no view itself, so a
 * per-view read there (emphasis, comments, walkthroughs) is about a view it does not show; lists, the projects
 * page and a new draft show none.
 */
export function shownPredicate(shown = {}) {
  const views = shown.views ?? [],
    notes = shown.notes ?? [];
  return (id, r) => {
    if (shown.thumbnails === "*" && r && /\/api\/thumbnails\//.test(r.url)) return true;
    if (id.startsWith("view:")) {
      const v = id.slice(5);
      return views.includes(v) || notes.some((n) => v.startsWith(`${n}#`));
    }
    if (id.startsWith("note:")) return notes.includes(id.slice(5));
    return false;
  };
}

/**
 * `route` when the request names something the route shows, `other` when it names only things it does not, else
 * `none`. A page scoped to one project (`shown.project`) shows nothing of another: a `/p/<other>/` read there is
 * `other` whatever it names (the global projects page sets no project and may read every project's summary).
 */
export function targetOf(r, shown = {}) {
  const project = projectOf(r);
  if (shown.project && project !== null && project !== shown.project) return "other";
  const ids = identitiesOf(r);
  if (ids.length === 0) return "none";
  const isShown = shownPredicate(shown);
  return ids.some((id) => isShown(id, r)) ? "route" : "other";
}

/**
 * The phase a request was measured in, from the row alone, never from the entry it matches (G1 checks the two
 * agree): the document; the stream; a script, style or font (boot); a read of a target the page does not show
 * (prefetch); a thumbnail or figure out of the first view when the lab recorded what was in view (prefetch), in
 * view (data); a read that starts after route-ready (idle; a thumbnail then is prefetch when nothing says it was in
 * view); else data. `readyMs` and times on the rows' clock; either may be missing. `inView`: the identities in the
 * viewport at route-ready (a Set), or null when not recorded.
 */
export function guessPhase(r, { readyMs = null, target = "none", inView = null } = {}) {
  const type = (r.type ?? "").toLowerCase();
  if (type === "document") return "document";
  if (type === "eventsource") return "stream";
  if (["script", "stylesheet", "font"].includes(type)) return "boot";
  if (target === "other") return "prefetch";
  if (inView && VISIBLE_ASSET(r)) return identitiesOf(r).some((id) => inView.has(id)) ? "data" : "prefetch";
  if (readyMs !== null && typeof r.startMs === "number" && r.startMs > readyMs)
    return /\/api\/thumbnails\//.test(r.url) ? "prefetch" : "idle";
  return "data";
}
/** The same function under the name the checker uses for it: the row's own, measured phase. */
export const measuredPhase = guessPhase;

/** Problems with the manifest itself (empty reasons fail; an other-target entry must be a prefetch with trigger and bytes). */
export function validateManifest(manifest) {
  const problems = [];
  const exceptions = new Set((manifest.exceptions ?? []).map((e) => e.id));
  // A PERF-EX record holds what rubric §4 lists: the metric, its scope, the evidence, the rationale, the residual impact,
  // the maintainer's approval and when it is reviewed again; `upTo` bounds the value it covers when given.
  const text = (v) => typeof v === "string" && v.trim() !== "";
  const scope = (v) => v === undefined || v === "*" || (Array.isArray(v) && v.length > 0 && v.every(text));
  (manifest.exceptions ?? []).forEach((x, i) => {
    const at = `exceptions[${i}] ${x?.id ?? "(no id)"}`;
    if (!/^PERF-EX-\d+$/.test(x?.id ?? "")) problems.push(`${at}: id must be PERF-EX-<n>`);
    if (!text(x?.metric)) problems.push(`${at}: metric is required`);
    for (const k of ["surfaces", "states", "profiles"])
      if (!scope(x?.[k])) problems.push(`${at}: ${k} must be "*" or a list of names`);
    if (x?.surfaces === undefined || x?.states === undefined) problems.push(`${at}: scope needs surfaces and states`);
    if (x?.upTo !== undefined && !(typeof x.upTo === "number" && Number.isFinite(x.upTo) && x.upTo >= 0))
      problems.push(`${at}: upTo must be a number ≥ 0`);
    if (!(text(x?.evidence) || (Array.isArray(x?.evidence) && x.evidence.length > 0 && x.evidence.every(text))))
      problems.push(`${at}: evidence is required`);
    for (const k of ["rationale", "residual", "review"]) if (!text(x?.[k])) problems.push(`${at}: ${k} is required`);
    if (!(text(x?.approval) || text(x?.approval?.by))) problems.push(`${at}: approval (the maintainer's) is required`);
  });
  if (exceptions.size !== (manifest.exceptions ?? []).length) problems.push("exceptions: ids must be unique");
  for (const [surface, states] of Object.entries(manifest.surfaces ?? {})) {
    for (const [state, entries] of Object.entries(states)) {
      entries.forEach((e, i) => {
        const at = `${surface}/${state}[${i}] ${e.pattern}`;
        if (!e.method || !e.pattern) problems.push(`${at}: method and pattern are required`);
        if (!TARGETS.includes(e.target)) problems.push(`${at}: target must be one of ${TARGETS.join(", ")}`);
        if (!PHASES.includes(e.phase)) problems.push(`${at}: phase must be one of ${PHASES.join(", ")}`);
        if (!Number.isInteger(e.max) || e.max < 1) problems.push(`${at}: max must be a positive integer`);
        const reason = typeof e.reason === "string" ? e.reason.trim() : "";
        if (!reason && !e.exception) problems.push(`${at}: empty reason (give a reason or a PERF-EX id)`);
        if (e.exception && !exceptions.has(e.exception))
          problems.push(`${at}: exception ${e.exception} is not recorded in "exceptions"`);
        if (e.target === "other" && e.phase !== "prefetch")
          problems.push(
            `${at}: a read of a target the page does not show matches only a prefetch entry naming its trigger and byte cost`,
          );
        if (
          e.phase === "prefetch" &&
          (typeof e.trigger !== "string" || !e.trigger.trim() || typeof e.bytes !== "number")
        )
          problems.push(`${at}: a prefetch entry must name its trigger and byte cost`);
        if (
          e.debugPattern !== undefined &&
          (typeof e.debugPattern !== "string" || !e.debugPattern.startsWith(`${e.method} `))
        )
          problems.push(`${at}: debugPattern must be a pattern of the same method`);
      });
    }
  }
  return problems;
}

/**
 * Checks one load's rows against the entries for its surface and state.
 * `rows`: request rows (method, url, type, body?, startMs?); SSE included. `shown`: see shownPredicate (and
 * `shown.project`, the one project a project page shows). `readyMs`: route-ready on the rows' clock. `inView`: the
 * identities in the viewport at route-ready (an array or Set; null when not recorded: thumbnails and figures then
 * cannot be told needed from prefetched, and a load whose entries split them is NOT EVALUATED, see `inViewNeeded`).
 * `variant`: "debug" lets an entry's `debugPattern` (the debug page's form of the same request, e.g. the stream's
 * `?page-load` key) match too, sharing the entry's max. `allowProposed`: count entries not yet approved
 * (`approved: false`) as matches; they are reported apart and the gate cannot pass while any is used.
 *
 * Each row's phase is measured (`measuredPhase`), never taken from the entry it matches; an entry matches a row only
 * when method, pattern, target and phase all agree. Returns {pass, draftPass, rows:[{…row, pattern, target, phase,
 * verdict}], unmatched, wrongTarget, wrongPhase, overCount, proposedUsed, byPhase, kinds, problems}. A row's
 * verdict: matched | proposed | unmatched | wrong-target | wrong-phase | over-count.
 */
export function checkLoad({
  rows,
  entries = [],
  shown = {},
  readyMs = null,
  inView = null,
  variant = "production",
  allowProposed = false,
  problems = [],
}) {
  const used = new Map();
  const seen = inView ? new Set(inView) : null;
  const patternMatches = (e, pattern) => e.pattern === pattern || (variant === "debug" && e.debugPattern === pattern);
  const out = [...rows]
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
    .map((r) => {
      const pattern = manifestPattern(r),
        target = targetOf(r, shown),
        phase = measuredPhase(r, { readyMs, target, inView: seen });
      const same = entries.filter(
        (e) =>
          e.method === r.method &&
          patternMatches(e, pattern) &&
          e.target === target &&
          (allowProposed || e.approved !== false),
      );
      const candidates = same.filter((e) => e.phase === phase);
      // The first candidate with room; a row past every candidate's max is over-count against the last.
      const entry = candidates.find((e) => (used.get(e) ?? 0) < e.max) ?? null;
      let verdict;
      if (entry) {
        used.set(entry, (used.get(entry) ?? 0) + 1);
        verdict = entry.approved === false ? "proposed" : "matched";
      } else if (candidates.length) verdict = "over-count";
      else if (same.length) verdict = "wrong-phase";
      else verdict = target === "other" ? "wrong-target" : "unmatched";
      return {
        ...r,
        pattern,
        target,
        phase,
        verdict,
        ...(verdict === "wrong-phase" ? { entryPhases: [...new Set(same.map((e) => e.phase))] } : {}),
        ...(entry ? { reason: entry.exception ?? entry.reason } : {}),
      };
    });
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, out.filter((r) => r.phase === p).length]));
  const kinds = new Set(out.map((r) => r.pattern)).size;
  const of = (v) => out.filter((r) => r.verdict === v);
  const unmatched = of("unmatched"),
    wrongTarget = of("wrong-target"),
    wrongPhase = of("wrong-phase"),
    overCount = of("over-count"),
    proposedUsed = of("proposed");
  // A load whose entries tell in-view thumbnails or figures from prefetched ones, measured without the in-view
  // identities, cannot show which is which: NOT EVALUATED, not a pass.
  const inViewNeeded =
    seen === null &&
    out.some((r) => VISIBLE_ASSET(r)) &&
    entries.some(
      (e) =>
        VISIBLE_ASSET({ url: `http://x${e.pattern.split(" ")[1] ?? ""}` }) &&
        e.phase === "prefetch" &&
        e.target === "route",
    );
  // `draftPass`: every row has an entry (approved or proposed); `pass`, the gate: and every entry used is approved.
  const draftPass =
    problems.length === 0 &&
    !inViewNeeded &&
    unmatched.length === 0 &&
    wrongTarget.length === 0 &&
    wrongPhase.length === 0 &&
    overCount.length === 0;
  return {
    pass: draftPass && proposedUsed.length === 0,
    draftPass,
    ...(inViewNeeded
      ? {
          notEvaluated:
            "the load has thumbnails or figures its entries split by visibility, and no in-view identities were recorded",
        }
      : {}),
    rows: out,
    unmatched,
    wrongTarget,
    wrongPhase,
    overCount,
    proposedUsed,
    byPhase,
    kinds,
    requests: out.length,
    problems,
  };
}

/**
 * One animation frame at 60 Hz. The lab's DOM anchor is observed once per frame (lib/readiness.mjs), so a request that
 * starts within a frame of an anchor cannot be ordered against the state the anchor names: reported, never scored.
 */
export const ANCHOR_FRAME_MS = 1000 / 60;

/**
 * Requests by phase at each readiness anchor of one load (G4 like with like, O213): the candidate's mark and its DOM
 * predicate, a release's DOM predicate. G4 compared each build's byPhase at its own ready source (the candidate's
 * mark, v0.10.0's DOM anchor), so the same three compile reads were `data` on one side and `idle` on the other.
 * `anchors`: {name: {readyMs (rows' clock), inView: identities in view then}}; `shown`: the route's shown set.
 * Returns {name: {byPhase, nearAnchor: [{pattern, phase, deltaMs}], byRequest: {pattern: {phase: n}}}}: `nearAnchor`
 * lists the data and idle reads that start within ANCHOR_FRAME_MS of the anchor, which the frame-resolution observer
 * cannot order (diagnostic); `byRequest` is each request's (method + manifest pattern) reads by phase, which G4
 * compares per request (rubric v2.4 item 2).
 */
export function anchorPhases({ rows, shown = {}, anchors = {}, frameMs = ANCHOR_FRAME_MS }) {
  const out = {};
  for (const [name, a] of Object.entries(anchors)) {
    if (!a || typeof a.readyMs !== "number") continue;
    const check = checkLoad({ rows, shown, readyMs: a.readyMs, inView: a.inView ?? null });
    const nearAnchor = check.rows
      .filter(
        (r) =>
          (r.phase === "data" || r.phase === "idle") &&
          typeof r.startMs === "number" &&
          Math.abs(r.startMs - a.readyMs) <= frameMs,
      )
      .map((r) => ({ pattern: r.pattern, phase: r.phase, deltaMs: Math.round((r.startMs - a.readyMs) * 10) / 10 }));
    // Per request (rubric v2.4 item 2): each method + manifest pattern's reads by phase at this anchor.
    const byRequest = {};
    for (const r of check.rows) {
      const x = (byRequest[r.pattern] ??= {});
      x[r.phase] = (x[r.phase] ?? 0) + 1;
    }
    out[name] = { byPhase: check.byPhase, nearAnchor, byRequest };
  }
  return out;
}

/** The entries for a surface and state, or []; `manifest.surfaces[surface][state]`. */
export const entriesFor = (manifest, surface, state) => manifest?.surfaces?.[surface]?.[state] ?? [];

/**
 * Manifest entries from measured loads (`--write-manifest`): one per (method, pattern, target, phase), max = the most
 * copies in any one load, phase from guessPhase, and an EMPTY reason, so the written file fails validation until a
 * reviewer gives each entry its reason (rubric §6 manifest decision). `loads`: [{rows, shown, readyMs}].
 */
export function seedEntries(loads) {
  const byKey = new Map();
  for (const load of loads) {
    const counts = new Map();
    for (const r of load.rows) {
      const target = targetOf(r, load.shown),
        phase = guessPhase(r, {
          readyMs: load.readyMs ?? null,
          target,
          inView: load.inView ? new Set(load.inView) : null,
        });
      const pattern = manifestPattern(r),
        key = `${r.method}\u0000${pattern}\u0000${target}\u0000${phase}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!byKey.has(key)) {
        byKey.set(key, {
          method: r.method,
          pattern,
          target,
          phase,
          max: 0,
          reason: "",
          ...(phase === "prefetch" ? { trigger: "", bytes: r.transferBytes ?? 0 } : {}),
          approved: false,
        });
      }
    }
    for (const [key, n] of counts) byKey.get(key).max = Math.max(byKey.get(key).max, n);
  }
  return [...byKey.values()];
}

/**
 * Entries from the 2026-10-30 baseline B (`resource-manifest.json`, archer-baseline-resource-manifest/1): each
 * (page, state, method, pattern, target) group becomes an entry carrying B's verdict and reason, `approved: false`
 * (B is reference data, never a pass bar; an entry is approved by both reviewers and the owner). Rows B judged
 * "should not happen" get no entry, so the same request fails the check. A B "could be deferred" read of a target
 * the page does not show becomes a prefetch entry with B's bytes. `shownOf(page)` gives each page's shown set.
 */
export function entriesFromBaseline(rows, shownOf) {
  const surfaces = {};
  const groups = new Map();
  for (const r of rows) {
    if (r.decision === "should not happen") continue;
    const shown = shownOf(r.page),
      target = targetOf(r, shown),
      pattern = manifestPattern(r);
    const key = `${r.page}\u0000${r.state}\u0000${r.method}\u0000${pattern}\u0000${target}`;
    const g = groups.get(key) ?? { page: r.page, state: r.state, method: r.method, pattern, target, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const decisions = [...new Set(g.rows.map((r) => r.decision))];
    const reasons = [...new Set(g.rows.map((r) => r.reason).filter(Boolean))];
    const type = (g.rows[0].type ?? "").toLowerCase();
    const prefetch =
      g.target === "other" ||
      (/\/api\/thumbnails\//.test(g.rows[0].url) && decisions.includes("could be deferred until used"));
    const phase =
      type === "document"
        ? "document"
        : type === "eventsource"
          ? "stream"
          : type === "script"
            ? "boot"
            : prefetch
              ? "prefetch"
              : "data";
    const bytes = g.rows.reduce((a, r) => a + (r.transferBytes ?? 0), 0);
    const entry = {
      method: g.method,
      pattern: g.pattern,
      target: g.target,
      phase,
      max: g.rows.length,
      reason: `B (2026-10-30) ${decisions.join(" / ")}: ${reasons.join(" | ")}`.slice(0, 400),
      ...(phase === "prefetch" ? { trigger: "B: fetched ahead on page load, not on visibility or intent", bytes } : {}),
      approved: false,
      decision: decisions.join(" / "),
    };
    ((surfaces[g.page] ??= {})[g.state] ??= []).push(entry);
  }
  for (const states of Object.values(surfaces))
    for (const list of Object.values(states))
      list.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.pattern.localeCompare(b.pattern));
  return surfaces;
}

/** Markdown lines for one load's check: verdict counts, then each failing row. */
export function checkLines(key, check) {
  const lines = [
    `- **${key}**: ${check.pass ? "PASS" : check.draftPass ? "PASS if the proposed entries are approved" : "FAIL"} — ${check.requests} requests (${PHASES.map((p) => `${p} ${check.byPhase[p]}`).join(", ")}), ${check.kinds} kinds; unmatched ${check.unmatched.length}, wrong-target ${check.wrongTarget.length}, wrong-phase ${(check.wrongPhase ?? []).length}, over-count ${check.overCount.length}, proposed ${check.proposedUsed.length}${check.notEvaluated ? `; NOT EVALUATED: ${check.notEvaluated}` : ""}`,
  ];
  for (const r of [...check.wrongTarget, ...check.unmatched, ...(check.wrongPhase ?? []), ...check.overCount])
    lines.push(
      `  - ${r.verdict}: \`${r.pattern}\` target ${r.target} phase ${r.phase}${r.entryPhases ? ` (entries: ${r.entryPhases.join(", ")})` : ""} (${[projectOf(r) ? `project:${projectOf(r)}` : null, ...identitiesOf(r)].filter(Boolean).join(", ") || "—"})`,
    );
  for (const p of check.problems) lines.push(`  - manifest: ${p}`);
  return lines;
}

/** The rubric's fixture (§1 matrix): project `awkward`, the sequence, graph and note it measures. */
export const RUBRIC_FIXTURE = {
  project: "awkward",
  diagram: "fixture-seq-full",
  flow: "flow-styled",
  note: "notes/auth.md",
};

/**
 * What each surface shows (§1 matrix), for targetOf. `fixture`: {diagram, flow, note} view ids and note path.
 * The Diagrams gallery shows every view's thumbnail; lists, the projects page and a new draft show no view.
 */
export function shownFor(surface, fixture = RUBRIC_FIXTURE) {
  // Every surface but the projects page is one project's: another project's reads there show nothing (claude-04).
  const project = surface === "projects" || !fixture.project ? {} : { project: fixture.project };
  switch (surface) {
    case "project-diagrams":
      return { ...project, thumbnails: "*" };
    case "diagram":
    case "diagram-edit":
    case "diagram-folder-path":
      return { ...project, views: fixture.diagram ? [fixture.diagram] : [] };
    case "flow-diagram":
      return { ...project, views: fixture.flow ? [fixture.flow] : [] };
    case "note":
    case "note-alias":
      return { ...project, notes: fixture.note ? [fixture.note] : [] };
    default:
      return project;
  }
}

/**
 * The identities in the first view, from the lab's at-route-ready snapshot (lib/readiness.mjs `inView`): note
 * figures by name (`view:<note>#<name>`) and gallery thumbnails by URL. `shown`: the surface's shownFor.
 */
export function inViewIdentities(snapshot, shown = {}) {
  if (!snapshot) return null;
  const ids = new Set();
  const note = shown.notes?.[0];
  for (const name of snapshot.figures ?? []) if (note) ids.add(`view:${note}#${name}`);
  for (const url of snapshot.thumbnails ?? []) for (const id of identitiesOf({ url })) ids.add(id);
  return [...ids];
}
