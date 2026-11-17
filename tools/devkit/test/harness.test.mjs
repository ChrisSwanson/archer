// node --test tools/devkit/test/*.test.mjs
// Pure parts of the harness: invariant judgements, message location, CPU split, budget block. No browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  duplicateWrites,
  expectedShortcut,
  resolveInvariants,
  runInvariants,
  savedInStep,
  selectionMoved,
  shortcutFocus,
} from "../harness/invariants.mjs";
import { locateNewMessage, normalizeSource, pressModeButton } from "../harness/actions.mjs";
import { frameKind, splitProfile } from "../harness/cpu.mjs";
import { EventEmitter } from "node:events";
import { budgetFromEvidence, trackDocuments } from "../harness/index.mjs";

const key = (over) => ({
  key: "z",
  ctrl: true,
  meta: false,
  alt: false,
  shift: false,
  target: { tag: "body" },
  onBody: true,
  inEditable: false,
  inDialog: false,
  editing: true,
  busy: false,
  selection: 0,
  prevented: true,
  focusMoved: false,
  valueChanged: false,
  ...over,
});

test("shortcut-focus: a shortcut nobody took while editing fails; a handled one passes", () => {
  assert.equal(shortcutFocus([key()]).ok, true);
  const dead = shortcutFocus([key({ prevented: false })]);
  assert.equal(dead.ok, false);
  assert.equal(dead.severity, "fail");
  assert.match(dead.details.dead[0].reason, /<body>/);
  // Delete with nothing selected is not a shortcut; with a selection it is.
  assert.equal(shortcutFocus([key({ key: "Delete", ctrl: false, prevented: false })]).skipped, undefined);
  assert.equal(shortcutFocus([key({ key: "Delete", ctrl: false, prevented: false })]).ok, true);
  assert.equal(shortcutFocus([key({ key: "Delete", ctrl: false, prevented: false, selection: 1 })]).ok, false);
  // Not editing, or inside a dialog/menu: not judged.
  assert.equal(shortcutFocus([key({ prevented: false, editing: false })]).ok, true);
  assert.equal(shortcutFocus([key({ prevented: false, inDialog: true })]).ok, true);
  // While busy: a warning, not a failure.
  const busy = shortcutFocus([key({ prevented: false, busy: true })]);
  assert.deepEqual([busy.ok, busy.severity], [false, "warn"]);
  assert.equal(shortcutFocus([]).skipped, "no key presses");
});

test("shortcut-focus: a key typed into a field that a shortcut swallowed fails; real typing passes", () => {
  const field = { inEditable: true, onBody: false, target: { tag: "textarea" }, ctrl: false };
  assert.equal(shortcutFocus([key({ ...field, key: "c", prevented: false, valueChanged: true })]).ok, true);
  const stolen = shortcutFocus([key({ ...field, key: "c", prevented: true, valueChanged: false })]);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.details.stolen[0].key, "c");
  assert.equal(
    shortcutFocus([key({ ...field, key: "g", focusMoved: true })]).ok,
    false,
    "focus pulled out of the field",
  );
  assert.equal(
    shortcutFocus([key({ ...field, key: "Enter", prevented: true })]).ok,
    true,
    "Enter commits a field: not typing",
  );
  assert.equal(
    shortcutFocus([key({ ...field, key: "z", ctrl: true, prevented: true })]).ok,
    true,
    "Ctrl+Z in a field is not a typed key",
  );
  assert.equal(expectedShortcut({ key: "ArrowUp", alt: true, selection: 1 }), true);
  assert.equal(
    expectedShortcut({ key: "ArrowUp", alt: true, selection: 2 }),
    false,
    "several picked: Alt+arrows do nothing by design",
  );
  assert.equal(
    expectedShortcut({ key: "ArrowUp", alt: true, selection: 1, sequence: false }),
    false,
    "a graph canvas leaves Alt+arrows to the browser",
  );
});

