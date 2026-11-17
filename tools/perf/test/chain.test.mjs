// S1 chain depth (tools/perf/lib/chain.mjs): serial, parallel, chained and worker controls, each with the depth a
// reviewer would draw by hand. The live controls in chain-live.test.mjs run the same cases in Chromium.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chainDepth, chainInitiator } from "../lib/chain.mjs";

const O = "http://127.0.0.1:1";
const doc = {
  requestId: "1",
  url: `${O}/page.html`,
  type: "Document",
  startMs: 0,
  endMs: 10,
  initiatorInfo: { type: "other" },
};
// A fetch from the page's inline script: sync (issued while the script ran) or after an await.
const fetchRow = (path, startMs, endMs, { async = false, frameUrl = doc.url } = {}) => ({
  url: `${O}${path}`,
  type: "Fetch",
  startMs,
  endMs,
  initiatorInfo: { type: "script", frameUrl, async, asyncKind: async ? "await" : null },
});

test("parallel: two reads issued in one task are siblings (depth 2)", () => {
  const r = chainDepth([doc, fetchRow("/a", 20, 60), fetchRow("/b", 21, 70)]);
  assert.equal(r.depth, 2);
});

test("serial: a read issued after awaiting another is one deeper (depth 3), and a third makes 4", () => {
  const rows = [
    doc,
    fetchRow("/a", 20, 60),
    fetchRow("/b", 65, 90, { async: true }),
    fetchRow("/c", 95, 120, { async: true }),
  ];
  const r = chainDepth(rows);
  assert.equal(r.depth, 4);
  assert.deepEqual(r.chain, [`${O}/page.html`, `${O}/a`, `${O}/b`, `${O}/c`]);
});

test("parallel after one await: both wait for the same read (depth 3, not 4)", () => {
  const r = chainDepth([
    doc,
    fetchRow("/a", 20, 60),
    fetchRow("/b", 62, 90, { async: true }),
    fetchRow("/c", 63, 95, { async: true }),
  ]);
  assert.equal(r.depth, 3);
});

test("chained scripts: document → script → script → data", () => {
  const s1 = {
    url: `${O}/one.js`,
    type: "Script",
    startMs: 5,
    endMs: 15,
    initiatorInfo: { type: "parser", url: doc.url },
  };
  const s2 = {
    url: `${O}/two.js`,
    type: "Script",
    startMs: 16,
    endMs: 25,
    initiatorInfo: { type: "script", frameUrl: s1.url, async: false },
  };
  const data = fetchRow("/data", 26, 40, { frameUrl: s2.url });
  const r = chainDepth([doc, s1, s2, data]);
  assert.equal(r.depth, 4);
  assert.deepEqual(
    r.chain.map((u) => u.split("/").pop()),
    ["page.html", "one.js", "two.js", "data"],
  );
});

test("worker: the page's script starts the worker script; the worker's read hangs off the worker script", () => {
  const w = {
    url: `${O}/worker.js`,
    type: "Script",
    worker: true,
    startMs: 20,
    endMs: 30,
    initiatorInfo: { type: "script", frameUrl: doc.url, async: false },
  };
  const read = fetchRow("/from-worker", 35, 50, { frameUrl: w.url });
  assert.equal(chainDepth([doc, w, read]).depth, 3);
});

test("an alias redirect adds one level before the document", () => {
  const redirect = { requestId: "1", url: `${O}/alias`, type: "Document", status: 303, startMs: 0, endMs: 3 };
  const page = { ...doc, startMs: 4, endMs: 12 };
  assert.equal(chainDepth([redirect, page, fetchRow("/a", 20, 30)]).depth, 3);
});

test("streams, prefetches and reads after route-ready are off the critical path; a far-off response is not awaited", () => {
  const sse = { url: `${O}/events`, type: "EventSource", startMs: 30, endMs: 30, initiatorInfo: { type: "other" } };
  const thumb = fetchRow("/thumb", 70, 80, { async: true });
  const late = fetchRow("/late", 5000, 5010, { async: true });
  const rows = [doc, fetchRow("/a", 20, 60), sse, thumb, late];
  assert.equal(chainDepth(rows, { readyMs: 100, isPrefetch: (r) => r.url.endsWith("/thumb") }).depth, 2);
  // Without the ready bound the late read counts, but 4.9 s after the last response it waited for nothing.
  assert.equal(chainDepth(rows).depth, 3);
});

