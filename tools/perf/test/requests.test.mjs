// node --test tools/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  POLL_HEADER,
  SCHEDULED_POLLS,
  classifyRequests,
  invalidates,
  isCommittedEdit,
  pollNameOf,
  pollTagOf,
} from "../lib/requests.mjs";
import { pageBudget } from "../lib/budget.mjs";
import { summariseLoad } from "../lib/report.mjs";

const get = (url, at, over = {}) => ({ url, method: "GET", type: "Fetch", at, status: 200, ...over });
const kinds = (requests, options) => classifyRequests(requests, options).map((c) => c.kind);
const catalog = "http://h/api/browser-projects";

test("classifier: the first copy is first, an identical repeat is a duplicate, whatever the gap", () => {
  assert.deepEqual(kinds([get(catalog, 0), get(catalog, 10), get(catalog, 15_000)]), [
    "first",
    "duplicate",
    "duplicate",
  ]);
  // Another body is another request.
  assert.deepEqual(
    kinds([
      { ...get("http://h/p/a/api/x", 0), method: "POST", body: "a" },
      { ...get("http://h/p/a/api/x", 1), method: "POST", body: "b" },
    ]),
    ["first", "first"],
  );
});

test("classifier: a repeat the debug build tagged as a scheduled poll's tick is a tick; the tag decides, not the interval", () => {
  const tagged = (at, tick) => get(catalog, at, { poll: `project-catalog#${tick}` });
  assert.deepEqual(kinds([get(catalog, 0), tagged(15_000, 1), tagged(30_000, 2)]), ["first", "tick", "tick"]);
  // Untagged at exactly the old interval: a duplicate (the interval is no longer guessed).
  assert.deepEqual(kinds([get(catalog, 0), get(catalog, 15_000)]), ["first", "duplicate"]);
  // The tag must name a known poll that reads this URL: a tag on another URL, an unknown name, or no tick number is no tick.
  assert.deepEqual(
    kinds([
      get("http://h/p/a/api/bootstrap", 0),
      get("http://h/p/a/api/bootstrap", 1000, { poll: "project-catalog#1" }),
    ]),
    ["first", "duplicate"],
  );
  assert.deepEqual(kinds([get(catalog, 0), get(catalog, 1000, { poll: "someone-else#1" })]), ["first", "duplicate"]);
  assert.deepEqual(kinds([get(catalog, 0), get(catalog, 1000, { poll: "project-catalog" })]), ["first", "duplicate"]);
});

test("classifier: one copy of each request per tick (Codex pass-2: `first, tick, tick` for three matching reads)", () => {
  const comments = "http://h/p/a/api/comments?target=a";
  // Three matching reads inside one bell tick: the tick's own read, then the page asking twice.
  assert.deepEqual(
    kinds([
      get(comments, 0),
      get(comments, 60_000, { poll: "notifications#4" }),
      get(comments, 60_010, { poll: "notifications#4" }),
    ]),
    ["first", "tick", "duplicate"],
  );
  // A first copy made by a tick is that tick's ask too.
  assert.deepEqual(
    kinds([get(comments, 0, { poll: "notifications#1" }), get(comments, 5, { poll: "notifications#1" })]),
    ["first", "duplicate"],
  );
  // An untagged read while a tick is pending is not the tick's: provenance is passed, not ambient.
  assert.deepEqual(
    kinds([get(comments, 0), get(comments, 60_000, { poll: "notifications#2" }), get(comments, 60_005)]),
    ["first", "tick", "duplicate"],
  );
});

test("heartbeats are not invalidations: only data-carrying stream messages make a repeat a read again (Codex pass-2)", () => {
  assert.equal(invalidates("heartbeat"), false);
  for (const name of ["comments", "presentation", "inventory", "standing", "reconnect"])
    assert.equal(invalidates(name), true, name);
});

