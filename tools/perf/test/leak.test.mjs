import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classCounts,
  confirmRetention,
  declaredCachesFrom,
  diffClasses,
  formatPath,
  isArcherRetainer,
  olsSlope,
  ordinalOfId,
  heapGrowthByType,
  parseSnapshot,
  pathSignature,
  retainerPath,
  slopeVerdict,
  tQuantile,
} from "../lib/leak.mjs";

// ---------- statistics ----------

test("t quantiles match the published table", () => {
  for (const [df, q] of [
    [1, 12.7062],
    [2, 4.3027],
    [5, 2.5706],
    [18, 2.1009],
    [30, 2.0423],
    [120, 1.9799],
  ]) {
    assert.ok(Math.abs(tQuantile(0.975, df) - q) < 1e-4, `df ${df}: ${tQuantile(0.975, df)} vs ${q}`);
  }
  assert.ok(Math.abs(tQuantile(0.025, 18) + 2.1009) < 1e-4);
});

test("OLS recovers a known line and its interval", () => {
  const r = olsSlope([
    [1, 3],
    [2, 5],
    [3, 7],
    [4, 9],
  ]);
  assert.equal(r.slope, 2);
  assert.equal(r.intercept, 1);
  assert.deepEqual(r.ci, [2, 2]);
  // Textbook check: x = 1..5, y = 2,4,5,4,5 → slope 0.6, se 0.28284, t(0.975, 3) = 3.18245.
  const s = olsSlope([1, 2, 3, 4, 5].map((x, i) => ({ x, y: [2, 4, 5, 4, 5][i] })));
  assert.ok(Math.abs(s.slope - 0.6) < 1e-12);
  assert.ok(Math.abs(s.se - 0.282843) < 1e-6);
  assert.ok(Math.abs(s.ci[0] - (0.6 - 3.18245 * 0.282843)) < 1e-4);
});

// Deterministic noise in ±0.3 MB around a 40 MB heap.
const noise = (i) => 0.3 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414);
const series = (perLoop) => Array.from({ length: 20 }, (_, i) => [i + 1, 40 + perLoop * (i + 1) + noise(i)]);

test("a flat series passes: CI includes 0, no snapshots", () => {
  const v = slopeVerdict({ candidate: olsSlope(series(0)), release: null });
  assert.equal(v.takeSnapshots, false);
  assert.equal(v.ciExcludesZero, false);
  assert.ok(v.reasons.includes("release slope not given"));
});

test("a series rising 0.5 MB/loop trips the §6 condition", () => {
  const c = olsSlope(series(0.5));
  assert.ok(Math.abs(c.slope - 0.5) < 0.05);
  const v = slopeVerdict({ candidate: c, release: null });
  assert.equal(v.takeSnapshots, true);
  assert.equal(v.ciExcludesZero, true);
});

test("a slope above the release's trips even when the CI includes 0", () => {
  const c = olsSlope(series(0.01));
  assert.ok(c.ci[0] < 0);
  const v = slopeVerdict({ candidate: c, release: 0 });
  assert.equal(v.takeSnapshots, true);
  assert.equal(v.aboveRelease, true);
  assert.equal(slopeVerdict({ candidate: c, release: 1 }).takeSnapshots, false);
});

// ---------- snapshots ----------

