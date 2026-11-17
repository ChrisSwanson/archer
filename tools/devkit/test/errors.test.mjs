// node --test tools/devkit/test/errors.test.mjs
// The error census (harness/errors.mjs, rubric §5 "Unseeded errors") over fake Playwright events, the message every
// failure and warning keeps (PC-18), and the census's row in the §5 report. The browser-backed proofs are
// flows/demo/prove-collectors.mjs "errors".
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CAUSES, errorCensus, expectation, issueMessage } from "../harness/errors.mjs";
import { errorsDigest, issueDigest } from "../journeys/flows/run.mjs";
import { buildReport, mergeRuns } from "../../quality/flow-report.mjs";

class FakePage extends EventEmitter {
  constructor(context) {
    super();
    this._context = context;
    this.frame = { page: () => this };
  }
  context() {
    return this._context;
  }
}
class FakeContext extends EventEmitter {
  constructor() {
    super();
    this._pages = [];
    this.binding = null;
  }
  pages() {
    return this._pages;
  }
  newPage() {
    const p = new FakePage(this);
    this._pages.push(p);
    this.emit("page", p);
    return p;
  }
  async exposeBinding(name, fn) {
    this.binding = fn;
  }
  async addInitScript() {}
  request(page, url, { method = "GET" } = {}) {
    return { url: () => url, method: () => method, frame: () => page.frame, failure: () => this._failure ?? null };
  }
  respond(page, url, status, opts) {
    const r = this.request(page, url, opts);
    this.emit("response", { request: () => r, status: () => status, url: () => url });
    return r;
  }
  fail(page, url, errorText, r = this.request(page, url)) {
    r.failure = () => ({ errorText });
    this.emit("requestfailed", r);
    return r;
  }
  alert(page, text, kind = "alert", el) {
    return this.binding({ page }, { kind, text, ...(el ? { el } : {}) });
  }
}
const setup = (stepTitle = () => "s", now = () => 0) => {
  const census = errorCensus({ stepTitle, now });
  const ctx = new FakeContext();
  return {
    census,
    ctx,
    ready: census.watch(ctx).then(() => {
      const page = ctx.newPage();
      census.name(page, 0);
      return page;
    }),
  };
};

test("PC-18: a failure or warning keeps its message, whichever field holds it", () => {
  assert.equal(issueMessage({ message: "said" }), "said");
  assert.equal(issueMessage({ error: "Timeout 5000ms exceeded\n  at locator.click" }), "Timeout 5000ms exceeded");
  assert.equal(issueMessage({ code: "vitals", details: "LCP 3200 ms over 2500" }), "LCP 3200 ms over 2500");
  assert.equal(
    issueMessage({
      details: [
        { code: "overlap", message: "a covers b" },
        { code: "focus", message: "lost" },
      ],
    }),
    "overlap: a covers b; focus: lost",
  );
  assert.equal(issueMessage({ details: { reason: "no answer" } }), "no answer");
  assert.match(issueMessage({ details: { ms: 12 } }), /"ms":12/);
  assert.notEqual(issueMessage({ code: "x" }), "");
  const d = issueDigest({ step: "open", code: "service-log", details: "WARN refused edit" });
  assert.equal(d.message, "WARN refused edit");
  assert.equal(d.step, "open");
});

test("every kind of error is recorded; what the harness itself does is not", async () => {
  const { census, ctx, ready } = setup();
  const page = await ready;
  ctx.respond(page, "http://h/api/x?token=abcdefghijklmnopqrstuvwxyz0123", 500);
  ctx.respond(page, "http://h/api/ok", 200);
  ctx.respond(page, "http://h/-/debug/state", 404); // the harness's own debug traffic
  ctx.fail(page, "http://h/api/y", "net::ERR_CONNECTION_RESET");
  ctx.fail(page, "http://h/api/z", "net::ERR_ABORTED"); // a navigation or abort the page chose
  page.emit("console", { type: () => "error", text: () => "boom" });
  page.emit("console", { type: () => "error", text: () => "Failed to load resource: the server responded with 500" }); // the http event already counts it
  page.emit("console", { type: () => "warning", text: () => "meh" });
  page.emit("pageerror", new Error("undefined is not a function"));
  await ctx.alert(page, "Could not save");
  await ctx.alert(page, "Something failed", "notice");
  census.refusals([{ code: "stale-revision", op: "write" }]);
  const s = census.summary({ failures: [] });
  assert.equal(s.schema, "archer-errors/1");
  assert.equal(s.unseeded, 7);
  assert.deepEqual(s.unseededByKind, { alert: 1, notice: 1, http: 1, failed: 1, console: 1, pageerror: 1, refusal: 1 });
  const http = s.unseededEvents.find((e) => e.kind === "http");
  assert.equal(http.status, 500);
  assert.equal(http.url, "http://h/api/x?token=…"); // never a credential in the record
  assert.equal(http.tab, "t0");
});

