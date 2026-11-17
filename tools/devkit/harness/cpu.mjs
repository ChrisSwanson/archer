// Split a V8 CPU profile (CDP Profiler.stop) into who spent the main thread's time (TG-B1).
//
//   app      frames from the page's own scripts (URL on the sandbox origin, or any http(s) URL)
//   harness  Playwright's injected code and the harness's own page.evaluate probes: frames with no URL
//            that are not V8's pseudo-frames, and anything marked __playwright / pptr: / utility-world
//   browser  (program) and (garbage collector): rendering, layout and GC outside JS
//   idle     (idle), not counted in busyMs
//
// A sample is charged to the innermost JS frame's kind: forced layout inside a Playwright query
// (getBoundingClientRect, elementFromPoint) is harness time, layout inside a React commit is app time.
// A URL-less frame that is no pseudo-frame (a native DOM call such as getBoundingClientRect, or an anonymous
// evaluate) takes the kind of its nearest ancestor that has a URL; with no such ancestor it is harness, and its
// time is also counted in `unresolvedMs` so the guess stays visible. `resolvedNativeMs` is the URL-less time charged
// through an ancestor. `appMs` is the number to compare across harness runs; `harnessMs` is the cost of observing.

const PSEUDO = /^\((root|program|idle|garbage collector)\)$/;

export function frameKind(frame, origin) {
  const url = frame.url ?? "",
    fn = frame.functionName ?? "";
  if (PSEUDO.test(fn)) return fn === "(idle)" ? "idle" : fn === "(root)" ? "idle" : "browser";
  if (/__playwright|pptr:|^playwright|utility/i.test(url)) return "harness";
  if (origin && url.startsWith(origin)) return "app";
  if (/^https?:/.test(url)) return "app";
  if (url === "" || /^(debugger|extensions)::/.test(url)) return "harness";
  return "app";
}

const where = (f) =>
  `${f.functionName || "(anonymous)"}${f.url ? ` ${f.url.split("/").pop().slice(0, 40)}:${f.lineNumber + 1}` : ""}`;

/** @returns {{busyMs, appMs, harnessMs, browserMs, idleMs, unresolvedMs, resolvedNativeMs, topApp: string[], topHarness: string[]}} */
export function splitProfile(profile, origin) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  if (profile.nodes.some((n) => n.parent !== undefined))
    for (const n of profile.nodes) if (n.parent !== undefined) parent.set(n.id, n.parent);
  const totals = { app: 0, harness: 0, browser: 0, idle: 0 };
  let unresolved = 0,
    resolvedNative = 0;
  const self = { app: new Map(), harness: new Map() };
  // Per node: its kind, and for a URL-less frame the ancestor with a URL it was charged through (null: none).
  const memo = new Map();
  const classify = (node) => {
    if (memo.has(node.id)) return memo.get(node.id);
    const f = node.callFrame,
      own = frameKind(f, origin);
    let out = { kind: own, via: undefined };
    if (own === "harness" && (f.url ?? "") === "") {
      let a = byId.get(parent.get(node.id)),
        seen = 0;
      while (a && (a.callFrame.url ?? "") === "" && seen++ < 10_000) a = byId.get(parent.get(a.id));
      out = a ? { kind: frameKind(a.callFrame, origin), via: a.callFrame } : { kind: "harness", via: null };
    }
    memo.set(node.id, out);
    return out;
  };
  const deltas = profile.timeDeltas ?? [];
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    if (!node) return;
    const d = (deltas[i] ?? 0) / 1000;
    const { kind, via } = classify(node);
    totals[kind] += d;
    if (via === null) unresolved += d;
    else if (via) resolvedNative += d;
    if (kind === "app" || kind === "harness") {
      const key = via ? `${where(node.callFrame)} (in ${where(via)})` : where(node.callFrame);
      self[kind].set(key, (self[kind].get(key) ?? 0) + d);
    }
  });
  const top = (m) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${Math.round(v)}ms ${k}`);
  const r = (v) => Math.round(v * 10) / 10;
  return {
    busyMs: r(totals.app + totals.harness + totals.browser),
    appMs: r(totals.app),
    harnessMs: r(totals.harness),
    browserMs: r(totals.browser),
    idleMs: r(totals.idle),
    unresolvedMs: r(unresolved),
    resolvedNativeMs: r(resolvedNative),
    topApp: top(self.app),
    topHarness: top(self.harness),
  };
}