const NODE_TYPES = [
  "hidden",
  "array",
  "string",
  "object",
  "code",
  "closure",
  "regexp",
  "number",
  "native",
  "synthetic",
  "concatenated string",
  "sliced string",
  "symbol",
  "bigint",
  "object shape",
];
const EDGE_TYPES = ["context", "element", "property", "internal", "hidden", "shortcut", "weak"];
/** A V8-shaped .heapsnapshot text from [{key, type, name, id, size, detached, edges: [[edgeType, nameOrIndex, toKey]]}]; node 0 is the root. */
function snapshotText(nodes) {
  const strings = [""],
    str = (s) => {
      let i = strings.indexOf(s);
      if (i < 0) {
        strings.push(s);
        i = strings.length - 1;
      }
      return i;
    };
  const at = new Map(nodes.map((n, i) => [n.key, i]));
  const flatNodes = [],
    flatEdges = [];
  for (const n of nodes) {
    flatNodes.push(
      NODE_TYPES.indexOf(n.type),
      str(n.name),
      n.id,
      n.size ?? 16,
      (n.edges ?? []).length,
      0,
      n.detached ? 2 : 0,
    );
    for (const [t, name, to] of n.edges ?? [])
      flatEdges.push(EDGE_TYPES.indexOf(t), t === "element" || t === "hidden" ? name : str(name), at.get(to) * 7);
  }
  const meta = {
    node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
    node_types: [NODE_TYPES, "string", "number", "number", "number", "number", "number"],
    edge_fields: ["type", "name_or_index", "to_node"],
    edge_types: [EDGE_TYPES, "string_or_number", "node"],
  };
  return `{"snapshot":{"meta":${JSON.stringify(meta)},"node_count":${nodes.length},"edge_count":${flatEdges.length / 3},"trace_function_count":0},\n"nodes":[${flatNodes.join(",")}],\n"edges":[${flatEdges.join(",")}],\n"trace_function_infos":[],\n"trace_tree":[],\n"samples":[],\n"locations":[],\n"strings":${JSON.stringify(strings)}}`;
}

/**
 * A page after `loops` loops: a Window with an app global `store` (a Map) and the harness's own global; `leakVia` puts
 * one new Leaky object per loop into `window.__archerSeededLeak` ("global"), the declared cache `routeCache` ("cache"),
 * or a V8-internal list under (GC roots) ("internal").
 */
function page(loops, leakVia) {
  const nodes = [
    {
      key: "root",
      type: "synthetic",
      name: "",
      id: 1,
      edges: [
        ["element", 1, "win"],
        ["element", 2, "gc"],
      ],
    },
    {
      key: "win",
      type: "object",
      name: "Window / http://127.0.0.1",
      id: 3,
      edges: [
        ["property", "store", "store"],
        ["property", "__harnessSeq", "hs"],
        ["property", "__archerSeededLeak", "arr"],
        ["property", "routeCache", "cache"],
        ["property", "document", "doc"],
      ],
    },
    { key: "gc", type: "synthetic", name: "(GC roots)", id: 5, edges: [["element", 1, "internal"]] },
    { key: "store", type: "object", name: "Map", id: 7, edges: [] },
    { key: "hs", type: "number", name: "heap number", id: 9, edges: [] },
    { key: "doc", type: "native", name: "HTMLDocument", id: 11, edges: [["internal", "body", "body"]] },
    { key: "body", type: "native", name: "HTMLBodyElement", id: 13, edges: [] },
    { key: "arr", type: "array", name: "Array", id: 15, edges: [] },
    { key: "cache", type: "object", name: "Object", id: 17, edges: [] },
    { key: "internal", type: "array", name: "(internal list)", id: 19, edges: [] },
  ];
  const holder = { global: "arr", cache: "cache", internal: "internal" }[leakVia];
  for (let i = 0; i < loops; i++) {
    nodes.push({
      key: `leak${i}`,
      type: "object",
      name: "Leaky",
      id: 1001 + 2 * i,
      edges: [["internal", "node", `div${i}`]],
    });
    nodes.push({ key: `div${i}`, type: "native", name: "HTMLDivElement", id: 5001 + 2 * i, detached: true, edges: [] });
    if (holder) nodes.find((n) => n.key === holder).edges.push(["element", i, `leak${i}`]);
  }
  return snapshotText(nodes);
}

test("parseSnapshot reads the V8 layout into typed arrays", () => {
  const s = parseSnapshot(page(2, "global"));
  assert.ok(s.nodes instanceof Float64Array && s.edges instanceof Float64Array);
  assert.equal(s.nodes.length, 14 * 7);
  assert.equal(s.meta.node_fields[0], "type");
  assert.ok(s.strings.includes("__archerSeededLeak"));
});

test("classCounts names detached DOM nodes and counts by constructor", () => {
  const c = classCounts(parseSnapshot(page(3, "global")));
  assert.equal(c.get("Leaky").count, 3);
  assert.equal(c.get("Detached HTMLDivElement").count, 3);
  assert.equal(c.get("Window").count, 1);
});

