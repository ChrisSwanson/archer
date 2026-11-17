// Route-ready (performance rubric S7) and complete rows. The window (§1) runs from navigation to route-ready plus
// 1.5 s without network activity; a row that never got there — a timeout, an empty page, a wrong route, no app
// start — is incomplete and its cell NOT EVALUATED (§3 verdicts), never a quiet "pass".
//
// Route-ready by surface (§3 S7): diagrams have the model, layout, nodes, edges and a settled camera; lists are
// rendered; notes have their body and figures. The graph canvas marks `archer:interactive`
// (ui/src/diagrams/DiagramCanvas.tsx); since 0.11.0 the sequence canvas, the lists and the note reader mark
// `archer:route-ready` (ui/src/diagrams/route-ready.ts, detail.kind sequence | list | note). A build without the
// marks (an earlier release) is read by DOM predicates that observe the same states; each row records which it used
// (`readySource`: "mark" or "dom"). A build that carries the mark (its scripts name `archer:route-ready`) is read
// only by the mark: the DOM predicates fire a frame or more before a list's mark (rows show before the page's own
// listings answer), so taking whichever came first would time the earlier, weaker state.

/** Which readiness rule a surface uses. */
export const READY_KIND = {
  projects: "rows",
  "project-folders": "rows",
  "project-diagrams": "cards",
  "project-notes": "notes-table",
  diagram: "sequence",
  "diagram-edit": "sequence",
  "diagram-folder-path": "sequence",
  "flow-diagram": "graph",
  "new-diagram": "graph",
  note: "note",
  "note-alias": "note",
};

/**
 * The in-page watcher (an init script, one per surface kind): checks once per animation frame until the route is
 * ready, then records `window.__perfReady = {at, source, domElements, kind, inView}` (at: ms since navigation start,
 * domElements: elements at that moment, for the DOM-shape ratchet "at route-ready"; inView: the note figures and
 * gallery thumbnails in the viewport then, for G1's split entries). Gives up after 60 s.
 * A sequence canvas counts as settled when its drawing has not changed size for 2 frames.
 *
 * Two more records, for S7 and for comparing releases like with like (claude-01, codex-02):
 * - `window.__perfAtMark`: taken synchronously inside the page's own `performance.mark("archer:route-ready" |
 *   "archer:interactive")` call (the lab wraps `performance.mark`; one snapshot per mark name and kind), so it is the
 *   state AT the mark, not a frame or an observer delivery later: elements, the in-view identities and every note
 *   figure's box and `data-state`. The row's route-ready mark's snapshot gives its `domElements` and `inView`.
 * - `window.__perfReadyDom = {at, domElements, inView, figures}`: the DOM predicate's own point, recorded on every build,
 *   marks or not. A release without the marks is measured only by it, so a candidate with marks is compared with that
 *   release at this anchor (lib/compare.mjs ratchet: DOM elements, requests by phase; lateShiftChanges), not at its
 *   mark. `inView` lets the requests be phased at this anchor too (lib/manifest.mjs anchorPhases, O213).
 */