test("without async stacks every script read may wait: an upper bound, named as such", () => {
  const rows = [doc, fetchRow("/a", 20, 60), fetchRow("/b", 65, 90)];
  assert.equal(chainDepth(rows).depth, 2);
  const upper = chainDepth(rows, { asyncStacks: false });
  assert.equal(upper.depth, 3);
  assert.match(upper.method, /upper bound/);
});

test("chainInitiator keeps type, parser URL, the top frame with a URL and the async boundary", () => {
  assert.deepEqual(chainInitiator({ type: "parser", url: doc.url }), {
    type: "parser",
    url: doc.url,
    frameUrl: null,
    async: false,
    asyncKind: null,
  });
  const i = chainInitiator({
    type: "script",
    stack: {
      callFrames: [{ url: "", functionName: "x" }, { url: `${O}/one.js` }],
      parent: { description: "await", callFrames: [] },
    },
  });
  const { stackKey: key, ...rest } = i;
  assert.deepEqual(rest, { type: "script", url: null, frameUrl: `${O}/one.js`, async: true, asyncKind: "await" });
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(chainInitiator(undefined), null);
});

// claude-308: the projects page's badge reads (`comment-activity` per project) hang off the catalog's answer as
// siblings, issued from one call site in one continuation. Under host load the second started after the first ended,
// inside the 250 ms gap, and start-after-end chained them: depth 4 in 1 of 3 runs against 3, an S1 FAIL from load.
test("siblings from one call site are never chained, however late the second starts; another call site still is", () => {
  const sib = (path, startMs, endMs, stackKey) => ({
    ...fetchRow(path, startMs, endMs, { async: true }),
    initiatorInfo: { ...fetchRow(path, 0, 0, { async: true }).initiatorInfo, stackKey },
  });
  const catalog = {
    ...fetchRow("/api/browser-projects", 20, 60),
    initiatorInfo: { ...fetchRow("/x", 0, 0).initiatorInfo, stackKey: "catalog" },
  };
  // Unloaded: the three start together. Loaded: each starts after the one before ended.
  const quiet = chainDepth([
    doc,
    catalog,
    sib("/p/a/api/comment-activity", 62, 70, "badge"),
    sib("/p/b/api/comment-activity", 62.3, 72, "badge"),
    sib("/p/c/api/comment-activity", 62.6, 74, "badge"),
  ]);
  const loaded = chainDepth([
    doc,
    catalog,
    sib("/p/a/api/comment-activity", 62, 70, "badge"),
    sib("/p/b/api/comment-activity", 80, 120, "badge"),
    sib("/p/c/api/comment-activity", 130, 170, "badge"),
  ]);
  assert.deepEqual([quiet.depth, loaded.depth], [3, 3]);
  assert.deepEqual(
    loaded.chain.map((u) => u.replace(O, "")),
    ["/page.html", "/api/browser-projects", "/p/a/api/comment-activity"],
  );
  // Without stack keys (rows before claude-308) the old reading stands: the late sibling chains.
  const unkeyed = chainDepth([
    doc,
    catalog,
    fetchRow("/p/a/api/comment-activity", 62, 70, { async: true }),
    fetchRow("/p/b/api/comment-activity", 80, 120, { async: true }),
  ]);
  assert.equal(unkeyed.depth, 4);
  // A read from another call site awaiting a badge read is still one deeper.
  assert.equal(
    chainDepth([
      doc,
      catalog,
      sib("/p/a/api/comment-activity", 62, 70, "badge"),
      sib("/p/a/api/compile", 75, 90, "compile"),
    ]).depth,
    4,
  );
});

test("stackKey: one key per call site and continuation, from the frames' positions and the async boundaries", async () => {
  const { stackKey } = await import("../lib/chain.mjs");
  const frame = (line, column) => ({ functionName: "f", url: `${O}/app.js`, lineNumber: line, columnNumber: column });
  const stack = (col, parentCol = 4903) => ({
    callFrames: [frame(48, col)],
    parent: { description: "await", callFrames: [frame(50, parentCol)] },
  });
  assert.equal(stackKey(stack(43477)), stackKey(stack(43477)));
  assert.notEqual(stackKey(stack(43477)), stackKey(stack(43478)));
  assert.notEqual(stackKey(stack(43477)), stackKey(stack(43477, 4904)));
  assert.notEqual(
    stackKey(stack(43477)),
    stackKey({ ...stack(43477), parent: { ...stack(43477).parent, description: "Promise.then" } }),
  );
  assert.equal(chainInitiator({ type: "script", stack: stack(1) }).stackKey, stackKey(stack(1)));
});
