// The request manifest (rubric G1): pure checks, with a known passing and a known failing load each.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkLoad,
  entriesFromBaseline,
  identitiesOf,
  inViewIdentities,
  manifestPattern,
  seedEntries,
  shownFor,
  targetOf,
  validateManifest,
} from "../lib/manifest.mjs";

const O = "https://127.0.0.1:4000";
const doc = { method: "GET", type: "Document", url: `${O}/projects/awkward/diagrams/fixture-seq-full.mmd`, startMs: 0 };
const sse = { method: "GET", type: "EventSource", url: `${O}/p/awkward/api/events`, startMs: 5 };
const emphasis = (view, t = 10) => ({
  method: "GET",
  type: "Fetch",
  url: `${O}/p/awkward/api/emphasis/${view}`,
  startMs: t,
});
const worker = { method: "GET", type: "Script", url: `${O}/-/page-assets/elk-layout-worker-CIQ4aXAU.js`, startMs: 3 };
const thumb = (view) => ({
  method: "GET",
  type: "Image",
  url: `${O}/p/awkward/api/thumbnails/${encodeURIComponent(view)}?rev=abc&theme=light&v=1&format=png`,
  startMs: 40,
  transferBytes: 13000,
});
const entry = (r, more = {}) => ({
  method: r.method,
  pattern: manifestPattern(r),
  target: "route",
  phase: "data",
  max: 1,
  reason: "visible content uses it",
  ...more,
});
const shownDiagram = shownFor("diagram");

test("patterns generalise project, view and asset hash but keep the POST op", () => {
  assert.equal(manifestPattern(emphasis("seq-awkward")), "GET /p/:project/api/emphasis/:view");
  assert.equal(manifestPattern(worker), "GET /-/page-assets/elk-layout-worker-:hash.js");
  assert.equal(
    manifestPattern({
      method: "POST",
      url: `${O}/p/a/api/authoring/presentation`,
      body: '{"op":"read","target":{"kind":"view","viewId":"x"}}',
    }),
    "POST /p/:project/api/authoring/presentation op=read",
  );
  assert.equal(
    manifestPattern({ method: "GET", type: "Document", url: `${O}/projects/awkward/?tab=notes` }),
    "GET /projects/:project/?tab=notes",
  );
});

test("identities come from path, query and (even truncated) body", () => {
  assert.deepEqual(identitiesOf(thumb("notes/auth.md#login-flow")), ["view:notes/auth.md#login-flow"]);
  assert.deepEqual(identitiesOf({ method: "GET", url: `${O}/p/a/api/comments?target=view%3Aseq-awkward` }), [
    "view:seq-awkward",
  ]);
  assert.deepEqual(
    identitiesOf({
      method: "POST",
      url: `${O}/p/a/api/authoring/presentation`,
      bodyPrefix: '{"op":"read","target":{"kind":"view","viewId":"seq-awkward"},"expectedTar',
    }),
    ["view:seq-awkward"],
  );
  assert.deepEqual(identitiesOf(sse), []);
});

test("target: the shown view is route, another view is other, nothing named is none", () => {
  assert.equal(targetOf(emphasis("fixture-seq-full"), shownDiagram), "route");
  assert.equal(targetOf(emphasis("seq-awkward"), shownDiagram), "other");
  assert.equal(targetOf(sse, shownDiagram), "none");
  assert.equal(
    targetOf(
      { method: "GET", url: `${O}/p/awkward/api/notes/diagram?address=notes%2Fauth.md%23refresh` },
      shownFor("note"),
    ),
    "route",
  );
  // The gallery shows thumbnails, not views: a per-view read there is about a view it does not show.
  assert.equal(targetOf(thumb("seq-awkward"), shownFor("project-diagrams")), "route");
  assert.equal(targetOf(emphasis("seq-awkward"), shownFor("project-diagrams")), "other");
});

test("PASS: every row matches an approved entry within its max", () => {
  const rows = [doc, worker, sse, emphasis("fixture-seq-full")];
  const entries = [
    entry(doc, { target: "none", phase: "document" }),
    entry(worker, { target: "none", phase: "boot" }),
    entry(sse, { target: "none", phase: "stream" }),
    entry(rows[3]),
  ];
  const c = checkLoad({ rows, entries, shown: shownDiagram });
  assert.equal(c.pass, true);
  assert.deepEqual(c.byPhase, { document: 1, boot: 1, data: 1, stream: 1, prefetch: 0, idle: 0 });
  assert.equal(c.kinds, 4);
});

