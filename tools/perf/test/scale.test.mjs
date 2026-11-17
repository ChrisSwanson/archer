import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countsOf, inputToPaint, isCatalog, isCommentFetch, judge, markdown } from "../lib/scale.mjs";
import { maxOfRuns, seedBudgets } from "../scale-gates.mjs";

const req = (url, over = {}) => ({ method: "GET", url, type: "Fetch", decodedBytes: 100, ...over });
const counts = (over = {}) => ({
  apiRequests: 8,
  commentFetches: 0,
  catalogBytes: 1000,
  domNodes: 600,
  commits: 9,
  ...over,
});
const run = (pages, over = {}) => ({ views: 25, pages, probe: { contentEncoding: "gzip" }, timings: {}, ...over });
const budgets = JSON.parse(readFileSync(fileURLToPath(new URL("../scale-budgets.json", import.meta.url)), "utf8"));

test("comment fetches are per-target thread reads, not the pending summary or posts", () => {
  assert.ok(isCommentFetch(req("http://h/p/a/api/comments?target=view:x")));
  assert.ok(!isCommentFetch(req("http://h/p/a/api/comments/pending")));
  assert.ok(!isCommentFetch(req("http://h/p/a/api/comments", { method: "POST" })));
});

test("the catalog is the global project list, either spelling", () => {
  assert.ok(isCatalog("http://h/api/browser-projects"));
  assert.ok(isCatalog("http://h/api/projects"));
  assert.ok(!isCatalog("http://h/p/a/api/notes/all"));
});

test("countsOf takes the largest catalog body and skips event streams", () => {
  const c = countsOf({
    requests: [
      req("http://h/api/browser-projects", { decodedBytes: 900 }),
      req("http://h/api/browser-projects", { decodedBytes: 1200 }),
      req("http://h/p/a/api/events", { type: "EventSource" }),
      req("http://h/p/a/api/comments?target=view:a"),
      req("http://h/p/a/api/comments?target=view:b"),
    ],
    domNodes: 50,
    commits: 3,
    apiRequests: 4,
  });
  assert.deepEqual(c, { apiRequests: 4, commentFetches: 2, catalogBytes: 1200, domNodes: 50, commits: 3 });
});

test("a count over its cap fails and names the slice that should tighten it", () => {
  const b = { sizes: { M: { page: { commentFetches: 10 } } }, tighten: { "M/commentFetches": "slice 8" } };
  const verdict = judge({ M: run({ page: counts({ commentFetches: 11 }) }) }, b);
  assert.equal(verdict.failures.length, 1);
  assert.match(
    verdict.failures[0],
    /M\/page commentFetches 11 > 10 \(set to today's value; slice 8 should tighten it\)/,
  );
  assert.deepEqual(judge({ M: run({ page: counts({ commentFetches: 10 }) }) }, b).failures, []);
});

test("an uncompressed first page request fails the probe, gzip and br pass", () => {
  for (const encoding of ["gzip", "br"])
    assert.deepEqual(judge({ S: run({}, { probe: { contentEncoding: encoding } }) }, {}).failures, []);
  const bad = judge({ S: run({}, { probe: { contentEncoding: "identity", bytes: 4200000 } }) }, {});
  assert.match(bad.failures[0], /first page request after the sandbox started came back identity/);
});

test("growth from S to M is a ratio per page, with S floored at 1, and caps are skipped when absent", () => {
  const b = { growth: { apiRequests: 2 } };
  assert.deepEqual(
    judge({ S: run({ p: counts({ apiRequests: 10 }) }), M: run({ p: counts({ apiRequests: 20 }) }) }, b).failures,
    [],
  );
  const over = judge({ S: run({ p: counts({ apiRequests: 10 }) }), M: run({ p: counts({ apiRequests: 21 }) }) }, b);
  assert.match(over.failures[0], /growth S->M p apiRequests: 10 -> 21 is x2\.10 > x2/);
  const zero = judge({ S: run({ p: counts({ apiRequests: 0 }) }), M: run({ p: counts({ apiRequests: 3 }) }) }, b);
  assert.match(zero.failures[0], /x3\.00/);
});

test("timings over their limit only warn", () => {
  const verdict = judge(
    { M: run({}, { timings: { interactiveMs: 9000, clickToPaintMs: 50 } }) },
    { timings: { $comment: "x", interactiveMs: 5000, clickToPaintMs: 200 } },
  );
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /M interactiveMs 9000 ms > 5000 ms/);
});

test("inputToPaint keeps the longest duration per named event and ignores the rest", () => {
  const entries = [
    { name: "pointerdown", duration: 16 },
    { name: "pointerdown", duration: 48 },
    { name: "mouseover", duration: 400 },
    { name: "click", duration: 32 },
  ];
  assert.deepEqual(inputToPaint(entries, ["pointerdown", "pointerup", "click"]), { pointerdown: 48, click: 32 });
});

test("the checked-in budgets: every S and M page has every capped field, the loose ones are named, and nothing is over its own seed", () => {
  for (const size of ["S", "M"])
    for (const page of ["project-folders", "project-notes", "diagram"]) {
      for (const field of ["apiRequests", "commentFetches", "catalogBytes", "domNodes", "commits"])
        assert.equal(typeof budgets.sizes[size][page][field], "number", `${size}/${page}/${field}`);
    }
  for (const field of ["apiRequests", "commentFetches", "catalogBytes", "domNodes"])
    assert.equal(typeof budgets.tighten[`M/${field}`], "string", `M/${field} needs a slice`);
  const pages = Object.fromEntries(Object.keys(budgets.sizes.M).map((p) => [p, budgets.sizes.M[p]]));
  assert.deepEqual(judge({ M: run(pages) }, budgets).failures, []);
});

test("seedBudgets adds max(v + 5, 10%) head-room and leaves L unseeded", () => {
  const seeded = seedBudgets(
    { S: run({ p: counts({ apiRequests: 8, domNodes: 1000, commentFetches: 0 }) }), L: run({ p: counts() }) },
    { growth: { apiRequests: 2 } },
  );
  assert.deepEqual(seeded.sizes.S.p, {
    apiRequests: 13,
    commentFetches: 5,
    catalogBytes: 1100,
    domNodes: 1100,
    commits: 14,
  });
  assert.equal(seeded.sizes.L, undefined);
  assert.deepEqual(seeded.growth, { apiRequests: 2 });
});

test("the report table lists every size and page", () => {
  const text = markdown({ S: run({ a: counts() }) }, { failures: ["x over"], warnings: [], notes: [] });
  assert.match(text, /\| S \| a \| 8 \| 0 \| 1000 \| 600 \| 9 \|/);
  assert.match(text, /- FAIL x over/);
});

test("a known-red note on a size (a corpus the service cannot attach yet) is a warning, not a failure", () => {
  const verdict = judge(
    { L: run({ p: counts() }, { knownRed: ["L: the 257-view project is refused at attach"] }) },
    {},
  );
  assert.deepEqual(verdict.failures, []);
  assert.match(verdict.warnings[0], /refused at attach/);
});

test("maxOfRuns keeps the highest count of each field across runs", () => {
  const best = maxOfRuns([
    run({ p: counts({ apiRequests: 8, domNodes: 600 }) }),
    run({ p: counts({ apiRequests: 11, domNodes: 590 }) }),
    run({ p: counts({ apiRequests: 9, domNodes: 640 }) }),
  ]);
  assert.equal(best.pages.p.apiRequests, 11);
  assert.equal(best.pages.p.domNodes, 640);
});
