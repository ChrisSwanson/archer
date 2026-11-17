// node --test tools/devkit/test/navigations.test.mjs
// The navigation census (harness/navigations.mjs, rubric §5 "Unrequested reloads") over fake Playwright events, and
// its row in the §5 report. The browser-backed proofs are flows/demo/prove-collectors.mjs "navigations".
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cleanUrl, declarationOf, navigationCensus } from "../harness/navigations.mjs";
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
  mainFrame() {
    return this.frame;
  }
  async goto(url) {
    this._context.load(this, url);
  }
}
class FakeContext extends EventEmitter {
  constructor() {
    super();
    this._pages = [];
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
  /** A document load in `page` (frame null: a new tab's first load, before its frame exists). */
  load(page, url, { frame = page?.mainFrame() ?? null, status = 200 } = {}) {
    const r = {
      url: () => url,
      method: () => "GET",
      isNavigationRequest: () => true,
      redirectedFrom: () => null,
      frame: () => {
        if (!frame) throw new Error("no frame");
        return frame;
      },
      failure: () => null,
      serviceWorker: () => null,
    };
    this.emit("request", r);
    this.emit("response", { request: () => r, status: () => status });
    if (page) page.emit("framenavigated", page.mainFrame(), (page._url = url));
    return r;
  }
  move(page, url) {
    page.emit("framenavigated", page.mainFrame());
    page._url = url;
  }
}
// framenavigated reads frame.url(): the fake frame answers the page's last address.
const withUrls = (p) => {
  p.frame.url = () => p._url ?? "about:blank";
  return p;
};

test("addresses are written without credentials", () => {
  assert.equal(cleanUrl("http://h/projects/?token=abcdefghijklmnopqrstuvwxyz0123"), "http://h/projects/?token=…");
  assert.equal(cleanUrl("http://h/-/access/AbCdEfGhIjKlMnOpQrStUvWxYz012345/x"), "http://h/-/access/…/x");
  assert.equal(
    cleanUrl("http://h/projects/p/diagrams/f.mmd?walkthrough=order-to-courier&step=2&edit"),
    "http://h/projects/p/diagrams/f.mmd?walkthrough=order-to-courier&step=2&edit",
  );
  assert.equal(cleanUrl("http://h/x#k=secret"), "http://h/x#…");
});

test("a step's navigates option is a declaration of one load, or of its address", () => {
  assert.equal(declarationOf(undefined), null);
  assert.deepEqual(declarationOf(true), { url: true, count: 1 });
  assert.deepEqual(declarationOf({ url: "/x", count: 2 }), { url: "/x", count: 2 });
});

test("the journey's goto is issued; a load the page starts itself is not; a same-document change is recorded apart", async () => {
  let step = "open";
  const census = navigationCensus({ stepTitle: () => step });
  const ctx = new FakeContext();
  census.watch(ctx);
  const page = withUrls(ctx.newPage());
  census.name(page, 0);
  // The wrapped goto is Page.prototype's; the fake's own goto is wrapped the same way by installNavigationWatch.
  await page.goto("http://h/projects/p/");
  step = "wait";
  ctx.load(page, "http://h/projects/p/"); // the page reloads itself
  page._url = "http://h/projects/p/diagrams/a.mmd";
  page.emit("framenavigated", page.mainFrame()); // pushState
  const s = census.summary();
  assert.equal(s.documents, 2);
  assert.equal(s.issued, 1);
  assert.equal(s.unrequested, 1);
  assert.deepEqual(s.unrequestedLoads, [
    { tab: "t0", step: "wait", url: "http://h/projects/p/", kind: "reload", outcome: "answered" },
  ]);
  assert.equal(s.sameDocument, 1);
});

test("a declaration absorbs its own load only: once used, and never after the next step starts", async () => {
  let now = 0;
  const census = navigationCensus({ stepTitle: () => "s", now: () => now });
  const ctx = new FakeContext();
  census.watch(ctx);
  const page = withUrls(ctx.newPage());
  await census.declared(
    true,
    async () => {
      ctx.load(page, "http://h/a");
    },
    "click a real link",
  );
  ctx.load(page, "http://h/b"); // within the grace, but the declaration is spent
  await census.declared(/\/c$/, async () => {}, "declared, nothing came");
  census.stepStarted();
  now += 10;
  ctx.load(page, "http://h/c"); // the next step: no longer absorbed
  const s = census.summary();
  assert.deepEqual(
    s.loads.map((l) => l.issued),
    [true, false, false],
  );
  assert.deepEqual(s.unusedDeclarations, ["step: declared, nothing came"]);
});

test("a new tab's first load seen before its frame is counted, issued when declared", async () => {
  const census = navigationCensus();
  const ctx = new FakeContext();
  census.watch(ctx);
  await census.declared(true, async () => {
    ctx.load(null, "http://h/x", { frame: null });
  });
  ctx.load(null, "http://h/y", { frame: null });
  const s = census.summary();
  assert.equal(s.documents, 2);
  assert.deepEqual(
    s.loads.map((l) => [l.kind, l.issued]),
    [
      ["first load of the tab", true],
      ["first load of the tab", false],
    ],
  );
});

const flows = (navigations) => ({
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
                elapsed: { ms: 900, stepsMs: 700, harnessMs: 200 },
              },
              navigations,
            },
          ],
        },
      ],
    },
  ],
});
const census = (unrequested) => ({
  schema: "archer-navigations/1",
  documents: 3,
  issued: 3 - unrequested,
  unrequested,
  unrequestedLoads: Array.from({ length: unrequested }, () => ({
    tab: "t0",
    step: "s",
    url: "http://h/",
    kind: "reload",
    outcome: "answered",
  })),
  sameDocument: 2,
  unusedDeclarations: [],
});

test("report: unrequested reloads are measured, ratcheted at 0, and a run without a census is NOT EVALUATED", () => {
  const row = (f) => buildReport(mergeRuns([f]), null).rows.find((r) => r.key === "reloads J2");
  assert.equal(row(flows(census(0))).comparison, "baseline set");
  assert.equal(row(flows(census(0))).value, 0);
  const bad = row(flows(census(1)));
  assert.equal(bad.comparison, "ratchet FAIL");
  assert.equal(bad.loads.length, 1);
  assert.equal(row(flows(null)).verdict, "NOT EVALUATED");
});

test("report: elapsed task time is measured from the trace's timings and stays inconclusive", () => {
  const r = buildReport(mergeRuns([flows(census(0))]), null).rows.find((x) => x.key === "time J2");
  assert.equal(r.value, 900);
  assert.equal(r.comparison, "inconclusive");
  assert.deepEqual(r.detail, { runs: 1, medianStepsMs: 700, medianHarnessMs: 200 });
});