test("a step's declaration absorbs what it deliberately causes, only that, and not after the next step starts", async () => {
  let now = 0,
    step = "submit the stale edit";
  const { census, ctx, ready } = setup(
    () => step,
    () => now,
  );
  const page = await ready;
  await census.declared(
    [
      { kind: "http", status: 409 },
      { kind: "alert", text: /not saved/ },
    ],
    async () => {
      ctx.respond(page, "http://h/api/write", 409);
      await ctx.alert(page, "Your edit was not saved");
      ctx.respond(page, "http://h/api/other", 500); // not declared
    },
  );
  census.refusals([{ code: "stale-revision", op: "write" }], ["refusal"]); // after the step, from the service log
  await census.declared(["pageerror"], async () => {}, "declared, nothing came");
  step = "next";
  census.stepStarted();
  now += 10;
  ctx.respond(page, "http://h/api/write", 409); // the next step's: no longer absorbed
  const s = census.summary();
  assert.equal(s.expected, 3);
  assert.deepEqual(
    s.unseededEvents.map((e) => [e.step, e.kind, e.status]),
    [
      ["submit the stale edit", "http", 500],
      ["next", "http", 409],
    ],
  );
  assert.deepEqual(s.unusedDeclarations, ["step: declared, nothing came"]);
  assert.throws(() => expectation("nonsense"), /unknown kind/);
});

test("a seeded condition makes its errors expected while it lasts and a grace after; a dropped answer is seeded", async () => {
  let now = 0;
  const { census, ctx, ready } = setup(
    () => "offline",
    () => now,
  );
  const page = await ready;
  const close = census.condition("browser offline", ["failed", "alert"]);
  ctx.fail(page, "http://h/api/a", "net::ERR_INTERNET_DISCONNECTED");
  await ctx.alert(page, "You are offline");
  close();
  now += 2000;
  ctx.fail(page, "http://h/api/b", "net::ERR_INTERNET_DISCONNECTED"); // inside the grace
  now += 10_000;
  ctx.fail(page, "http://h/api/c", "net::ERR_INTERNET_DISCONNECTED"); // long after: unseeded
  const r = ctx.request(page, "http://h/api/commit", { method: "POST" });
  census.dropped(r);
  ctx.fail(page, null, "net::ERR_CONNECTION_RESET", r);
  const s = census.summary();
  assert.equal(s.unseeded, 1);
  assert.equal(s.unseededEvents[0].url, "http://h/api/c");
  assert.equal(s.expected, 4);
  assert.deepEqual(s.unusedDeclarations, []); // a condition is not a step's declaration
});

test("a condition absorbs only what it causes: a stale alert or a 404 inside its window still counts (O157)", async () => {
  let now = 0;
  const { census, ctx, ready } = setup(
    () => "back online",
    () => now,
  );
  const page = await ready;
  const close = census.condition("browser offline", CAUSES["browser offline"]);
  ctx.fail(page, "http://h/api/a", "net::ERR_INTERNET_DISCONNECTED");
  await ctx.alert(page, "Could not add the comment: Waiting for Archer to reconnect.");
  page.emit("console", {
    type: () => "error",
    text: () => "[archer] reading comments failed TypeError: Failed to fetch",
  });
  close();
  now += 1000;
  await ctx.alert(page, "This diagram's file is no longer at this address."); // a page bug inside the grace
  ctx.respond(page, "http://h/p/x/api/authoring/open", 404); // offline answers nothing: a 404 is not its doing
  page.emit("pageerror", new Error("boom"));
  const restart = census.condition("service restarting", CAUSES["service restarting"]);
  ctx.respond(page, "http://h/p/x/api/connection", 503);
  ctx.respond(page, "http://h/p/x/api/connection", 500); // a 500 is the service failing, not restarting
  restart();
  const s = census.summary();
  assert.deepEqual(
    s.unseededEvents.map((e) => [e.kind, e.status ?? e.text.slice(0, 30)]),
    [
      ["alert", "This diagram's file is no long"],
      ["http", 404],
      ["pageerror", "boom"],
      ["http", 500],
    ],
  );
  assert.equal(s.expected, 4);
});