test("a class growing by 1 per loop is flagged; a constant one is not", () => {
  const a = classCounts(parseSnapshot(page(5, "global"))),
    b = classCounts(parseSnapshot(page(20, "global")));
  const grown = diffClasses(a, b, 15);
  assert.deepEqual(grown.map((g) => g.cls).sort(), ["Detached HTMLDivElement", "Leaky"]);
  assert.equal(grown.find((g) => g.cls === "Leaky").perLoop, 1);
  assert.equal(grown.find((g) => g.cls === "Leaky").newIds.length, 15);
  // 14 new instances over 15 loops is below k = 1 per loop.
  assert.equal(diffClasses(classCounts(parseSnapshot(page(6, "global"))), b, 15).length, 0);
});

test("the retainer path of a seeded leak names the window global, and it is Archer retention", () => {
  const s = parseSnapshot(page(20, "global"));
  const path = retainerPath(s, ordinalOfId(s, 5001 + 2 * 19));
  assert.equal(
    formatPath(path),
    "Window / http://127.0.0.1.__archerSeededLeak[19].node → native Detached HTMLDivElement",
  );
  assert.deepEqual(isArcherRetainer(path), {
    archer: true,
    kind: "app-global",
    via: "__archerSeededLeak",
    declared: null,
  });
  assert.equal(pathSignature(path), "Window.__archerSeededLeak[*].node → native Detached HTMLDivElement");
  const early = parseSnapshot(page(5, "global"));
  const verdict = confirmRetention(s, diffClasses(classCounts(early), classCounts(s), 15), { earlier: early });
  assert.ok(verdict.every((v) => v.confirmed));
});

test("a growing class retained only by a declared cache is not confirmed", () => {
  const caches = declaredCachesFrom({ caches: [{ name: "routeCache", reason: "test: bounded LRU of 50 routes" }] });
  const [a, s] = [parseSnapshot(page(5, "cache")), parseSnapshot(page(20, "cache"))];
  const grown = diffClasses(classCounts(a), classCounts(s), 15);
  assert.equal(grown.length, 2);
  const verdict = confirmRetention(s, grown, { earlier: a, declaredCaches: caches, appGlobals: ["routeCache"] });
  assert.ok(verdict.every((v) => !v.confirmed));
  assert.equal(verdict[0].retainers[0].declared, "routeCache");
  // Without the declaration the same growth is confirmed.
  assert.ok(confirmRetention(s, grown, { earlier: a, appGlobals: ["routeCache"] }).every((v) => v.confirmed));
});

test("growth held only by V8 internals is not Archer retention", () => {
  const [a, s] = [parseSnapshot(page(5, "internal")), parseSnapshot(page(20, "internal"))];
  const verdict = confirmRetention(s, diffClasses(classCounts(a), classCounts(s), 15), { earlier: a });
  assert.equal(verdict.length, 2);
  assert.ok(verdict.every((v) => !v.confirmed && v.growing[0].kind === "internal" && v.retainers.length === 0));
  assert.throws(() => confirmRetention(s, []), /earlier snapshot/);
});

test("harness globals are not Archer; closures and the attached document are", () => {
  const p = (edge, rest = []) => [
    { edge: "1", edgeType: "element", type: "object", name: "Window / x" },
    { edge, edgeType: "property", type: "object", name: "Object" },
    ...rest,
  ];
  assert.equal(isArcherRetainer(p("__harnessSeq")).kind, "harness");
  assert.equal(isArcherRetainer(p("someLibGlobal")).kind, "internal");
  assert.equal(isArcherRetainer(p("someLibGlobal"), { appGlobals: ["someLibGlobal"] }).kind, "app-global");
  assert.equal(
    isArcherRetainer(p("x", [{ edge: "fn", edgeType: "property", type: "closure", name: "onRoute" }])).kind,
    "closure",
  );
  assert.equal(
    isArcherRetainer(p("document", [{ edge: "body", edgeType: "internal", type: "native", name: "HTMLDocument" }]))
      .kind,
    "dom",
  );
  assert.equal(isArcherRetainer(null).kind, "unreachable");
});