test("FAIL: a wrong-target read (B's seq-awkward class) fails even though its pattern has an entry", () => {
  const entries = [entry(doc, { target: "none", phase: "document" }), entry(emphasis("fixture-seq-full"))];
  const c = checkLoad({
    rows: [doc, emphasis("fixture-seq-full"), emphasis("seq-awkward", 11)],
    entries,
    shown: shownDiagram,
  });
  assert.equal(c.pass, false);
  assert.equal(c.wrongTarget.length, 1);
  assert.equal(c.wrongTarget[0].url.endsWith("seq-awkward"), true);
});

test("FAIL: an injected duplicate read is over its max; an extra request is unmatched", () => {
  const entries = [entry(doc, { target: "none", phase: "document" }), entry(emphasis("fixture-seq-full"))];
  const dup = checkLoad({
    rows: [doc, emphasis("fixture-seq-full"), emphasis("fixture-seq-full", 12)],
    entries,
    shown: shownDiagram,
  });
  assert.equal(dup.pass, false);
  assert.equal(dup.overCount.length, 1);
  const extra = checkLoad({ rows: [doc, emphasis("fixture-seq-full"), sse], entries, shown: shownDiagram });
  assert.equal(extra.pass, false);
  assert.equal(extra.unmatched.length, 1);
});

test("a read of another target matches only a prefetch entry with trigger and bytes", () => {
  const bad = {
    surfaces: {
      diagram: {
        cold: [
          {
            method: "GET",
            pattern: manifestPattern(thumb("seq-awkward")),
            target: "other",
            phase: "data",
            max: 12,
            reason: "gallery fetch-ahead",
          },
        ],
      },
    },
  };
  assert.match(validateManifest(bad).join("\n"), /matches only a prefetch entry/);
  const good = {
    surfaces: {
      diagram: {
        cold: [
          { ...bad.surfaces.diagram.cold[0], phase: "prefetch", trigger: "idle after route-ready", bytes: 164000 },
        ],
      },
    },
  };
  assert.deepEqual(validateManifest(good), []);
  const c = checkLoad({ rows: [thumb("seq-awkward")], entries: good.surfaces.diagram.cold, shown: shownDiagram });
  assert.equal(c.pass, true);
  assert.equal(c.byPhase.prefetch, 1);
});

test("empty reasons fail validation; --write-manifest seeds empty reasons on purpose", () => {
  const seeded = seedEntries([
    { rows: [doc, emphasis("fixture-seq-full"), emphasis("fixture-seq-full", 20)], shown: shownDiagram },
  ]);
  assert.equal(seeded.find((e) => e.pattern.includes("emphasis")).max, 2);
  const problems = validateManifest({ surfaces: { diagram: { cold: seeded } } });
  assert.equal(problems.filter((p) => /empty reason/.test(p)).length, seeded.length);
});

test("proposed entries: the draft passes, the gate does not until they are approved", () => {
  const entries = [entry(doc, { target: "none", phase: "document", approved: false })];
  assert.equal(checkLoad({ rows: [doc], entries, shown: shownDiagram }).pass, false);
  const c = checkLoad({ rows: [doc], entries, shown: shownDiagram, allowProposed: true });
  assert.equal(c.draftPass, true);
  assert.equal(c.pass, false);
});

test("baseline B seeding drops 'should not happen' rows so they fail the check", () => {
  const rows = [
    { page: "diagram", state: "cold", ...emphasis("fixture-seq-full"), decision: "needed", reason: "model" },
    {
      page: "diagram",
      state: "cold",
      ...emphasis("seq-awkward"),
      decision: "should not happen",
      reason: "presented, not shown",
    },
    {
      page: "diagram",
      state: "cold",
      ...thumb("seq-awkward"),
      decision: "could be deferred until used",
      reason: "speculative",
    },
  ];
  const surfaces = entriesFromBaseline(rows, (p) => shownFor(p));
  assert.equal(surfaces.diagram.cold.length, 2);
  assert.equal(surfaces.diagram.cold.find((e) => e.target === "other").phase, "prefetch");
  const c = checkLoad({ rows, entries: surfaces.diagram.cold, shown: shownDiagram, allowProposed: true });
  assert.equal(c.draftPass, false);
  assert.equal(c.wrongTarget.length, 1);
  assert.equal(
    checkLoad({
      rows: rows.filter((r) => r.decision !== "should not happen"),
      entries: surfaces.diagram.cold,
      shown: shownDiagram,
      allowProposed: true,
    }).draftPass,
    true,
  );
});

// G1 matcher holes from round 1 (claude-04, codex C01): phase, project scope and visibility are measured, not
// inherited from the entry. Each has a known failing and a known passing control (rubric §8).
const at = (r, startMs) => ({ ...r, startMs });
const compile = (project, t = 20) => ({
  method: "GET",
  type: "Fetch",
  url: `${O}/p/${project}/api/compile`,
  startMs: t,
});