test("duplicate-writes: identical bodies twice in one document fail; across a reload they do not", async () => {
  const w = (at, doc) => ({ method: "POST", url: "http://h/p/x/api/authoring/preview", body: "abc", at, doc });
  const run = async (requests) =>
    (
      await runInvariants(
        {
          page: null,
          window: {
            pageErrors: [],
            console: [],
            failed: [],
            responses: [],
            requests,
            csp: [],
            navigations: [],
            keys: [],
          },
          viewRequests: () => ({}),
          warnings: [],
          meta: {},
        },
        resolveInvariants(
          Object.fromEntries(
            Object.keys(resolveInvariants())
              .filter((n) => n !== "duplicate-writes")
              .map((n) => [n, false]),
          ),
        ),
      )
    ).find((r) => r.name === "duplicate-writes");
  assert.equal((await run([w(0, 1), w(500, 1)])).ok, false);
  assert.equal((await run([w(0, 1), w(500, 2)])).ok, true);
});

test("duplicate-writes: an identical write after a new key/pointer press or another write is a new action", () => {
  const w = (at, body = "abc") => ({ method: "POST", url: "http://h/p/x/api/authoring/edit", body, at, doc: 1 });
  assert.equal(duplicateWrites([w(0), w(30)]).length, 1, "Enter then blur: nothing in between");
  assert.equal(duplicateWrites([w(0), w(600)], {}, [300]).length, 0, "delete, undo (a key), delete again");
  assert.equal(duplicateWrites([w(0), w(250, "undo-preview"), w(600)]).length, 0, "another write in between");
  assert.equal(duplicateWrites([w(0), w(2500)]).length, 0, "outside the window");
});

const sel = (kind, id, text) => ({ kind, id, text });
test("selection-identity: a rename keeps the element; a renumbered selection shows another element's name", () => {
  // Rename b: its old name is gone and the new one is new.
  assert.deepEqual(
    selectionMoved(
      [sel("node", "b", "API|API")],
      [sel("node", "b", "Gateway|Gateway")],
      [sel("node", "a", "Client|Client"), sel("node", "b", "API|API")],
      [sel("node", "a", "Client|Client"), sel("node", "b", "Gateway|Gateway")],
    ),
    [],
  );
  // msg-2 deleted while selected: msg-2 now names what msg-3 named.
  const before = [
    sel("message", "msg-1", "1. A to B: x|"),
    sel("message", "msg-2", "2. A to B: y|"),
    sel("message", "msg-3", "3. B to A: z|"),
  ];
  const after = [sel("message", "msg-1", "1. A to B: x|"), sel("message", "msg-2", "2. B to A: z|")];
  assert.equal(selectionMoved([before[1]], [after[1]], before, after).length, 1);
  // A message inserted above the selected msg-2: the selected one's name moved to msg-3.
  const inserted = [
    sel("message", "msg-1", "1. A to B: x|"),
    sel("message", "msg-2", "2. A to B: new|"),
    sel("message", "msg-3", "3. A to B: y|"),
    sel("message", "msg-4", "4. B to A: z|"),
  ];
  assert.equal(selectionMoved([before[1]], [inserted[1]], before, inserted).length, 1);
  // Renaming one of two "Process" nodes is still a rename.
  const two = [sel("node", "n1", "Process|"), sel("node", "n2", "Process|")];
  assert.deepEqual(
    selectionMoved([two[1]], [sel("node", "n2", "Cache|")], two, [two[0], sel("node", "n2", "Cache|")]),
    [],
  );
});

test("savedInStep: only a successful editor write (POST …/api/authoring) counts as a Save", () => {
  assert.equal(savedInStep({ responses: [{ method: "POST", url: "http://h/p/x/api/authoring", status: 200 }] }), true);
  assert.equal(savedInStep({ responses: [{ method: "POST", url: "http://h/p/x/api/authoring", status: 409 }] }), false);
  assert.equal(
    savedInStep({ responses: [{ method: "POST", url: "http://h/p/x/api/authoring/edit", status: 200 }] }),
    false,
  );
});