test("V8 metadata and the document's non-DOM natives are not Archer retention", () => {
  const win = { edge: "(global)", edgeType: "root", type: "object", name: "Window / x" };
  const doc = { edge: "document", edgeType: "property", type: "native", name: "HTMLDocument" };
  const jit = [
    win,
    doc,
    { edge: "__reactProps$x", edgeType: "property", type: "object", name: "Object" },
    { edge: "onClick", edgeType: "property", type: "closure", name: "" },
    { edge: "map", edgeType: "internal", type: "hidden", name: "system / Map" },
    { edge: "dependent_code", edgeType: "internal", type: "native", name: "system / WeakArrayList" },
  ];
  assert.equal(isArcherRetainer(jit).kind, "engine");
  const media = [
    win,
    doc,
    { edge: "28", edgeType: "element", type: "native", name: "blink::StyleEngine" },
    { edge: "12", edgeType: "element", type: "native", name: "blink::MediaQuerySet" },
  ];
  assert.equal(isArcherRetainer(media).archer, false);
  const tree = [
    win,
    doc,
    { edge: "1", edgeType: "element", type: "native", name: "HTMLBodyElement" },
    { edge: "2", edgeType: "element", type: "native", name: '<div class="toast">' },
  ];
  assert.equal(isArcherRetainer(tree).kind, "dom");
});

test("a repeated closure-context cycle folds into one signature", () => {
  const step = (edge, edgeType, type, name) => ({ edge, edgeType, type, name });
  const chain = (k) => [
    step("(global)", "root", "object", "Window / x"),
    step("onBlur", "property", "closure", "onQueryEnd"),
    ...Array.from({ length: k }, () => [
      step("context", "internal", "object", "system / Context"),
      step("yo", "context", "closure", ""),
      step("context", "internal", "object", "system / Context"),
      step("Kr", "context", "closure", ""),
    ]).flat(),
    step("from", "property", "native", 'Detached <button class="x">'),
  ];
  assert.equal(pathSignature(chain(2)), pathSignature(chain(7)));
  assert.match(pathSignature(chain(2)), /\(\.context\.yo\.context\.Kr\)\+\.from → native Detached <button>$/);
});

test("the declared-cache file parses and every entry has a reason", () => {
  const json = JSON.parse(
    readFileSync(fileURLToPath(new URL("../leak-declared-caches.json", import.meta.url)), "utf8"),
  );
  assert.doesNotThrow(() => declaredCachesFrom(json));
  assert.throws(() => declaredCachesFrom({ caches: [{ name: "x" }] }), /reason/);
});

// ---------- O73: confirm by a growing retainer signature; harness-held instances left out ----------

/**
 * A page where the class `Object` grows only in the harness's `__perfLab.shifts` list (`harness` new per loop), while
 * Archer's current render (a closure's context) holds `live` Objects that are replaced every loop: churn, new ids each
 * time, the same count. `leak`: Archer also keeps one more Object per loop in its context (a real leak).
 */
function churnPage(loops, { harness = 2, live = 3, leak = false } = {}) {
  const nodes = [
    { key: "root", type: "synthetic", name: "", id: 1, edges: [["element", 1, "win"]] },
    {
      key: "win",
      type: "object",
      name: "Window / http://127.0.0.1",
      id: 3,
      edges: [
        ["property", "__perfLab", "lab"],
        ["property", "onRender", "fn"],
      ],
    },
    { key: "lab", type: "object", name: "Object", id: 5, edges: [["property", "shifts", "shifts"]] },
    { key: "shifts", type: "array", name: "Array", id: 7, edges: [] },
    { key: "fn", type: "closure", name: "onRender", id: 9, edges: [["internal", "context", "ctx"]] },
    { key: "ctx", type: "object", name: "system / Context", id: 11, edges: leak ? [["context", "kept", "kept"]] : [] },
    { key: "kept", type: "array", name: "Array", id: 13, edges: [] },
  ];
  const add = (holder, key, id, edgeType = "element") => {
    nodes.push({ key, type: "object", name: "Object", id, edges: [] });
    const h = nodes.find((n) => n.key === holder);
    h.edges.push([edgeType, edgeType === "context" ? `v${h.edges.length}` : h.edges.length, key]);
  };
  for (let i = 0; i < loops * harness; i++) add("shifts", `s${i}`, 10_001 + 2 * i);
  // The live render's objects were allocated in the last loop: new ids every snapshot.
  for (let i = 0; i < live; i++) add("ctx", `live${i}`, 50_001 + 1000 * loops + 2 * i, "context");
  if (leak) for (let i = 0; i < loops; i++) add("kept", `kept${i}`, 90_001 + 2 * i);
  return parseSnapshot(snapshotText(nodes));
}

