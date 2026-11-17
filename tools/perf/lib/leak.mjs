// Pure parts of the leak gate G6 (docs/quality/rubrics/performance.md §3 G6, §5 heap row, §6 "Leak"): the OLS slope of
// heap-after-GC per loop with a 95% t interval, the §6 decision to take snapshots, class counts and their diff from two
// V8 .heapsnapshot files, the shortest retainer path from the GC roots, and whether that path runs into Archer code
// outside a declared bounded cache. No browser here; the journey is tools/devkit/journeys/perf/leak-navigation.mjs.
//
// Snapshot size: parseSnapshot reads the numbers of `nodes` and `edges` straight from the text into Float64Arrays and
// JSON-parses only the `strings` array, so a ~100 MB snapshot costs about its own size plus 8 bytes per number (a
// 100 MB snapshot of ~15 M numbers: ~220 MB of Node heap), not the several GB a whole JSON.parse would need. Above
// MAX_SNAPSHOT_BYTES (512 MB, the V8 string-length limit is close to that) it refuses rather than run out of memory.

/** Snapshots larger than this are refused (the text has to fit one JS string). */
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

/**
 * Per-loop instance growth that counts as "scales with loop count" in a two-snapshot diff: a class must gain at least
 * `K_PER_LOOP` × loopsBetween instances between the snapshots. k = 1 is the smallest whole-instance-per-loop leak; anything
 * smaller cannot be told from one-off allocations (lazy compilation, a cache filling once) with two snapshots.
 */
export const K_PER_LOOP = 1;

/** Node types whose growth is a candidate: things an app allocates. Strings, numbers, code, hidden and synthetic nodes are
 * V8 bookkeeping or payload, followed only as part of a path; so are V8's "system / …" structures, except
 * "system / Context" (a function's scope, which an app's closures keep). */
export const CANDIDATE_TYPES = new Set(["object", "closure", "native", "array", "regexp"]);

// ---------- statistics ----------

/** ln Γ(x), Lanczos (g = 7, n = 9), |error| < 1e-13 for x > 0. */
function lnGamma(x) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf, modified Lentz). */
function betaCf(a, b, x) {
  const tiny = 1e-300;
  let c = 1,
    d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(a, b, x)) / a : 1 - (front * betaCf(b, a, 1 - x)) / b;
}