test("csp-violations also fails on the page's own ui.csp-violation telemetry", async () => {
  const only = resolveInvariants(
    Object.fromEntries(
      Object.keys(resolveInvariants())
        .filter((n) => n !== "csp-violations")
        .map((n) => [n, false]),
    ),
  );
  const r = await runInvariants(
    {
      page: null,
      window: {
        pageErrors: [],
        console: [],
        failed: [],
        responses: [],
        requests: [],
        csp: [],
        navigations: [],
        keys: [],
      },
      warnings: [{ code: "ui.csp-violation", data: { directive: "img-src", blocked: "http://h/x" } }],
      meta: {},
    },
    only,
  );
  assert.equal(r[0].name, "csp-violations");
  assert.equal(r[0].ok, false);
});

const m = (id, from, to, label) => ({ id, from, to, label });

test("locateNewMessage finds a message inserted above others by what it shows, not by msg-N", () => {
  const before = [m("msg-0", "c", "s", "POST"), m("msg-1", "s", "c", "200 OK")];
  const after = [m("msg-0", "c", "d", "before-first"), m("msg-1", "c", "s", "POST"), m("msg-2", "s", "c", "200 OK")];
  assert.deepEqual(locateNewMessage(before, after, { from: "c", to: "d", label: "before-first" }), {
    id: "msg-0",
    index: 0,
  });
  assert.equal(locateNewMessage(before, [...before, m("msg-2", "s", "d", "")], { from: "s", to: "d" }).id, "msg-2");
});

test("locateNewMessage names the message that got the label instead (codex-arch#1)", () => {
  const before = [m("msg-0", "c", "s", "POST"), m("msg-1", "s", "c", "200 OK")];
  const after = [m("msg-0", "c", "d", ""), m("msg-1", "c", "s", "POST"), m("msg-2", "s", "c", "before-first")];
  assert.throws(
    () => locateNewMessage(before, after, { from: "c", to: "d", label: "before-first" }),
    /msg-0 \(c → d\) shows ""; labels changed on msg-2 "200 OK" → "before-first"/,
  );
  assert.throws(() => locateNewMessage(before, before, { from: "c", to: "d" }), /expected one new message/);
});

test("normalizeSource compares CRLF sources as the textarea shows them", () => {
  assert.equal(normalizeSource("a\r\nb\rc\n"), "a\nb\nc\n");
});

test("splitProfile charges samples to app, harness or browser by the innermost frame", () => {
  const origin = "http://127.0.0.1:1";
  assert.equal(frameKind({ url: `${origin}/projects/x`, functionName: "render" }, origin), "app");
  assert.equal(frameKind({ url: "", functionName: "visitNode" }, origin), "harness");
  assert.equal(frameKind({ url: "", functionName: "(garbage collector)" }, origin), "browser");
  assert.equal(frameKind({ url: "", functionName: "(idle)" }, origin), "idle");
  const profile = {
    nodes: [
      { id: 1, callFrame: { url: "", functionName: "(root)" } },
      { id: 2, callFrame: { url: `${origin}/p`, functionName: "commit", lineNumber: 9 } },
      { id: 3, callFrame: { url: "", functionName: "query", lineNumber: 0 } },
      { id: 4, callFrame: { url: "", functionName: "(program)" } },
    ],
    samples: [2, 2, 3, 4, 1],
    timeDeltas: [1000, 1000, 3000, 500, 9000],
  };
  const s = splitProfile(profile, origin);
  assert.deepEqual([s.appMs, s.harnessMs, s.browserMs, s.busyMs, s.idleMs], [2, 3, 0.5, 5.5, 9]);
  assert.match(s.topApp[0], /commit p:10/);
});