test("O73: churn in Archer's live render plus harness growth is not confirmed retention", () => {
  const [a, b] = [churnPage(5), churnPage(20)];
  const grown = diffClasses(classCounts(a), classCounts(b), 15);
  assert.deepEqual(
    grown.map((g) => g.cls),
    ["Object"],
  );
  const [row] = confirmRetention(b, grown, { earlier: a });
  assert.equal(row.confirmed, false, JSON.stringify(row.retainers));
  // The growth is reported where it is: the harness's list.
  assert.ok(
    row.growing.some((g) => g.kind === "harness" && g.grown === 30),
    JSON.stringify(row.growing),
  );
});

test("O73: an Archer context that keeps one more instance per loop is confirmed", () => {
  const [a, b] = [churnPage(5, { leak: true }), churnPage(20, { leak: true })];
  const [row] = confirmRetention(b, diffClasses(classCounts(a), classCounts(b), 15), { earlier: a });
  assert.equal(row.confirmed, true);
  const held = row.retainers.find((r) => r.archer);
  assert.equal(held.grown, 15);
  assert.equal(held.signature, "Window.onRender.context.kept[*] → object Object");
});

test("O73: classCounts can leave out instances held only by the harness's globals", () => {
  const b = churnPage(20);
  assert.equal(classCounts(b).get("Object").count, 1 + 40 + 3);
  assert.equal(classCounts(b, { leaveOutHarness: true }).get("Object").count, 3);
  // Only growth outside the harness is left for the diff: none here.
  assert.deepEqual(
    diffClasses(classCounts(churnPage(5), { leaveOutHarness: true }), classCounts(b, { leaveOutHarness: true }), 15),
    [],
  );
});

test("O73: heap growth by node type separates V8 code from the app's objects", () => {
  const withCode = (n) =>
    parseSnapshot(
      snapshotText([
        {
          key: "root",
          type: "synthetic",
          name: "",
          id: 1,
          edges: Array.from({ length: n }, (_, i) => ["element", i, `c${i}`]),
        },
        ...Array.from({ length: n }, (_, i) => ({
          key: `c${i}`,
          type: "code",
          name: "(code)",
          id: 3 + 2 * i,
          size: 1000,
        })),
      ]),
    );
  const g = heapGrowthByType(withCode(5), withCode(20), 15);
  assert.equal(g.code.bytes, 15_000);
  assert.equal(g.code.perLoop, 1000);
  assert.equal(g.object?.bytes ?? 0, 0);
});

/**
 * O187: React's double buffer. A component keeps two fibers; after a commit that skipped it they share one hook list,
 * after two commits that rendered it each holds its own. `copies` is how many hook lists of `hooks` Objects Archer's
 * closure (a state dispatch bound to one fiber) reaches at this snapshot: 1 or 2, whatever the loop count. `leak`: a
 * context that also keeps one more `leak` instance (a class name) per loop.
 */