export function readyScript(kind) {
  return `(() => {
  const kind = ${JSON.stringify(kind)};
  const graphMark = () => performance.getEntriesByName("archer:interactive").length > 0;
  const routeMark = (want) => performance.getEntriesByName("archer:route-ready").some((m) => m.detail?.kind === want);
  const ROUTE_KIND = { sequence: "sequence", rows: "list", cards: "list", "notes-table": "list", note: "note" };
  // null while the document is still parsing; then whether the page's scripts carry the route-ready mark.
  let marksBuild = null;
  const hasMarks = () => marksBuild !== null ? marksBuild : document.readyState === "loading" ? null
    : (marksBuild = [...document.scripts].some((s) => s.src === "" && s.text.includes("archer:route-ready")));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; };
  const box = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0 && r.height > 0; };
  const figureName = (f) => { const l = f.getAttribute("aria-label") ?? ""; const i = l.lastIndexOf(", "); return i < 0 ? l : l.slice(0, i); };
  // What the first view holds (G1's split entries): note figures by name (aria-label "<name>, <kind>") and gallery
  // thumbnails by URL, in the viewport now. Lazy images below the fold have their src but are not in view.
  const inView = () => {
    const figures = [...document.querySelectorAll("figure.archer-note-figure")].filter(box).map(figureName);
    const thumbnails = [...document.querySelectorAll("img")].filter((i) => (i.currentSrc || i.src || "").includes("/api/thumbnails/") && box(i)).map((i) => i.currentSrc || i.src);
    return { figures, thumbnails };
  };
  // Every note figure now: name, data-state, whether it is in the viewport and holds a drawing.
  const figureStates = () => [...document.querySelectorAll("figure.archer-note-figure")].map((f) => ({ name: figureName(f), state: f.getAttribute("data-state") ?? f.dataset?.state ?? null, inView: box(f), drawing: typeof f.querySelector === "function" && Boolean(f.querySelector("svg")) }));
  window.__perfFigures = figureStates;
  try {
    const mark = performance.mark;
    if (typeof mark === "function" && !performance.__perfWrapped) {
      performance.__perfWrapped = true;
      performance.mark = function (name, options) {
        const entry = mark.apply(this, arguments);
        try {
          const key = name + ":" + (options?.detail?.kind ?? "");
          if ((name === "archer:route-ready" || name === "archer:interactive") && !(window.__perfAtMarks ??= {})[key])
            window.__perfAtMarks[key] = { name, kind: options?.detail?.kind ?? null, at: performance.now(), domElements: document.getElementsByTagName("*").length, inView: inView(), figures: figureStates() };
        } catch {}
        return entry;
      };
    }
  } catch {}
  // One DOM predicate per caller: the sequence check keeps state between frames.
  const makeCheck = () => {
    let last = null, stable = 0;
    const checks = {
      graph: () => graphMark() ? "mark" : null,
      sequence: () => {
        const c = document.querySelector('[aria-label="Sequence diagram canvas"]');
        const n = c ? c.querySelectorAll("svg g").length : 0;
        if (n === 0) { stable = 0; return null; }
        const box = c.querySelector("svg")?.getBoundingClientRect();
        const sig = n + ":" + (box ? [box.x, box.y, box.width, box.height].map(Math.round).join(",") : "");
        stable = sig === last ? stable + 1 : 0; last = sig;
        return stable >= 2 ? "dom" : null;
      },
      rows: () => document.querySelectorAll("main [role=row]").length >= 2 ? "dom" : null,
      cards: () => document.querySelectorAll("main .archer-diagram-card").length >= 1 ? "dom" : null,
      "notes-table": () => document.querySelectorAll("main .archer-notes-table tbody tr").length >= 1 ? "dom" : null,
      // The note's body, and every figure in view settled: no mermaid fence still shown as code, and each figure
      // host in view holding a figure that is neither waiting nor drawing. The hosts (note-figures.ts) exist before
      // their figures mount, so an empty host is not ready: the old check passed with no figure committed yet.
      // The body is the reader's own \`.archer-note-body\` (ui/src/comments/NoteItem.tsx), shown and holding text:
      // the article around it holds the title and the "Loading the note…" placeholder from the first frame, with
      // the body still hidden and empty, which the old check took as the note (O212: v0.10.0 3 of 3 loads).
      note: () => {
        const body = document.querySelector("main article.primary-note-reader .archer-note-body");
        if (!body || body.hidden || body.closest("[hidden]") || body.textContent.trim().length === 0) return null;
        if ([...body.querySelectorAll("pre > code")].some((c) => /language-mermaid/i.test(c.className) && !c.parentElement.hidden && visible(c.parentElement))) return null;
        const hosts = [...body.querySelectorAll(".archer-note-figure-host")].filter(visible);
        return hosts.every((h) => {
          const f = h.querySelector("figure.archer-note-figure"), st = f?.getAttribute("data-state");
          return f ? (st ? st !== "waiting" && st !== "drawing" : f.querySelectorAll("svg *").length > 0) : false;
        }) ? "dom" : null;
      },
    };
    return checks[kind];
  };
  const check = makeCheck(), domCheck = makeCheck();
  if (!check) return;
  const started = performance.now();
  const tick = () => {
    // The DOM anchor on every build (graph pages have only the mark, the same on both releases).
    if (!window.__perfReadyDom && kind !== "graph") {
      try { if (domCheck()) window.__perfReadyDom = { at: performance.now(), domElements: document.getElementsByTagName("*").length, inView: inView(), figures: figureStates() }; } catch {}
    }
    if (!window.__perfReady) {
      let source = null;
      try {
        const want = ROUTE_KIND[kind];
        source = want !== undefined && routeMark(want) ? "mark" : want !== undefined && hasMarks() !== false ? null : check();
      } catch {}
      if (source) {
        const mark = source !== "mark" ? null : kind === "graph" ? performance.getEntriesByName("archer:interactive")[0]
          : performance.getEntriesByName("archer:route-ready").find((m) => m.detail?.kind === ROUTE_KIND[kind]);
        const atMark = mark ? (window.__perfAtMarks ?? {})[mark.name + ":" + (mark.detail?.kind ?? "")] ?? null : null;
        window.__perfAtMark = atMark;
        window.__perfReady = { at: mark ? mark.startTime : performance.now(), source, kind, domElements: atMark ? atMark.domElements : document.getElementsByTagName("*").length, inView: atMark ? atMark.inView : inView(), ...(atMark ? {} : { figures: figureStates() }) };
      }
    }
    if ((window.__perfReady && (window.__perfReadyDom || kind === "graph")) || performance.now() - started >= 60000) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}

/**
 * S7 for a note (claude-01): the mark must not come before the figures in view are drawn. `atMark`: the snapshot
 * taken inside the mark call ({figures: [{name, state, inView}]}); `settled`: the figures at the end of the window.
 * A figure in view at the mark that is still `waiting` or `drawing` fails; so does a figure in view once the page
 * settled that did not exist at the mark (the reader marked before committing its figures). A figure that ended in
 * an explicit failure state (`failing`, `error`) is settled. Returns reasons ([] = the mark is valid).
 */
export function noteMarkProblems(atMark, settled = []) {
  if (!atMark) return ["no snapshot at the note's route-ready mark"];
  const reasons = [];
  const pending = (atMark.figures ?? []).filter((f) => f.inView && (f.state === "waiting" || f.state === "drawing"));
  if (pending.length)
    reasons.push(
      `note mark before its in-view figures were drawn (${pending.map((f) => `${f.name} ${f.state}`).join(", ")})`,
    );
  const atNames = new Set((atMark.figures ?? []).map((f) => f.name));
  const late = settled.filter((f) => f.inView && !atNames.has(f.name));
  if (late.length) reasons.push(`note mark before its in-view figures existed (${late.map((f) => f.name).join(", ")})`);
  return reasons;
}

/** The address a surface should end on: the canonical path (aliases redirect), ignoring the query the page adds (`draftId`). */
export function routeMatches(expectedPath, finalUrl) {
  let a, b;
  try {
    a = new URL(expectedPath, "http://x");
    b = new URL(finalUrl, "http://x");
  } catch {
    return false;
  }
  if (decodeURIComponent(a.pathname) !== decodeURIComponent(b.pathname)) return false;
  for (const [k, v] of a.searchParams) if (b.searchParams.get(k) !== v) return false;
  return true;
}

/** Fewer elements than this at the end of a load: an empty or error page, not a measured one. */
export const MIN_DOM_ELEMENTS = 50;

/**
 * Whether a measured row is complete. `row`: {timedOut?, noApiRequest?, ready?: {at, source}, finalUrl,
 * domNodes, markProblems?: string[] (noteMarkProblems)}; `expectedPath`: the canonical address. Returns
 * {complete, reasons: string[]}.
 */
export function readinessVerdict(row, expectedPath) {
  const reasons = [...(row.markProblems ?? [])];
  if (row.timedOut) reasons.push("timed out before the window closed");
  if (row.noApiRequest) reasons.push("the app made no API request (did it start?)");
  if (!row.ready || typeof row.ready.at !== "number") reasons.push("route-ready never reached");
  if (expectedPath && row.finalUrl && !routeMatches(expectedPath, row.finalUrl))
    reasons.push(`wrong route: ended on ${new URL(row.finalUrl, "http://x").pathname}`);
  if (typeof row.domNodes === "number" && row.domNodes < MIN_DOM_ELEMENTS)
    reasons.push(`empty page (${row.domNodes} elements)`);
  return { complete: reasons.length === 0, reasons };
}

/** The rubric's sample design (§5, §6): 3 runs per required cell, every profile. */
export const RUBRIC_SAMPLES = 3;

/**
 * Whether a cell (surface × profile × state) has its samples. `verdicts`: one readinessVerdict per attempted run,
 * a failed run included as `{complete: false, failed: true, reasons}` (codex-03: a run that threw left no trace,
 * and the cell was emitted from the runs that succeeded). `required`: the runs asked for; `minimum`: the design's
 * floor (RUBRIC_SAMPLES for a rubric collection), so a 1-run collection cannot stand in for the 3-sample design.
 * Complete only when every attempt is complete, there are `required` of them, and `required` ≥ `minimum`.
 * Returns {complete, reasons, samples: {required, valid, attempted, minimum}}.
 */
export function cellCompleteness({ verdicts = [], required = 1, minimum = 1 }) {
  const valid = verdicts.filter((v) => v.complete).length,
    reasons = [];
  for (const v of verdicts) if (!v.complete) reasons.push(...v.reasons);
  if (verdicts.length < required) reasons.push(`${required - verdicts.length} of ${required} runs left no sample`);
  if (valid < required) reasons.push(`${valid} of ${required} samples valid`);
  if (required < minimum) reasons.push(`${required} run(s) asked for; the design needs ${minimum} per cell`);
  return {
    complete: reasons.length === 0,
    reasons: [...new Set(reasons)],
    samples: { required, valid, attempted: verdicts.length, minimum },
  };
}

/**
 * Runs `runs` samples of a cell and keeps one verdict per state per run, a failed run included. `attempt(run,
 * done)` measures one run and calls `done(state, verdict)` for each state it measured; when it throws, every state it
 * did not finish gets `{complete: false, failed: true}` with the error, and a state it had begun is replaced.
 * `redactText` cleans the error text. Returns {verdicts: {state: [verdict per run]}, note} for cellCompleteness.
 */
export async function runSamples({ runs, states = ["cold", "warm"], attempt, redactText = (t) => t }) {
  const verdicts = Object.fromEntries(states.map((s) => [s, []]));
  let note;
  for (let run = 0; run < runs; run++) {
    const measured = new Set();
    try {
      await attempt(run, (state, verdict) => {
        verdicts[state].length = run;
        verdicts[state].push(verdict);
        measured.add(state);
      });
    } catch (error) {
      note = redactText(String(error?.message ?? error).split("\n")[0]);
      for (const state of states)
        if (!measured.has(state)) {
          verdicts[state].length = Math.min(verdicts[state].length, run);
          verdicts[state].push({ complete: false, failed: true, reasons: [`run ${run} failed: ${note}`] });
        }
    }
  }
  return { verdicts, note };
}