test("budgetFromEvidence: one row per document, polls apart from duplicates, warnings by code", () => {
  const o = "http://h";
  const r = (url, at, doc, over = {}) => ({
    url: o + url,
    method: "GET",
    type: "fetch",
    at,
    doc,
    transferBytes: 10,
    status: 200,
    ...over,
  });
  const ev = {
    requests: [
      r("/projects/a/?token=secret", 0, 1, { type: "document", transferBytes: 1000 }),
      r("/p/a/api/diagrams", 10, 1),
      r("/p/a/api/diagrams", 20, 1),
      r("/p/a/api/diagrams", 30, 1),
      r("/p/a/api/browser-projects", 100, 1),
      r("/p/a/api/browser-projects", 15100, 1, { poll: "project-catalog#1" }), // a poll tick (the debug build's tag)
      r("/p/a/api/bootstrap", 200, 1),
      r("/p/a/api/bootstrap", 400, 1), // read again after a person's input at 300
      r("/-/debug/events", 50, 1, { method: "POST" }),
      r("/p/a/api/other", 60, 1, { tab: 1 }),
      r("/projects/a/b.mmd", 2000, 2, { type: "document" }),
      r("/p/a/api/authoring/preview", 2100, 2, { method: "POST", body: "h1" }),
    ],
    invalidations: [300],
  };
  const summary = {
    startedAt: "t",
    warningCodes: { "ui.long-task": { count: 2 }, "svc.duplicate-request": { count: 1 } },
    failures: [{ kind: "invariant", invariant: "duplicate-requests" }, { kind: "action" }],
    invariantTotals: { "duplicate-writes": { fail: 0 } },
  };
  const b = budgetFromEvidence({ name: "j", ev, summary, origin: o });
  assert.equal(b.schema, "archer-budget/1");
  assert.equal(b.pages.length, 2);
  assert.equal(b.pages[0].url, "/projects/a/?token=…", "the login token never reaches summary.json");
  assert.deepEqual(
    [
      b.pages[0].requests,
      b.pages[0].apiRequests,
      b.pages[0].duplicateRequests,
      b.pages[0].pollTicks,
      b.pages[0].transferBytes,
    ],
    [8, 7, 2, 1, 1070],
  );
  assert.deepEqual(b.pages[0].duplicates, [{ request: "GET http://h/p/a/api/diagrams", count: 3 }]);
  assert.deepEqual(b.totals, {
    pages: 2,
    requests: 10,
    apiRequests: 8,
    duplicateRequests: 2,
    duplicateWrites: 0,
    transferBytes: 1090,
    failedRequests: 0,
    maxApiRequestsPerPage: 7,
    maxDuplicateRequestsPerPage: 2,
  });
  assert.deepEqual(b.warnings, { total: 3, byCode: { "ui.long-task": 2, "svc.duplicate-request": 1 } });
  assert.deepEqual(b.failures, { total: 2, byInvariant: { "duplicate-requests": 1 }, actions: 1 });
});

/** A page emitting what Playwright's does, in Chromium's order, through the harness's own wiring. */
function fakePage() {
  const frame = () => {
    let at = "about:blank";
    return {
      url: () => at,
      go: (url) => {
        at = url;
      },
    };
  };
  const pg = new EventEmitter(),
    main = frame(),
    other = frame();
  pg.mainFrame = () => main;
  const ask = (url, { navigation = false, frame = main } = {}) => {
    const r = { url: () => url, isNavigationRequest: () => navigation, frame: () => frame };
    pg.emit("request", r);
    return r;
  };
  return {
    pg,
    other,
    ask,
    /** A main-frame navigation request; `answer(status)` its response, `fail()` it cancelled. */
    navigate(url, frame = main) {
      const r = ask(url, { navigation: true, frame });
      return {
        r,
        answer: (status = 200) => pg.emit("response", { request: () => r, status: () => status }),
        fail: () => pg.emit("requestfailed", r),
      };
    },
    /** The main frame shows `url`: a commit, or a same-document change. */
    shows(url, frame = main) {
      frame.go(url);
      pg.emit("framenavigated", frame);
    },
  };
}