test("classifier: a read again after a person's input or a service event is `again`; an assertion-only step is neither (Codex 5)", () => {
  const view = "http://h/p/a/api/authoring";
  // Codex's repro: two identical GETs 10 ms apart in different harness steps, nothing done in between.
  assert.deepEqual(kinds([get(view, 0, { step: 3 }), get(view, 10, { step: 4 })]), ["first", "duplicate"]);
  // An input (or an event-stream message) between the two copies: a read again.
  assert.deepEqual(kinds([get(view, 0), get(view, 10)], { invalidations: [5] }), ["first", "again"]);
  // An input before the first copy, or after the second, explains neither.
  assert.deepEqual(kinds([get(view, 0), get(view, 10)], { invalidations: [-1, 11] }), ["first", "duplicate"]);
  // Another answer than the last (its ETag changed).
  assert.deepEqual(kinds([get(view, 0, { etag: 'W/"a"' }), get(view, 10, { etag: 'W/"b"' })]), ["first", "again"]);
  assert.deepEqual(kinds([get(view, 0, { etag: 'W/"a"' }), get(view, 10, { etag: 'W/"a"' })]), ["first", "duplicate"]);
});

test("pollTagOf reads the tag from a row, or from its request headers (CDP and Playwright spell them differently)", () => {
  assert.equal(pollTagOf({ poll: "a" }), "a");
  assert.equal(pollTagOf({ headers: { [POLL_HEADER]: "b" } }), "b");
  assert.equal(pollTagOf({ headers: { "X-Archer-Poll": "c" } }), "c");
  assert.equal(pollTagOf({ headers: {} }), null);
  assert.equal(pollNameOf({ poll: "project-catalog#12" }), "project-catalog");
});

test("one classifier: the budget row and the lab report agree on duplicates and ticks", () => {
  const requests = [
    get(catalog, 0),
    get(catalog, 15_000, { poll: "project-catalog#1" }),
    get("http://h/p/a/api/bootstrap", 0),
    get("http://h/p/a/api/bootstrap", 1000),
  ].map((r) => ({ ...r, startMs: r.at, endMs: r.at + 5 }));
  const budget = pageBudget({ key: "k", url: "/x", requests });
  const report = summariseLoad({ requests, page: {}, wallMs: 1 });
  assert.deepEqual([budget.duplicateRequests, budget.pollTicks], [1, 1]);
  assert.equal(report.duplicateRequests, budget.duplicateRequests);
  assert.deepEqual(
    report.duplicates.map((d) => d.request),
    budget.duplicates.map((d) => d.request),
  );
  assert.deepEqual(
    report.polls.map((p) => [p.poll, p.count]),
    [["project-catalog", 1]],
  );
});

test("SCHEDULED_POLLS names exactly the polls ui/src/app/polls.ts schedules", () => {
  const source = readFileSync(new URL("../../../ui/src/app/polls.ts", import.meta.url), "utf8");
  const body = source.match(/POLL_INTERVAL_MS\s*=\s*\{([^}]*)\}/)?.[1] ?? "";
  const names = [...body.matchAll(/"([a-z-]+)"\s*:/g)].map((m) => m[1]).sort();
  assert.deepEqual(SCHEDULED_POLLS.map((p) => p.name).sort(), names);
});

test("isCommittedEdit: only a POST to the authoring edit route (a preview, open or presentation save is not one)", () => {
  assert.equal(isCommittedEdit({ method: "POST", url: "http://h/p/a/api/authoring/edit" }), true);
  assert.equal(isCommittedEdit({ method: "POST", url: "http://h/p/a/api/authoring/edit?x=1" }), true);
  for (const r of [
    { method: "GET", url: "http://h/p/a/api/authoring/edit" },
    { method: "POST", url: "http://h/p/a/api/authoring/preview" },
    { method: "POST", url: "http://h/p/a/api/authoring/editor" },
    { method: "POST", url: "http://h/p/a/api/authoring/presentation" },
  ])
    assert.equal(isCommittedEdit(r), false, `${r.method} ${r.url}`);
});