test("phase is measured: a read 4.8 s after route-ready does not match a data entry (wrong-phase); before ready it does", () => {
  const read = emphasis("fixture-seq-full");
  const entries = [entry(read)];
  const late = checkLoad({ rows: [at(read, 5000)], entries, shown: shownDiagram, readyMs: 200 });
  assert.equal(late.pass, false);
  assert.equal(late.wrongPhase.length, 1);
  assert.equal(late.rows[0].phase, "idle");
  assert.deepEqual(late.rows[0].entryPhases, ["data"]);
  assert.deepEqual(late.byPhase, { document: 0, boot: 0, data: 0, stream: 0, prefetch: 0, idle: 1 });
  const early = checkLoad({ rows: [at(read, 150)], entries, shown: shownDiagram, readyMs: 200 });
  assert.equal(early.pass, true);
  assert.equal(early.byPhase.data, 1);
  // An idle entry accepts the late read, so a deliberate after-ready read is declarable.
  assert.equal(
    checkLoad({ rows: [at(read, 5000)], entries: [entry(read, { phase: "idle" })], shown: shownDiagram, readyMs: 200 })
      .pass,
    true,
  );
});

test("project scope: another project's read on a single-project page is other (wrong-target); the projects page may read every project", () => {
  const e = {
    method: "GET",
    pattern: "GET /p/:project/api/compile",
    target: "none",
    phase: "data",
    max: 1,
    reason: "compile badges",
  };
  const other = checkLoad({ rows: [compile("seq-demo")], entries: [e], shown: shownDiagram });
  assert.equal(other.pass, false);
  assert.equal(other.wrongTarget.length, 1);
  assert.equal(targetOf(compile("seq-demo"), shownDiagram), "other");
  assert.equal(checkLoad({ rows: [compile("awkward")], entries: [e], shown: shownDiagram }).pass, true);
  const projects = shownFor("projects");
  assert.equal(projects.project, undefined);
  assert.equal(
    checkLoad({ rows: [compile("awkward"), compile("seq-demo", 21)], entries: [{ ...e, max: 3 }], shown: projects })
      .pass,
    true,
  );
  // Global routes (no /p/<slug>/) are not scoped to a project.
  assert.equal(targetOf({ method: "GET", url: `${O}/api/browser-projects` }, shownDiagram), "none");
});

test("every prefetch entry names its trigger and bytes, route targets included", () => {
  const p = {
    method: "GET",
    pattern: manifestPattern(thumb("x")),
    target: "route",
    phase: "prefetch",
    max: 19,
    reason: "below the fold",
  };
  assert.match(
    validateManifest({ surfaces: { "project-diagrams": { cold: [p] } } }).join("\n"),
    /prefetch entry must name its trigger and byte cost/,
  );
  assert.match(
    validateManifest({ surfaces: { "project-diagrams": { cold: [{ ...p, trigger: "  ", bytes: 1 }] } } }).join("\n"),
    /trigger and byte cost/,
  );
  assert.deepEqual(
    validateManifest({
      surfaces: { "project-diagrams": { cold: [{ ...p, trigger: "native lazy-load distance", bytes: 202101 }] } },
    }),
    [],
  );
});

test("split entries: in-view thumbnails match the needed entry, the rest only the prefetch entry; no in-view record is NOT EVALUATED", () => {
  const gallery = shownFor("project-diagrams");
  const views = Array.from({ length: 26 }, (_, i) => `v${i}`);
  const rows = views.map((v, i) => at(thumb(v), 300 + i));
  const pattern = manifestPattern(rows[0]);
  const needed = {
    method: "GET",
    pattern,
    target: "route",
    phase: "data",
    max: 7,
    reason: "the seven cards in the first view",
  };
  const prefetch = {
    method: "GET",
    pattern,
    target: "route",
    phase: "prefetch",
    max: 19,
    reason: "below the fold",
    trigger: "native lazy-load distance",
    bytes: 202101,
  };
  const inView = views.slice(0, 7).map((v) => `view:${v}`);
  const ok = checkLoad({ rows, entries: [needed, prefetch], shown: gallery, readyMs: 250, inView });
  assert.equal(ok.pass, true);
  assert.equal(ok.byPhase.data, 7);
  assert.equal(ok.byPhase.prefetch, 19);
  // An offscreen thumbnail with only a needed entry is wrong-phase, not quietly "shown".
  const noPrefetch = checkLoad({ rows, entries: [{ ...needed, max: 26 }], shown: gallery, readyMs: 250, inView });
  assert.equal(noPrefetch.pass, false);
  assert.equal(noPrefetch.wrongPhase.length, 19);
  // An eighth card in view is over the needed max.
  assert.equal(
    checkLoad({
      rows,
      entries: [needed, prefetch],
      shown: gallery,
      readyMs: 250,
      inView: views.slice(0, 8).map((v) => `view:${v}`),
    }).overCount.length,
    1,
  );
  // Measured without the in-view identities: NOT EVALUATED, never a pass.
  const blind = checkLoad({ rows, entries: [needed, prefetch], shown: gallery, readyMs: 250 });
  assert.equal(blind.pass, false);
  assert.match(blind.notEvaluated, /in-view/);
});