/** Student t CDF with `df` degrees of freedom. */
export function tCdf(t, df) {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** The p-quantile of Student t (0 < p < 1), by bisection on the CDF to 1e-12. tQuantile(0.975, 18) ≈ 2.100922. */
export function tQuantile(p, df) {
  if (!(p > 0 && p < 1) || !(df > 0)) throw new RangeError(`tQuantile(${p}, ${df}): need 0 < p < 1 and df > 0`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0,
    hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Ordinary least squares y = intercept + slope·x with a two-sided `level` (default 95%) interval for the slope from the
 * t distribution on n − 2 degrees of freedom.
 * @param {Array<{x:number,y:number}|[number,number]>} points
 * @param {{level?: number}} [opts]
 * @returns {{n:number, slope:number|null, intercept:number|null, se:number|null, df:number, t:number|null, ci:[number,number]|null, r2:number|null}}
 */
export function olsSlope(points, { level = 0.95 } = {}) {
  const pts = points
    .map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length,
    df = n - 2;
  if (n < 2) return { n, slope: null, intercept: null, se: null, df, t: null, ci: null, r2: null };
  const mx = pts.reduce((a, p) => a + p.x, 0) / n,
    my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0,
    sxy = 0,
    syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  if (sxx === 0) return { n, slope: null, intercept: null, se: null, df, t: null, ci: null, r2: null };
  const slope = sxy / sxx,
    intercept = my - slope * mx;
  if (df < 1) return { n, slope, intercept, se: null, df, t: null, ci: null, r2: null };
  const sse = Math.max(0, syy - slope * sxy);
  const se = Math.sqrt(sse / df / sxx);
  const t = tQuantile(1 - (1 - level) / 2, df);
  return { n, slope, intercept, se, df, t, ci: [slope - t * se, slope + t * se], r2: syy === 0 ? 1 : 1 - sse / syy };
}

/**
 * §6: "If the slope is above the release's, or its CI excludes 0, take snapshots". `candidate` is an olsSlope result;
 * `release` the last release's slope in the same unit, or null/undefined when no release run was given.
 * @returns {{takeSnapshots:boolean, reasons:string[], releaseGiven:boolean, aboveRelease:boolean|null, ciExcludesZero:boolean|null}}
 */
export function slopeVerdict({ candidate, release }) {
  const releaseGiven = typeof release === "number" && Number.isFinite(release);
  const reasons = [];
  if (!candidate || candidate.slope === null)
    return {
      takeSnapshots: false,
      reasons: ["no slope (fewer than 2 usable samples)"],
      releaseGiven,
      aboveRelease: null,
      ciExcludesZero: null,
    };
  const aboveRelease = releaseGiven ? candidate.slope > release : null;
  const ciExcludesZero = candidate.ci ? candidate.ci[0] > 0 || candidate.ci[1] < 0 : null;
  if (aboveRelease) reasons.push(`slope ${fmt(candidate.slope)} is above the release's ${fmt(release)}`);
  if (ciExcludesZero) reasons.push(`95% CI [${fmt(candidate.ci[0])}, ${fmt(candidate.ci[1])}] excludes 0`);
  if (!releaseGiven) reasons.push("release slope not given");
  if (candidate.ci === null) reasons.push("no CI (fewer than 3 samples)");
  return {
    takeSnapshots: Boolean(aboveRelease || ciExcludesZero),
    reasons,
    releaseGiven,
    aboveRelease,
    ciExcludesZero,
  };
}
const fmt = (v) => (Math.abs(v) < 1e-3 ? v.toExponential(2) : v.toFixed(4));

// ---------- snapshots ----------

/**
 * A parsed V8 heap snapshot: meta, flat `nodes` and `edges` (Float64Array or plain arrays), `strings`.
 * @typedef {{meta:any, nodes:ArrayLike<number>, edges:ArrayLike<number>, strings:string[], _index?:any}} Snapshot
 */

/** Parse the numbers of one top-level JSON array of integers starting at `from` (the index of its "["). */
function numbersAt(text, from) {
  let count = 0,
    i = from + 1;
  const end = text.indexOf("]", from);
  if (end < 0) throw new Error("heap snapshot: unterminated number array");
  for (let j = i; j < end; j++) if (text.charCodeAt(j) === 44) count++;
  const hasAny = /\d/.test(text.slice(i, Math.min(end, i + 64)));
  const out = new Float64Array(hasAny ? count + 1 : 0);
  let k = 0,
    v = 0,
    inNum = false,
    neg = false;
  for (; i < end; i++) {
    const ch = text.charCodeAt(i);
    if (ch >= 48 && ch <= 57) {
      v = v * 10 + (ch - 48);
      inNum = true;
    } else if (ch === 45) neg = true;
    else if (ch === 44) {
      out[k++] = neg ? -v : v;
      v = 0;
      inNum = false;
      neg = false;
    }
  }
  if (inNum) out[k++] = neg ? -v : v;
  return { values: k === out.length ? out : out.subarray(0, k), end };
}

/**
 * Parse a .heapsnapshot (its text, a Buffer, or an already parsed object, as tests build). See the header for memory.
 * @param {string|Buffer|object} input
 * @returns {Snapshot}
 */
export function parseSnapshot(input) {
  if (input && typeof input === "object" && !Buffer.isBuffer(input) && input.snapshot)
    return { meta: input.snapshot.meta, nodes: input.nodes, edges: input.edges, strings: input.strings };
  if (Buffer.isBuffer(input) && input.length > MAX_SNAPSHOT_BYTES)
    throw new Error(`heap snapshot of ${input.length} bytes is over the ${MAX_SNAPSHOT_BYTES}-byte limit`);
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  const key = (name, from) => {
    const i = text.indexOf(`"${name}":`, from);
    if (i < 0) throw new Error(`heap snapshot: no "${name}"`);
    return text.indexOf("[", i);
  };
  const nodesAt = key("nodes", 0);
  // The "snapshot" object (meta) is everything before "nodes".
  const head = text.slice(0, text.lastIndexOf(",", text.lastIndexOf('"nodes"', nodesAt))) + "}";
  const meta = JSON.parse(head).snapshot.meta;
  const nodes = numbersAt(text, nodesAt);
  const edges = numbersAt(text, key("edges", nodes.end));
  const stringsAt = key("strings", edges.end);
  const close = text.lastIndexOf("]");
  return { meta, nodes: nodes.values, edges: edges.values, strings: JSON.parse(text.slice(stringsAt, close + 1)) };
}

/** Field offsets and per-node first-edge indexes, computed once per snapshot. */
function indexOf(s) {
  if (s._index) return s._index;
  const nf = s.meta.node_fields,
    ef = s.meta.edge_fields;
  const N = nf.length,
    E = ef.length;
  const at = (fields, name) => fields.indexOf(name);
  const ix = {
    N,
    E,
    type: at(nf, "type"),
    name: at(nf, "name"),
    id: at(nf, "id"),
    selfSize: at(nf, "self_size"),
    edgeCount: at(nf, "edge_count"),
    detachedness: at(nf, "detachedness"),
    eType: at(ef, "type"),
    eName: at(ef, "name_or_index"),
    eTo: at(ef, "to_node"),
    nodeTypes: s.meta.node_types[at(nf, "type")],
    edgeTypes: s.meta.edge_types[at(ef, "type")],
  };
  const count = s.nodes.length / N;
  const first = new Uint32Array(count + 1);
  for (let n = 0, e = 0; n < count; n++) {
    first[n] = e;
    e += s.nodes[n * N + ix.edgeCount] * E;
  }
  first[count] = s.edges.length;
  ix.count = count;
  ix.firstEdge = first;
  s._index = ix;
  return ix;
}

/** The node at ordinal `n`: its type, name (with "Detached " for a detached DOM node), id and self size. */
export function nodeAt(s, n) {
  const ix = indexOf(s),
    o = n * ix.N;
  const type = ix.nodeTypes[s.nodes[o + ix.type]];
  let name = s.strings[s.nodes[o + ix.name]];
  if (ix.detachedness >= 0 && s.nodes[o + ix.detachedness] === 2 && !name.startsWith("Detached "))
    name = `Detached ${name}`;
  return { ordinal: n, type, name, id: s.nodes[o + ix.id], selfSize: s.nodes[o + ix.selfSize] };
}

/** The class a node counts under: an object or native by its name (constructor / DOM class), a closure by its function
 * name, everything else by its type. */
export function classOf(node) {
  if (node.type === "object" || node.type === "native") return node.name.startsWith("Window /") ? "Window" : node.name;
  if (node.type === "closure") return `(closure) ${node.name || "(anonymous)"}`;
  if (node.type === "array") return `(array) ${node.name}`;
  return `(${node.type})`;
}

/**
 * Instance counts by class.
 * @param {Snapshot|string|Buffer} snapshot
 * @param {{leaveOutHarness?: boolean}} [opts] leaveOutHarness: skip instances held only through a harness global
 *   (heldByHarness): the harness's buffers grow with the steps a journey takes, not with Archer.
 * @returns {Map<string, {count:number, size:number, type:string, ids:number[]}>} ids: node ids (stable across snapshots of one page)
 */
export function classCounts(snapshot, { leaveOutHarness = false } = {}) {
  const s = snapshot.nodes ? snapshot : parseSnapshot(snapshot);
  const ix = indexOf(s),
    out = new Map();
  const harness = leaveOutHarness ? heldByHarness(s) : null;
  for (let n = 0; n < ix.count; n++) {
    if (harness?.[n]) continue;
    const node = nodeAt(s, n),
      cls = classOf(node);
    let row = out.get(cls);
    if (!row) out.set(cls, (row = { count: 0, size: 0, type: node.type, ids: [] }));
    row.count++;
    row.size += node.selfSize;
    row.ids.push(node.id);
  }
  return out;
}

/**
 * Classes whose instance count grows with the loops between two snapshots: gained ≥ k × loopsBetween instances (k =
 * K_PER_LOOP unless given), candidate types only. `newIds`: ids in b that are not in a, the instances to follow.
 * @param {Map} a classCounts of the earlier snapshot
 * @param {Map} b classCounts of the later snapshot
 * @param {number} loopsBetween
 * @param {{k?: number}} [opts]
 * @returns {Array<{cls:string, type:string, before:number, after:number, grown:number, perLoop:number, sizeGrown:number, newIds:number[]}>}
 */
export function diffClasses(a, b, loopsBetween, { k = K_PER_LOOP } = {}) {
  const out = [];
  for (const [cls, row] of b) {
    if (!CANDIDATE_TYPES.has(row.type) || (cls.startsWith("system / ") && cls !== "system / Context")) continue;
    const before = a.get(cls)?.count ?? 0,
      grown = row.count - before;
    if (grown < k * loopsBetween) continue;
    const old = new Set(a.get(cls)?.ids ?? []);
    out.push({
      cls,
      type: row.type,
      before,
      after: row.count,
      grown,
      perLoop: grown / loopsBetween,
      sizeGrown: row.size - (a.get(cls)?.size ?? 0),
      newIds: row.ids.filter((id) => !old.has(id)),
    });
  }
  return out.sort((x, y) => y.grown - x.grown);
}

/** The ordinal of the node with heap id `id`, or -1. */
export function ordinalOfId(snapshot, id) {
  const ix = indexOf(snapshot);
  for (let n = 0; n < ix.count; n++) if (snapshot.nodes[n * ix.N + ix.id] === id) return n;
  return -1;
}

/** A JS global object: the page's window (each world's "Window / <origin>", with V8's [JSGlobalObject] / [JSGlobalProxy]
 * forms) or a worker's global scope. */
export const GLOBAL_NAME =
  /^(Window|DedicatedWorkerGlobalScope|SharedWorkerGlobalScope|ServiceWorkerGlobalScope)( \[JSGlobal(Object|Proxy)\])? \/ /;

/** BFS parents, user roots first, then the GC roots for what they did not reach, as DevTools prefers paths from the
 * window. User roots: the global objects (GLOBAL_NAME) and the root's edges other than "(GC roots)" (current Chrome
 * snapshots hang everything under "(GC roots)", so the globals are found by name). Weak edges are not followed. */
function bfs(s) {
  const ix = indexOf(s);
  const parent = new Int32Array(ix.count).fill(-1),
    via = new Int32Array(ix.count).fill(-1);
  const queue = new Int32Array(ix.count);
  parent[0] = 0;
  const weak = ix.edgeTypes.indexOf("weak");
  const run = (seeds) => {
    let head = 0,
      tail = 0;
    for (const [n, e] of seeds)
      if (parent[n] === -1) {
        parent[n] = 0;
        via[n] = e;
        queue[tail++] = n;
      }
    while (head < tail) {
      const n = queue[head++];
      for (let e = ix.firstEdge[n]; e < ix.firstEdge[n + 1]; e += ix.E) {
        if (s.edges[e + ix.eType] === weak) continue;
        const to = s.edges[e + ix.eTo] / ix.N;
        if (parent[to] !== -1) continue;
        parent[to] = n;
        via[to] = e;
        queue[tail++] = to;
      }
    }
  };
  const globals = [],
    user = [],
    gc = [];
  for (let n = 1; n < ix.count; n++)
    if (GLOBAL_NAME.test(s.strings[s.nodes[n * ix.N + ix.name]])) globals.push([n, -1]);
  for (let e = ix.firstEdge[0]; e < ix.firstEdge[1]; e += ix.E) {
    if (s.edges[e + ix.eType] === weak) continue;
    const to = s.edges[e + ix.eTo] / ix.N;
    (nodeAt(s, to).name === "(GC roots)" ? gc : user).push([to, e]);
  }
  run([...globals, ...user]);
  run(gc);
  return { parent, via };
}
function parents(s) {
  return (s._parents ??= bfs(s));
}

/** Per node ordinal: 1 when the node's shortest retainer path (retainerPath) runs through a harness global
 * (HARNESS_GLOBAL off a global object): the harness's own buffers, such as `__perfLab`'s vitals lists, never Archer's.
 * (The harness's observer closures also reach those lists, so "reachable only through the harness" would miss them.) */
export function heldByHarness(s) {
  if (s._harnessHeld) return s._harnessHeld;
  const ix = indexOf(s),
    { parent, via } = parents(s);
  const property = new Set(["property", "shortcut"].map((t) => ix.edgeTypes.indexOf(t)));
  const mark = new Int8Array(ix.count).fill(-1); // -1 unknown, 0 no, 1 yes
  mark[0] = 0;
  const own = (n) => {
    const p = parent[n],
      e = via[n];
    if (p <= 0 || e < 0 || !property.has(s.edges[e + ix.eType])) return false;
    const pname = s.strings[s.nodes[p * ix.N + ix.name]];
    return (
      (/^Window\b/.test(pname) || GLOBAL_NAME.test(pname)) && HARNESS_GLOBAL.test(s.strings[s.edges[e + ix.eName]])
    );
  };
  const chain = [];
  for (let n = 1; n < ix.count; n++) {
    if (mark[n] !== -1) continue;
    if (parent[n] === -1) {
      mark[n] = 0;
      continue;
    }
    let m = n;
    while (mark[m] === -1 && parent[m] !== -1) {
      chain.push(m);
      if (own(m)) {
        mark[m] = 1;
        chain.pop();
        break;
      }
      m = parent[m];
    }
    const v = mark[m] === 1 ? 1 : 0;
    for (const c of chain) mark[c] = v;
    chain.length = 0;
  }
  return (s._harnessHeld = Uint8Array.from(mark, (v) => (v === 1 ? 1 : 0)));
}

/** An edge's name: its property name, or "[i]" for an element or hidden index. */
function edgeName(s, e) {
  if (e < 0) return { edgeType: "root", edge: "(global)" };
  const ix = indexOf(s),
    type = ix.edgeTypes[s.edges[e + ix.eType]],
    v = s.edges[e + ix.eName];
  return { edgeType: type, edge: type === "element" || type === "hidden" ? `[${v}]` : s.strings[v] };
}

/**
 * Shortest retainer path from the GC roots to node `nodeIndex` (an ordinal), names only: from the root's first child to
 * the node, each step the edge that reaches it and the node's type and name. null when the node is unreachable.
 * @param {Snapshot} snapshot
 * @param {number} nodeIndex
 * @returns {Array<{edge:string, edgeType:string, type:string, name:string}>|null}
 */
export function retainerPath(snapshot, nodeIndex) {
  const { parent, via } = parents(snapshot);
  if (nodeIndex !== 0 && parent[nodeIndex] === -1) return null;
  const steps = [];
  for (let n = nodeIndex; n !== 0; n = parent[n]) {
    const node = nodeAt(snapshot, n);
    steps.push({
      ...edgeName(snapshot, via[n]),
      type: node.type,
      name: node.name.length > 120 ? node.name.slice(0, 120) + "…" : node.name,
    });
    if (steps.length > 10_000) throw new Error("retainer path: cycle in parents");
  }
  return steps.reverse();
}

/** A path as one line: "Window.__archerSeededLeak[0].nodes → Detached HTMLDivElement". */
export function formatPath(path) {
  if (!path) return "(unreachable)";
  return (
    path
      .map((p, i) =>
        i === 0 ? p.name : `${p.edgeType === "element" || p.edgeType === "hidden" ? p.edge : `.${p.edge}`}`,
      )
      .join("") + ` → ${path.at(-1).type} ${path.at(-1).name}`
  );
}

/** A path with indexes and repeats folded, so instances held the same way group together:
 * "Window.__archerSeededLeak[*].root[*]… → native Detached <div>". */
export function pathSignature(path) {
  if (!path) return "(unreachable)";
  const parts = path.map((p, i) =>
    i === 0
      ? p.name.replace(/ \/ .*$/, "")
      : p.edgeType === "element" || p.edgeType === "hidden"
        ? "[*]"
        : `.${p.edge}`,
  );
  const folded = parts.filter((p, i) => i === 0 || p !== parts[i - 1]).join("");
  // A cycle repeated (".context.a.context.b.context.a.context.b") is written once with "+": chains of any length group.
  const cycles = folded.replace(/((?:\.[^.[]+|\[\*\]){1,6}?)\1+/g, "($1)+");
  return `${cycles} → ${path.at(-1).type} ${path.at(-1).name.replace(/^(Detached <\w+).*$/, "$1>")}`;
}

/** Up to `n` ids spread evenly from the oldest to the newest (V8 ids grow with allocation): the newest of a growing class
 * are often the live ones (the current view, a cache's latest entry); the oldest new ones are the likeliest leaked. */
function spread(ids, n) {
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length <= n) return sorted;
  return [...new Set(Array.from({ length: n }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]))];
}

/** Globals of the test harness and Playwright, never Archer code. */
export const HARNESS_GLOBAL = /^(__harness|__playwright|__pw|playwright|__perfLab$|__archerCommitCount$)/;
/** Globals treated as Archer's even when not in the page's list: the `__archer*` family (the product's own debug hooks,
 * and the seeded fault's `__archerSeededLeak`). */
export const ARCHER_GLOBAL = /^__archer/;

/** V8's own metadata edges (hidden classes, JIT code and feedback, template caches): a path through one is the engine
 * keeping its bookkeeping for code the app ran, not the app keeping an object. */
export const ENGINE_EDGE =
  /^(map|back_pointer|dependent_code|code|deoptimization_data|feedback_cell|feedback_vector|feedback_metadata|transition_info|transitions|shared|script|initial_map|prototype_info|native_context|slow_template_instantiations_cache|function_data|descriptors|prototype_validity_cell)$/;
/** A DOM node's name in a snapshot (attached or detached). */
const DOM_NODE = /^(Detached )?(HTML|SVG|MathML|Text$|Comment$|CDATASection|DocumentFragment|ShadowRoot|<)/;

/**
 * Does `path` run into Archer code, and is it through a declared bounded cache?
 *
 * Into Archer code means one of: (1) a property edge off the Window (global) object whose name is a global the app
 * created (`appGlobals`, the names the page has beyond a blank document's, or matching ARCHER_GLOBAL); (2) a JS closure
 * or a "system / Context" (a function's scope) in the page's main world: the production page's only script is Archer's
 * bundle, so a closure there is Archer's, unless the path entered it through a harness global (HARNESS_GLOBAL);
 * (3) the attached document's DOM tree, document to node through DOM nodes only (Archer renders it).
 * Not into Archer code: a path through V8 metadata (ENGINE_EDGE: hidden classes, JIT code, feedback: kind "engine"),
 * one only through browser internals (a "(GC roots)" subtree, the document's own non-DOM natives such as media-query
 * or performance-timeline buffers: "internal"), and the harness's globals ("harness").
 * A declared cache is a node or edge name on the path that is in `declaredCaches` (tools/perf/leak-declared-caches.json).
 * @param {Array<{edge:string, edgeType:string, type:string, name:string}>|null} path
 * @param {{declaredCaches?: Array<{name:string, reason:string}>, appGlobals?: string[]}} [opts]
 * @returns {{archer:boolean, kind:"app-global"|"closure"|"dom"|"harness"|"engine"|"internal"|"unreachable", via:string|null, declared:string|null}}
 */
export function isArcherRetainer(path, { declaredCaches = [], appGlobals = [] } = {}) {
  if (!path || path.length === 0) return { archer: false, kind: "unreachable", via: null, declared: null };
  const declaredNames = new Set(declaredCaches.map((c) => c.name));
  const declared = path.find((p) => declaredNames.has(p.edge) || declaredNames.has(p.name));
  const engine = path.find((p) => p.edgeType === "internal" && ENGINE_EDGE.test(p.edge));
  if (engine) return { archer: false, kind: "engine", via: engine.edge, declared: null };
  const app = new Set(appGlobals);
  const viaGc = path[0].name === "(GC roots)";
  let kind = "internal",
    via = null,
    dom = null;
  for (let i = 0; i < path.length; i++) {
    const p = path[i],
      prev = i > 0 ? path[i - 1] : null;
    const offWindow = prev && /^Window\b/.test(prev.name) && (p.edgeType === "property" || p.edgeType === "shortcut");
    if (offWindow && HARNESS_GLOBAL.test(p.edge)) {
      kind = "harness";
      via = p.edge;
      break;
    }
    if (offWindow && (app.has(p.edge) || ARCHER_GLOBAL.test(p.edge))) {
      kind = "app-global";
      via = p.edge;
      break;
    }
    if (!viaGc && (p.type === "closure" || p.name === "system / Context")) {
      kind = "closure";
      via = p.type === "closure" ? `(closure) ${p.name || "(anonymous)"}` : `context via .${p.edge}`;
      break;
    }
    if (!viaGc && dom === null && p.type === "native" && /^(HTML)?Document\b/.test(p.name)) dom = true;
    else if (dom && !DOM_NODE.test(p.name)) dom = false;
  }
  if (kind === "internal" && dom) {
    kind = "dom";
    via = "the attached document";
  }
  const archer = kind === "app-global" || kind === "closure" || kind === "dom";
  return {
    archer,
    kind,
    via,
    declared: archer && declared ? (declaredNames.has(declared.edge) ? declared.edge : declared.name) : null,
  };
}

/**
 * Load and check the declared bounded caches: every entry needs a name and a reason.
 * @param {{caches?: Array<{name:string, reason:string}>}} json
 */
export function declaredCachesFrom(json) {
  const caches = json?.caches ?? [];
  for (const c of caches)
    if (!c?.name || !c?.reason?.trim())
      throw new Error(`declared cache ${JSON.stringify(c)} needs a name and a reason`);
  return caches;
}

/** The ordinals of every instance of each class in `classes`. */
function instancesOf(s, classes) {
  const ix = indexOf(s),
    out = new Map([...classes].map((c) => [c, []]));
  for (let n = 0; n < ix.count; n++) out.get(classOf(nodeAt(s, n)))?.push(n);
  return out;
}

/**
 * Decide which growing classes are confirmed retention (O73). A class is confirmed when the instances held into Archer
 * code outside a declared cache grow with the loops: per class, every instance in both snapshots is grouped by its
 * retainer signature (pathSignature), and the count change of the Archer signatures (isArcherRetainer, not declared)
 * is summed; confirmed when that sum is ≥ k × the loops between the snapshots. A class that grew elsewhere (the
 * harness's lists, browser internals, V8 metadata) while Archer's live render replaced its own instances (new ids, the
 * same count: churn) is not confirmed, as it was when a sample of new instances decided.
 * @param {Snapshot} later the later snapshot
 * @param {ReturnType<typeof diffClasses>} grown
 * @param {{earlier: Snapshot, middle?: Snapshot, loops?: [number, number], declaredCaches?: any[], appGlobals?: string[], maxClasses?: number, k?: number, top?: number}} opts
 * With `middle` (a snapshot between the two) and `loops` ([loops before it, loops after it]) a class is confirmed only
 * when its instance count and its Archer-held count also grew by ≥ k × loops in each half (O187: the three-snapshot
 * check).
 * @returns per class: confirmed, archerGrowth (the summed change), `growing` (the signatures that grew, most first) and
 *   `retainers` (those of them into Archer code, with an example path); with `middle`: `counts` and `archerCounts` (the
 *   class, and its Archer-held instances, at the three snapshots), `halves` and `archerHalves` (their growth in each),
 *   and `step` (Archer-held growth from first to last that did not hold in both halves)
 */
export function confirmRetention(
  later,
  grown,
  { earlier, middle, loops, declaredCaches = [], appGlobals = [], maxClasses = 200, k = K_PER_LOOP, top = 10 } = {},
) {
  if (!earlier?.nodes)
    throw new Error("confirmRetention needs the earlier snapshot (opts.earlier) to tell growth from churn");
  if (middle && !(Array.isArray(loops) && loops.length === 2 && loops.every((l) => l > 0)))
    throw new Error("confirmRetention with a middle snapshot needs opts.loops: [loops before it, loops after it]");
  const rows = grown.slice(0, maxClasses),
    classes = new Set(rows.map((g) => g.cls));
  const snaps = middle ? [earlier, middle, later] : [earlier, later],
    last = snaps.length - 1;
  const sides = snaps.map((s) => ({ s, inst: instancesOf(s, classes) }));
  return rows.map((g) => {
    const bySig = new Map();
    sides.forEach(({ s, inst }, side) => {
      for (const n of inst.get(g.cls)) {
        const path = retainerPath(s, n),
          signature = pathSignature(path);
        let r = bySig.get(signature);
        if (!r)
          bySig.set(
            signature,
            (r = {
              signature,
              counts: snaps.map(() => 0),
              path: null,
              ...isArcherRetainer(path, { declaredCaches, appGlobals }),
            }),
          );
        r.counts[side]++;
        if (side === last && r.path === null) r.path = formatPath(path);
      }
    });
    const all = [...bySig.values()].map(({ counts, ...r }) => ({
      ...r,
      ...(middle ? { counts } : {}),
      before: counts[0],
      after: counts[last],
      grown: counts[last] - counts[0],
    }));
    const loopsBetween = g.perLoop > 0 ? g.grown / g.perLoop : 0;
    const archer = [...bySig.values()].filter((r) => r.archer && !r.declared);
    const archerGrowth = archer.reduce((a, r) => a + r.counts[last] - r.counts[0], 0);
    const held = loopsBetween > 0 && archerGrowth >= k * loopsBetween;
    // O187, the three-snapshot check: with a middle snapshot, both the class's count and its Archer-held count must
    // grow by k a loop in each half. A one-time step does not. React keeps a component's hooks in one list or two (its
    // fibers share a list after a commit that skipped it), and the shortest path to them moves between Archer's
    // closures and React's internals, so App's 471 hooks and 82 effects (≈557 Objects) come and go, or change holder,
    // between snapshots. Totals, not single paths, are compared: paths shuffle among Archer's closures too.
    const counts = middle ? sides.map(({ inst }) => inst.get(g.cls).length) : undefined;
    const archerCounts = middle ? sides.map((_, side) => archer.reduce((a, r) => a + r.counts[side], 0)) : undefined;
    const halves = counts ? [counts[1] - counts[0], counts[2] - counts[1]] : undefined;
    const archerHalves = counts ? [archerCounts[1] - archerCounts[0], archerCounts[2] - archerCounts[1]] : undefined;
    const steady = !halves || [halves, archerHalves].every((hs) => hs.every((v, h) => v >= k * loops[h]));
    const confirmed = held && steady;
    const growing = all.filter((r) => r.grown > 0).sort((a, b) => b.grown - a.grown);
    return {
      cls: g.cls,
      type: g.type,
      before: g.before,
      after: g.after,
      grown: g.grown,
      perLoop: g.perLoop,
      sizeGrown: g.sizeGrown,
      confirmed,
      archerGrowth,
      ...(counts ? { counts, halves, archerCounts, archerHalves, step: held && !steady } : {}),
      growing: growing.slice(0, top),
      retainers: growing.filter((r) => r.archer).slice(0, top),
    };
  });
}

/**
 * Heap growth between two snapshots by V8 node type (bytes and instances, total and per loop). "code" is V8's own
 * compiled code and its metadata (bytecode, feedback, JIT code): it grows while code warms up and is reported apart
 * from the app's objects, so a main-heap slope can be read as engine or app.
 * @returns {Record<string, {bytes:number, count:number, perLoop:number}>} perLoop: bytes per loop
 */
export function heapGrowthByType(a, b, loopsBetween) {
  const tally = (s) => {
    const ix = indexOf(s),
      m = new Map();
    for (let n = 0; n < ix.count; n++) {
      const t = ix.nodeTypes[s.nodes[n * ix.N + ix.type]],
        r = m.get(t) ?? { bytes: 0, count: 0 };
      r.bytes += s.nodes[n * ix.N + ix.selfSize];
      r.count++;
      m.set(t, r);
    }
    return m;
  };
  const ta = tally(a),
    tb = tally(b),
    out = {};
  for (const t of new Set([...ta.keys(), ...tb.keys()])) {
    const bytes = (tb.get(t)?.bytes ?? 0) - (ta.get(t)?.bytes ?? 0);
    if (bytes === 0 && (tb.get(t)?.count ?? 0) === (ta.get(t)?.count ?? 0)) continue;
    out[t] = {
      bytes,
      count: (tb.get(t)?.count ?? 0) - (ta.get(t)?.count ?? 0),
      perLoop: loopsBetween > 0 ? bytes / loopsBetween : null,
    };
  }
  return out;
}