const flows = (errors, failures = []) => ({
  journeys: [
    {
      id: "J2",
      name: "j",
      baseline: [],
      cells: [
        {
          id: "c",
          verdict: "PASS",
          stable: true,
          runs: [
            {
              run: 1,
              ok: true,
              failures,
              errors,
              flow: {
                counts: { essential: 0, safety: 0, overhead: 0, total: 0 },
                agentOps: 0,
                agentCalls: [],
                comparison: {
                  counts: { overhead: 0 },
                  baselineCounts: { overhead: 0 },
                  extra: [],
                  missing: [],
                  reclassed: [],
                },
              },
            },
          ],
        },
      ],
    },
  ],
});
const digest = (n) =>
  errorsDigest({
    schema: "archer-errors/1",
    events: n + 2,
    expected: 2,
    unseeded: n,
    unseededByKind: { alert: n },
    unseededEvents: Array.from({ length: n }, () => ({ tab: "t0", step: "s", kind: "alert", text: "Could not save" })),
    unusedDeclarations: [],
  });

test("report: unseeded errors are measured from the census plus failures, ratcheted at 0; no census is NOT EVALUATED", () => {
  const row = (f) => buildReport(mergeRuns([f]), null).rows.find((r) => r.key === "unseeded J2");
  assert.equal(row(flows(digest(0))).value, 0);
  assert.equal(row(flows(digest(0))).comparison, "baseline set");
  const bad = row(flows(digest(1), [{ step: "x", kind: "invariant", message: "overlap" }]));
  assert.equal(bad.value, 2);
  assert.equal(bad.comparison, "ratchet FAIL");
  assert.deepEqual(bad.detail.byKind, { alert: 1 });
  assert.deepEqual(
    bad.events.map((e) => [e.kind, e.text]),
    [
      ["failure", "overlap"],
      ["alert", "Could not save"],
    ],
  );
  assert.equal(row(flows(null)).verdict, "NOT EVALUATED");
});

// PC-601: the census records an alert when it appears or changes, so one a condition absorbed and the page never took
// down after the condition ended (claude-602's "Archer did not answer." after reconnecting) went uncounted. At the end
// of each step, an error alert or notice still shown, first absorbed by a condition that has ended (and its grace), is
// counted once, as stale. A step's own declaration still covers it; a condition still open does too.
test("PC-601: an alert a condition absorbed and still shown after the condition and its grace ended is counted, once", async () => {
  let now = 0,
    step = "offline: press Edit";
  const { census, ctx, ready } = setup(
    () => step,
    () => now,
  );
  const page = await ready;
  let shown = [];
  page.evaluate = async () => shown;
  page.isClosed = () => false;
  const close = census.condition("browser offline", CAUSES["browser offline"]);
  await ctx.alert(page, "Archer did not answer.");
  await ctx.alert(page, "Could not add the comment: Waiting for Archer to reconnect.");
  shown = [
    { kind: "alert", text: "Archer did not answer." },
    { kind: "alert", text: "Could not add the comment: Waiting for Archer to reconnect." },
  ];
  await census.stepEnded(); // the condition is open: nothing stale
  close();
  step = "online again";
  census.stepStarted();
  now += 2000;
  await census.stepEnded(); // inside the grace: the page may still be reconnecting
  shown = [{ kind: "alert", text: "Archer did not answer." }];
  step = "wait";
  census.stepStarted();
  now += 20_000;
  await census.stepEnded(); // the reconnect alert went; the other stayed
  step = "wait more";
  census.stepStarted();
  now += 5000;
  await census.stepEnded(); // counted once, not at every step
  const s = census.summary();
  assert.deepEqual(
    s.unseededEvents.map((e) => [e.step, e.kind, e.text, e.stale]),
    [["wait", "alert", "Archer did not answer.", "condition: browser offline"]],
  );
  assert.equal(s.unseeded, 1);
});

test("PC-601: a stale alert the step declares, a declared one that persists, and a closed page are not counted", async () => {
  let now = 0;
  const { census, ctx, ready } = setup(
    () => "s",
    () => now,
  );
  const page = await ready;
  page.evaluate = async () => [
    { kind: "alert", text: "Save is blocked: the original changed." },
    { kind: "alert", text: "Archer did not answer." },
  ];
  page.isClosed = () => false;
  await census.declared([{ kind: "alert", text: /Save is blocked/ }], async () => {
    await ctx.alert(page, "Save is blocked: the original changed.");
  });
  const close = census.condition("network stalled", CAUSES["network stalled"]);
  await ctx.alert(page, "Archer did not answer.");
  close();
  census.stepStarted();
  now += 30_000;
  await census.declared([{ kind: "alert", text: "did not answer" }], () => census.stepEnded());
  const gone = ctx.newPage();
  gone.evaluate = async () => {
    throw new Error("closed");
  };
  gone.isClosed = () => true;
  await census.stepEnded();
  const s = census.summary();
  assert.equal(s.unseeded, 0);
  assert.equal(s.all.filter((e) => e.stale).length, 1); // recorded, and covered by the step's declaration
});