test("trackDocuments: a request the old page issues before the next document commits stays with the old page (O23)", () => {
  const { pg, ask, navigate, shows, other } = fakePage();
  const commits = [];
  const docs = trackDocuments(pg, { onCommit: (url) => commits.push(url) });
  const O = "http://127.0.0.1:1";
  // A redirect hop is a document of its own; the page commits at the address it ended on.
  const hop = navigate(`${O}/projects/?token=t`);
  hop.answer(303);
  const first = navigate(`${O}/projects/`);
  assert.deepEqual([docs.of(hop.r), docs.of(first.r)], [1, 2]);
  first.answer();
  shows(`${O}/projects/`);
  assert.equal(docs.of(ask(`${O}/api/bootstrap`)), 2);
  // The next document is asked for and answered; until it commits, the outgoing page's requests are its own.
  const next = navigate(`${O}/projects/p/flow.mmd`);
  assert.equal(docs.of(next.r), 3);
  next.answer();
  assert.equal(docs.of(ask(`${O}/-/page-assets/elk-layout-worker-x.js`)), 2);
  // A navigation in a child frame is not the page's.
  navigate(`${O}/embed`, other);
  shows(`${O}/embed`, other);
  shows(`${O}/projects/p/flow.mmd#main`);
  assert.equal(docs.of(ask(`${O}/-/page-assets/elk-layout-worker-x.js`)), 3);
  shows(`${O}/projects/p/flow.mmd?edit`); // a pushState after the commit
  assert.equal(docs.of(ask(`${O}/api/bootstrap`)), 3);
  assert.deepEqual(commits, [`${O}/projects/`, `${O}/projects/p/flow.mmd`]);
});

test("trackDocuments: a cancelled reload or a 204 is no document, even when a hash change follows (O23 review)", () => {
  const { pg, ask, navigate, shows } = fakePage();
  const docs = trackDocuments(pg);
  const O = "http://127.0.0.1:1",
    page = `${O}/projects/p/flow.mmd`;
  const load = navigate(page);
  load.answer();
  shows(page);
  // The reload is cancelled (a beforeunload "Stay", net::ERR_ABORTED); the page that stayed changes its hash.
  const reload = navigate(page);
  reload.fail();
  shows(`${page}#a`);
  assert.equal(docs.of(ask(`${O}/api/bootstrap`)), 1, "the page that stayed keeps its requests");
  // A download is answered, then its request is aborted: no document either.
  const download = navigate(page);
  download.answer();
  download.fail();
  shows(`${page}#c`);
  assert.equal(docs.of(ask(`${O}/api/bootstrap`)), 1);
  // A navigation answered 204 does not replace the page either.
  navigate(`${O}/file`).answer(204);
  shows(`${O}/file`);
  assert.equal(docs.of(ask(`${O}/api/bootstrap`)), 1);
  // The same-document change arrives before the reload's answer: not its commit.
  const again = navigate(page);
  shows(`${page}#b`);
  assert.equal(docs.of(ask(`${O}/api/x`)), 1);
  again.answer();
  shows(page);
  assert.equal(docs.of(ask(`${O}/api/x`)), docs.of(again.r));
});

test("every journey has a deadline, so a frozen page fails fast instead of hanging the release check", async () => {
  const { journeyDeadlineMs, DEFAULT_JOURNEY_MS } = await import("../harness/index.mjs");
  assert.equal(journeyDeadlineMs({}), DEFAULT_JOURNEY_MS);
  assert.ok(DEFAULT_JOURNEY_MS <= 5 * 60_000);
  assert.equal(journeyDeadlineMs({ maxMs: 1234 }), 1234);
  // A journey whose single actions may take long gets room for several of them.
  assert.equal(journeyDeadlineMs({ timeoutMs: 600_000 }), 1_800_000);
  assert.equal(journeyDeadlineMs({ maxMs: 1234 }, 2), 120_000);
});