function doubleBufferPage(loops, { copies = 1, hooks = 40, leak = null } = {}) {
  const nodes = [
    { key: "root", type: "synthetic", name: "", id: 1, edges: [["element", 1, "win"]] },
    {
      key: "win",
      type: "object",
      name: "Window / http://127.0.0.1",
      id: 3,
      edges: [
        ["property", "onTitleSection", "bound"],
        ["property", "onRender", "fn"],
      ],
    },
    { key: "bound", type: "closure", name: "native_bind", id: 5, edges: [["internal", "bound_argument_0", "fiber"]] },
    {
      key: "fiber",
      type: "object",
      name: "Object",
      id: 7,
      edges: [
        ["property", "memoizedState", "h0_0"],
        ["property", "alternate", "alt"],
      ],
    },
    {
      key: "alt",
      type: "object",
      name: "Object",
      id: 9,
      edges: [["property", "memoizedState", copies === 2 ? "h1_0" : "h0_0"]],
    },
    { key: "fn", type: "closure", name: "onRender", id: 11, edges: [["internal", "context", "ctx"]] },
    { key: "ctx", type: "object", name: "system / Context", id: 13, edges: leak ? [["context", "kept", "kept"]] : [] },
    { key: "kept", type: "array", name: "Array", id: 15, edges: [] },
  ];
  // Each hook list was made by the last render(s): new ids every snapshot.
  for (let c = 0; c < copies; c++)
    for (let i = 0; i < hooks; i++) {
      nodes.push({
        key: `h${c}_${i}`,
        type: "object",
        name: "Object",
        id: 100_001 + 10_000 * loops + 1000 * c + 2 * i,
        edges: i + 1 < hooks ? [["property", "next", `h${c}_${i + 1}`]] : [],
      });
    }
  if (leak)
    for (let i = 0; i < loops; i++) {
      nodes.push({ key: `kept${i}`, type: "object", name: leak, id: 900_001 + 2 * i, edges: [] });
      nodes.find((n) => n.key === "kept").edges.push(["element", i, `kept${i}`]);
    }
  return parseSnapshot(snapshotText(nodes));
}
const three = (snaps) => {
  const [a, m, b] = snaps;
  return confirmRetention(b, diffClasses(classCounts(a), classCounts(b), 15), { earlier: a, middle: m, loops: [8, 7] });
};

test("O187: a second hook list at the late snapshot (React's double buffer) is a step, not growth, given a middle snapshot", () => {
  const [a, m, b] = [doubleBufferPage(5), doubleBufferPage(13), doubleBufferPage(20, { copies: 2 })];
  const grown = diffClasses(classCounts(a), classCounts(b), 15);
  assert.deepEqual(
    grown.map((g) => g.cls),
    ["Object"],
  );
  // Two snapshots alone read the 40 new hooks as 2.7 a loop: the O187 FAIL.
  assert.equal(confirmRetention(b, grown, { earlier: a })[0].confirmed, true);
  const [row] = three([a, m, b]);
  assert.equal(row.confirmed, false, JSON.stringify(row));
  // Reported as a step, with the class's counts at loops 5, 13 and 20.
  assert.equal(row.step, true);
  assert.deepEqual(row.counts, [42, 42, 82]);
  assert.deepEqual(row.archerHalves, [0, 40]);
});

test("O187: a step in either half, up or down, confirms nothing, and a steady leak beside it is still confirmed", () => {
  for (const copies of [
    [1, 2, 1],
    [2, 1, 2],
    [2, 2, 1],
    [1, 1, 2],
    [1, 2, 2],
  ]) {
    const at = (leak) => [5, 13, 20].map((loops, i) => doubleBufferPage(loops, { copies: copies[i], leak }));
    for (const row of three(at(null))) assert.equal(row.confirmed, false, `${copies}: ${JSON.stringify(row)}`);
    const rows = three(at("Leaky"));
    assert.deepEqual(
      rows.filter((r) => r.confirmed).map((r) => r.cls),
      ["Leaky"],
      `${copies}: ${JSON.stringify(rows)}`,
    );
    assert.deepEqual(rows.find((r) => r.cls === "Leaky").halves, [8, 7]);
  }
  // The bound, as with two snapshots: in the class of the step, a step down larger than a half's leak hides it.
  const masked = three(
    [5, 13, 20].map((loops, i) => doubleBufferPage(loops, { copies: [2, 2, 1][i], leak: "Object" })),
  );
  assert.equal(masked.find((r) => r.cls === "Object")?.confirmed ?? false, false);
});