test("PC-601: the per-run digest keeps what was absorbed, by text, deduplicated, and what absorbed it", async () => {
  const now = 0;
  const { census, ctx, ready } = setup(
    () => "s",
    () => now,
  );
  const page = await ready;
  const close = census.condition("browser offline", CAUSES["browser offline"]);
  await ctx.alert(page, "Archer did not answer.");
  await ctx.alert(page, "Archer did not answer, and now?");
  ctx.fail(page, "http://h/api/a", "net::ERR_INTERNET_DISCONNECTED");
  ctx.fail(page, "http://h/api/b", "net::ERR_INTERNET_DISCONNECTED");
  close();
  await census.declared([{ kind: "http", status: 409 }], async () => {
    ctx.respond(page, "http://h/api/write", 409);
  });
  const d = errorsDigest(census.summary());
  assert.deepEqual(d.absorbed, [
    { kind: "alert", text: "Archer did not answer.", by: "condition: browser offline", count: 1 },
    { kind: "alert", text: "Archer did not answer, and now?", by: "condition: browser offline", count: 1 },
    { kind: "failed", text: "net::ERR_INTERNET_DISCONNECTED", by: "condition: browser offline", count: 2 },
    { kind: "http", text: "GET 409", by: "step: s", count: 1 },
  ]);
  assert.deepEqual(
    errorsDigest({
      schema: "archer-errors/1",
      events: 0,
      expected: 0,
      unseeded: 0,
      unseededByKind: {},
      unseededEvents: [],
      unusedDeclarations: [],
    }).absorbed,
    [],
  );
});

// codex-702: an alert a condition absorbed, demoted to a notice (role="status", same class and text) after the
// condition's grace, is still the same element still shown: followed by its identity, not its kind and text, so the
// end-of-step look still counts it. The page reports the kind change as a new notice (alertWatch keeps kind and text
// per element); a page that did not (an older watch) is caught at the end of the step as stale.
test("codex-702: an absorbed alert demoted to a notice with the same text is still counted, once", async () => {
  for (const reported of [true, false]) {
    let now = 0,
      step = "offline";
    const { census, ctx, ready } = setup(
      () => step,
      () => now,
    );
    const page = await ready;
    let shown = [];
    page.evaluate = async () => shown;
    page.isClosed = () => false;
    const close = census.condition("browser offline", CAUSES["browser offline"]);
    await ctx.alert(page, "Archer did not answer.", "alert", "d1:1");
    shown = [{ kind: "alert", text: "Archer did not answer.", el: "d1:1" }];
    await census.stepEnded();
    close();
    step = "role changes";
    census.stepStarted();
    now += 20_000;
    if (reported) await ctx.alert(page, "Archer did not answer.", "notice", "d1:1");
    shown = [{ kind: "notice", text: "Archer did not answer.", el: "d1:1" }];
    await census.stepEnded();
    await census.stepEnded();
    const s = census.summary();
    assert.deepEqual(
      s.unseededEvents.map((e) => [e.step, e.kind, e.text]),
      [["role changes", "notice", "Archer did not answer."]],
      `reported ${reported}`,
    );
    assert.equal(s.unseeded, 1);
  }
});

test("codex-702: two elements with the same text are followed apart: the one taken down does not hide the other", async () => {
  let now = 0;
  const { census, ctx, ready } = setup(
    () => "s",
    () => now,
  );
  const page = await ready;
  page.isClosed = () => false;
  const close = census.condition("browser offline", CAUSES["browser offline"]);
  await ctx.alert(page, "Archer did not answer.", "alert", "d1:1");
  close();
  census.stepStarted();
  now += 20_000;
  // A second element with the text, raised by a declared step after the condition: its own window covers it.
  await census.declared([{ kind: "alert", text: "did not answer" }], async () => {
    await ctx.alert(page, "Archer did not answer.", "alert", "d1:2");
  });
  census.stepStarted();
  now += 20_000;
  page.evaluate = async () => [{ kind: "alert", text: "Archer did not answer.", el: "d1:1" }];
  await census.stepEnded();
  const s = census.summary();
  assert.deepEqual(
    s.unseededEvents.map((e) => [e.kind, e.text, e.stale]),
    [["alert", "Archer did not answer.", "condition: browser offline"]],
  );
});