/** A page whose hover rail, expanded over the canvas (340 px), takes every click while the mouse is on it. */
const railPage = () => {
  const state = { mouse: { x: 0, y: 0 }, pressed: "false", clicks: 0 };
  const page = {
    mouse: {
      move: async (x, y) => {
        state.mouse = { x, y };
      },
    },
    // As in Playwright: locator.boundingBox() waits (the whole action timeout) for an element that is not there;
    // a page.evaluate reads the DOM as it is.
    evaluate: async () => (state.mouse.x < 340 ? { x: 0, width: 340 } : null),
    locator: () => ({
      waitFor: async () => {
        if (state.mouse.x < 340) throw new Error("still expanded");
      },
      boundingBox: () =>
        state.mouse.x < 340 ? Promise.resolve({ x: 0, y: 0, width: 340, height: 900 }) : new Promise(() => {}),
    }),
  };
  const button = {
    click: async () => {
      state.clicks++;
      if (state.mouse.x < 340) throw new Error("<aside class=primary-navigation> intercepts pointer events");
      state.pressed = "true";
    },
    getAttribute: async () => state.pressed,
  };
  return { state, page, button };
};

test("pressModeButton: a drag that ended over the rail moves off it before pressing, and fails loudly if it can't", async () => {
  const ok = railPage();
  ok.state.mouse = { x: 20, y: 300 };
  await pressModeButton(ok.page, ok.button, { x: 400, y: 300 });
  assert.deepEqual([ok.state.pressed, ok.state.clicks], ["true", 1]);
  // A resting point under the expanded rail: the mouse goes past the rail's right edge instead.
  const under = railPage();
  under.state.mouse = { x: 20, y: 300 };
  await pressModeButton(under.page, under.button, { x: 150, y: 300 });
  assert.deepEqual([under.state.pressed, under.state.mouse.x], ["true", 380]);
  const stuck = railPage();
  // A rail that never lets go (an overlay the mouse cannot leave): a loud failure, not a silent Hand mode.
  stuck.button.click = async () => {
    stuck.state.clicks++;
    throw new Error("<aside class=primary-navigation> intercepts pointer events");
  };
  await assert.rejects(
    pressModeButton(stuck.page, stuck.button, { x: 10, y: 300 }, { attempts: 2, timeout: 1 }),
    /could not switch the canvas pointer mode back: .*intercepts/,
  );
  assert.equal(stuck.state.clicks, 2);
});

test("pressModeButton: a collapsed rail costs nothing (smoke-a flow-existing: every pan waited out the 600 s action timeout)", async () => {
  const idle = railPage();
  idle.state.mouse = { x: 700, y: 300 };
  const done = pressModeButton(idle.page, idle.button, { x: 700, y: 300 }).then(() => "pressed");
  const stalled = new Promise((resolve) => setTimeout(() => resolve("stalled"), 1000).unref());
  assert.equal(await Promise.race([done, stalled]), "pressed");
  assert.equal(idle.state.pressed, "true");
});

test("readServiceLog: an unreadable service log names its cause, never an empty list (O5)", async () => {
  const { createServer } = await import("node:http");
  const { readServiceLog } = await import("../lib/service-log.mjs");
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${"a".repeat(32)}`;
    res
      .writeHead(ok ? 200 : 404, { "content-type": "application/json" })
      .end(ok ? JSON.stringify({ seq: 7, entries: [{ seq: 7, code: "svc.event-loop-lag" }] }) : "{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await readServiceLog(origin, "a".repeat(32), "limit=1"), {
      seq: 7,
      entries: [{ seq: 7, code: "svc.event-loop-lag" }],
    });
    assert.match((await readServiceLog(origin, "b".repeat(32), "limit=1")).unreadable, /answered 404/);
    assert.match((await readServiceLog(origin, undefined, "limit=1")).unreadable, /no service token/);
  } finally {
    server.close();
  }
  assert.match((await readServiceLog(origin, "a".repeat(32), "limit=1")).unreadable, /failed/);
});