test("O187: Archer paths that shuffle between snapshots, the class not growing in both halves, are not growth", () => {
  // As in the runs: the shortest paths to App's hooks and effects move between Archer's closures and React's internals
  // from one snapshot to the next, so Archer signatures gain while the class's count rises and falls back.
  const shuffled = (total, viaA, viaB) =>
    parseSnapshot(
      snapshotText([
        { key: "root", type: "synthetic", name: "", id: 1, edges: [["element", 1, "win"]] },
        {
          key: "win",
          type: "object",
          name: "Window / http://127.0.0.1",
          id: 3,
          edges: [
            ["property", "a", "fa"],
            ["property", "b", "fb"],
            ["internal", "list", "list"],
          ],
        },
        {
          key: "fa",
          type: "closure",
          name: "onA",
          id: 5,
          edges: Array.from({ length: viaA }, (_, i) => ["internal", `x${i}`, `o${i}`]),
        },
        {
          key: "fb",
          type: "closure",
          name: "onB",
          id: 7,
          edges: Array.from({ length: viaB }, (_, i) => ["internal", `y${i}`, `o${viaA + i}`]),
        },
        {
          key: "list",
          type: "array",
          name: "(internal list)",
          id: 9,
          edges: Array.from({ length: total - viaA - viaB }, (_, i) => ["element", i, `o${viaA + viaB + i}`]),
        },
        ...Array.from({ length: total }, (_, i) => ({
          key: `o${i}`,
          type: "object",
          name: "Effect",
          id: 1000 + 10_000 * total + 2 * i,
        })),
      ]),
    );
  const [a, m, b] = [shuffled(60, 10, 0), shuffled(90, 20, 20), shuffled(76, 20, 20)];
  const grown = diffClasses(classCounts(a), classCounts(b), 15);
  assert.equal(confirmRetention(b, grown, { earlier: a })[0].confirmed, true);
  const [row] = three([a, m, b]);
  assert.deepEqual([row.confirmed, row.step, row.halves, row.archerHalves], [false, true, [30, -14], [30, 0]]);
});

test("O187: a class growing steadily outside Archer while an Archer path steps is not confirmed", () => {
  // The late400 run: (object elements) grew ~2.4 a loop in a browser-internal list, and 69 of App's effect deps moved
  // under its bound dispatch once, between loops 5 and 13. Each half alone looks like growth; neither is Archer's.
  const mixed = (internal, viaArcher) =>
    parseSnapshot(
      snapshotText([
        { key: "root", type: "synthetic", name: "", id: 1, edges: [["element", 1, "win"]] },
        {
          key: "win",
          type: "object",
          name: "Window / http://127.0.0.1",
          id: 3,
          edges: [
            ["property", "onTitleSection", "fa"],
            ["internal", "list", "list"],
          ],
        },
        {
          key: "fa",
          type: "closure",
          name: "native_bind",
          id: 5,
          edges: Array.from({ length: viaArcher }, (_, i) => ["internal", `x${i}`, `o${i}`]),
        },
        {
          key: "list",
          type: "array",
          name: "(internal list)",
          id: 9,
          edges: Array.from({ length: internal }, (_, i) => ["element", i, `o${viaArcher + i}`]),
        },
        ...Array.from({ length: internal + viaArcher }, (_, i) => ({
          key: `o${i}`,
          type: "array",
          name: "(object elements)",
          id: 1000 + 10_000 * internal + 2 * i,
        })),
      ]),
    );
  const [a, m, b] = [mixed(68, 0), mixed(132, 0 + 69), mixed(151, 69)];
  assert.equal(confirmRetention(b, diffClasses(classCounts(a), classCounts(b), 15), { earlier: a })[0].confirmed, true);
  const [row] = three([a, m, b]);
  assert.deepEqual([row.confirmed, row.halves, row.archerHalves], [false, [133, 19], [69, 0]]);
});

test("O187: the seeded leak and an Archer context keeping one per loop stay confirmed with a middle snapshot", () => {
  const rows = three([5, 13, 20].map((l) => parseSnapshot(page(l, "global"))));
  assert.ok(rows.length > 0 && rows.every((r) => r.confirmed), JSON.stringify(rows.map((r) => [r.cls, r.confirmed])));
  const [row] = three([5, 13, 20].map((l) => churnPage(l, { leak: true })));
  assert.equal(row.confirmed, true);
  // Churn alone stays unconfirmed.
  assert.equal(three([5, 13, 20].map((l) => churnPage(l)))[0].confirmed, false);
});