test("split note figures: 3 in view are data, 2 below are prefetch (inViewIdentities from the lab's snapshot)", () => {
  const fig = (name, t) => ({
    method: "GET",
    type: "Fetch",
    url: `${O}/p/awkward/api/notes/diagram?address=${encodeURIComponent(`notes/auth.md#${name}`)}`,
    startMs: t,
  });
  const names = ["login-flow", "login-flow-2", "refresh", "tokens", "broken"];
  const rows = names.map((n, i) => fig(n, 100 + i));
  const pattern = manifestPattern(rows[0]);
  const shown = shownFor("note");
  const inView = inViewIdentities({ figures: names.slice(0, 3), thumbnails: [] }, shown);
  assert.deepEqual(inView, [
    "view:notes/auth.md#login-flow",
    "view:notes/auth.md#login-flow-2",
    "view:notes/auth.md#refresh",
  ]);
  const entries = [
    { method: "GET", pattern, target: "route", phase: "data", max: 3, reason: "figures in view" },
    {
      method: "GET",
      pattern,
      target: "route",
      phase: "prefetch",
      max: 2,
      reason: "next screen",
      trigger: "within one screen of the scroller",
      bytes: 2800,
    },
  ];
  const c = checkLoad({ rows, entries, shown, readyMs: 400, inView });
  assert.equal(c.pass, true);
  assert.deepEqual([c.byPhase.data, c.byPhase.prefetch], [3, 2]);
  // The pre-fix manifest's single max-3 data entry over-counts nothing but leaves two rows wrong-phase.
  assert.equal(checkLoad({ rows, entries: [entries[0]], shown, readyMs: 400, inView }).wrongPhase.length, 2);
});

test("debug stream key: debugPattern matches only on the debug page and shares the one-stream max", () => {
  const debugSse = { ...sse, url: `${sse.url}?page-load=abc123` };
  assert.equal(manifestPattern(debugSse), "GET /p/:project/api/events?page-load");
  const e = {
    method: "GET",
    pattern: "GET /p/:project/api/events",
    debugPattern: "GET /p/:project/api/events?page-load",
    target: "none",
    phase: "stream",
    max: 1,
    reason: "the event stream",
  };
  assert.deepEqual(validateManifest({ surfaces: { diagram: { cold: [e] } } }), []);
  assert.equal(checkLoad({ rows: [debugSse], entries: [e], shown: shownDiagram, variant: "debug" }).pass, true);
  assert.equal(checkLoad({ rows: [debugSse], entries: [e], shown: shownDiagram }).unmatched.length, 1);
  assert.equal(
    checkLoad({ rows: [sse, at(debugSse, 6)], entries: [e], shown: shownDiagram, variant: "debug" }).overCount.length,
    1,
  );
});

test("anchorPhases: one load phased at each anchor; reads within a frame of an anchor are listed (O213)", async () => {
  const { anchorPhases } = await import("../lib/manifest.mjs");
  const O = "https://h";
  const rows = [
    { method: "GET", url: `${O}/projects/`, type: "Document", startMs: 0 },
    { method: "GET", url: `${O}/-/page-assets/app-abcdefgh.js`, type: "Script", startMs: 50 },
    { method: "POST", url: `${O}/p/awkward/api/compile`, type: "Fetch", startMs: 995 },
    { method: "POST", url: `${O}/p/journeys/api/compile`, type: "Fetch", startMs: 996 },
    { method: "POST", url: `${O}/p/pageturner/api/compile`, type: "Fetch", startMs: 1005 },
    { method: "GET", url: `${O}/api/browser-projects`, type: "Fetch", startMs: 400 },
  ];
  const at = anchorPhases({
    rows,
    anchors: { mark: { readyMs: 1000, inView: [] }, dom: { readyMs: 990, inView: [] } },
  });
  assert.deepEqual([at.mark.byPhase.data, at.mark.byPhase.idle], [3, 1]);
  assert.deepEqual([at.dom.byPhase.data, at.dom.byPhase.idle], [1, 3]);
  assert.deepEqual(
    at.mark.nearAnchor.map((r) => r.deltaMs),
    [-5, -4, 5],
  );
  assert.deepEqual(
    at.dom.nearAnchor.map((r) => [r.phase, r.deltaMs]),
    [
      ["idle", 5],
      ["idle", 6],
      ["idle", 15],
    ],
  );
  // An anchor with no time is left out.
  assert.deepEqual(Object.keys(anchorPhases({ rows, anchors: { mark: { readyMs: null } } })), []);
});
