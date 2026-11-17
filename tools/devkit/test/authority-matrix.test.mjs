// node --import tsx --test tools/devkit/test/authority-matrix.test.mjs
// The G3 effect matrix (tools/devkit/security/authority-matrix.mjs, security rubric §1, G3, G6, P1, P10)
// proven before it scores: the judge on hand-made cells; then against a throwaway sandbox, a known pass
// (every cell as the §1 matrix says, each admitted cell with its effect, each refused one with none) and
// seeded fails the tool must report: a write rule the product ignores, an edit switch it ignores, a refusal
// that still writes, and an admission whose write did not happen.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  changedPaths,
  consumedBarrier,
  continuityAgedOnly,
  expectedHttp,
  listenersHousekeepingOnly,
  expectedHttpCode,
  expectedManagement,
  judge,
  PHASES,
  phaseRuns,
  recoveryDiff,
  snapshot,
  summarise,
  unconsumed,
} from "../security/authority-matrix-model.mjs";
import { KNOWN_PRODUCT_DEFECTS, run, stateDiff } from "../security/authority-matrix.mjs";
import { AGENT_FORGET_MS } from "../../../ts/src/agents/listeners.ts";
import { AGENT_WRITE_WINDOW_MS } from "../../../ts/src/service/protocol.ts";

const [ON_ALLOW, ON_DENY, OFF_ALLOW] = PHASES;

test("the judge: an effect is required of an admission, forbidden to a refusal, and never allowed outside", () => {
  const inside = ["project:.archer/"];
  assert.deepEqual(
    judge("admit", { admitted: true, changed: ["project:.archer/diagrams/flow.mmd"], positive: true }, inside),
    { verdict: "pass", mismatches: [], control: "positive" },
  );
  assert.deepEqual(judge("admit", { admitted: true, changed: [], positive: false }, inside).mismatches, ["no-effect"]);
  assert.deepEqual(judge("admit", { admitted: false, changed: [], positive: false }, inside).mismatches, [
    "under-admit",
  ]);
  assert.deepEqual(judge("refuse", { admitted: false, changed: [], positive: false }, inside), {
    verdict: "pass",
    mismatches: [],
    control: "negative",
  });
  assert.deepEqual(judge("refuse", { admitted: true, changed: [], positive: false }, inside).mismatches, [
    "over-admit",
  ]);
  assert.deepEqual(
    judge("refuse", { admitted: false, changed: ["project:.archer/diagrams/flow.mmd"], positive: false }, inside)
      .mismatches,
    ["refused-with-effect"],
  );
  assert.deepEqual(
    judge("refuse", { admitted: false, changed: [], positive: true, negative: false }, inside).mismatches,
    ["refused-with-effect"],
  );
  assert.deepEqual(
    judge("admit", { admitted: true, changed: ["canary:sym.mmd", "project:.archer/x"], positive: true }, inside)
      .mismatches,
    ["canary-changed"],
  );
  assert.deepEqual(
    judge("admit", { admitted: true, changed: ["project:README.md", "project:.archer/x"], positive: true }, inside)
      .mismatches,
    ["stray-effect"],
  );
  // Every cell carries an expectation: there is no "observed" or "either" cell to pass on its status alone.
  for (const loose of ["?", "either"])
    assert.throws(() => judge(loose, { admitted: true, changed: [], positive: false }, inside));
  // The refusal code the built behaviour fixes (a Bearer on archive/show: bare 404).
  assert.deepEqual(
    judge("refuse", { admitted: false, changed: [], positive: false, code: "editing_disabled" }, inside, {
      code: "bare_404",
    }).mismatches,
    ["wrong-refusal"],
  );
  assert.equal(
    judge("refuse", { admitted: false, changed: [], positive: false, code: "bare_404" }, inside, { code: "bare_404" })
      .verdict,
    "pass",
  );
});

test("the judge: a refusal that changed private service state is a mismatch, unless that state is on the row's allow-list", () => {
  const inside = ["project:.archer/"];
  // The reviewers' seed (codex-rescore4 E-G3 item 2): this passed as negative while `state:` paths were filtered out.
  const seed = { admitted: false, changed: ["state:runtime/project-lifecycle.json"], positive: false, negative: true };
  assert.deepEqual(judge("refuse", seed, inside), {
    verdict: "mismatch",
    mismatches: ["refused-with-effect"],
    control: "none",
  });
  for (const path of [
    "state:access-grants.json",
    "state:listeners.json",
    "state:runtime/change-review/index.json",
    "config:archer.toml",
  ])
    assert.ok(judge("refuse", { ...seed, changed: [path] }, inside).mismatches.includes("refused-with-effect"), path);
  // The allow-list is explicit and per cell: it covers its own paths and nothing else.
  assert.equal(
    judge("refuse", { ...seed, changed: ["state:runtime/abc.continuity.json"] }, inside, {
      refusalState: ["runtime/abc.continuity.json"],
    }).verdict,
    "pass",
  );
  assert.deepEqual(judge("refuse", seed, inside, { refusalState: ["runtime/abc.continuity.json"] }).mismatches, [
    "refused-with-effect",
  ]);
});

test("continuity aging: only announcements that really expired may drop out on a refusal, every other field unchanged", () => {
  const files = { policy: `sha256:${"a".repeat(64)}`, entries: [{ path: "diagrams/flow.mmd", kind: "diagram" }] };
  const now = 1_000_000_000_000,
    W = AGENT_WRITE_WINDOW_MS;
  const cell = { start: now - 300, end: now }; // the cell's own clock: before-snapshot .. after-read
  const old = { viewId: "flow", at: now - W - 1000 },
    fresh = { viewId: "notes/note.md#pinned", at: now - 100 };
  const text = (writes, more = {}) => JSON.stringify({ version: 1, root: "/r", files, writes, ...more });
  // Positive control: a real expiry (older than the product's 5 s window by the cell's end) drops out; a fresh one stays.
  assert.equal(continuityAgedOnly(text([old, fresh]), text([fresh]), cell), true);
  assert.equal(continuityAgedOnly(text([old]), text([]), cell), true);
  // Codex re-score 5, X-20 seeds 1 and 2: a fresh announcement removed at once, and the version changed with the writes kept.
  assert.equal(continuityAgedOnly(text([fresh]), text([]), cell), false, "a fresh announcement did not expire");
  assert.equal(continuityAgedOnly(text([fresh]), text([fresh], { version: 2 }), cell), false, "version changed");
  // Just inside the window is not expired; removing an old one while keeping one that a rewrite would also have dropped is not aging.
  assert.equal(
    continuityAgedOnly(text([{ viewId: "flow", at: now - W }]), text([]), cell),
    false,
    "at + window = end is not yet expired",
  );
  assert.equal(
    continuityAgedOnly(
      text([old, { viewId: "x", at: now - W - 900 }]),
      text([{ viewId: "x", at: now - W - 900 }]),
      cell,
    ),
    false,
    "a kept stale one",
  );
  assert.equal(continuityAgedOnly(text([old]), text([old]), cell), false, "unchanged is not aging");
  assert.equal(continuityAgedOnly(text([old]), text([old, fresh]), cell), false, "an added announcement is an effect");
  assert.equal(
    continuityAgedOnly(text([old]), text([{ ...old, at: now - 50 }]), cell),
    false,
    "a changed announcement",
  );
  assert.equal(
    continuityAgedOnly(text([old]), text([], { files: { ...files, entries: [] } }), cell),
    false,
    "a changed file baseline is an effect",
  );
  assert.equal(continuityAgedOnly(text([old]), text([], { root: "/other" }), cell), false, "root changed");
  assert.equal(continuityAgedOnly(text([old]), text([], { extra: true }), cell), false, "a key added");
  assert.equal(
    continuityAgedOnly(text([old]), text([])),
    false,
    "without the cell's clock nothing is shown to have expired",
  );
  assert.equal(continuityAgedOnly("not json", text([]), cell), false);
  // The pre-write announcement escape hatch is gone: a third argument naming a view admits nothing.
  assert.equal(continuityAgedOnly(text([]), text([fresh]), cell), false);
});

test("listener registry: only a real heartbeat or the product's idle forget may overlap a refusal", () => {
  const now = 1_000_000_000_000,
    cell = { start: now - 300, end: now };
  const iso = (ms) => new Date(ms).toISOString();
  const agent = (id, at) => ({
    agentId: id,
    root: "/r",
    cwd: "/r",
    host: "claude-code",
    label: "L",
    lastActive: iso(at),
  });
  const reg = (agents, more = {}) => JSON.stringify({ version: 1, pins: {}, agents, claims: {}, owners: {}, ...more });
  // Positive controls: a heartbeat moves lastActive forward within the cell; an agent silent past AGENT_FORGET_MS and holding no claim is forgotten.
  assert.equal(
    listenersHousekeepingOnly(reg([agent("ag-1", now - 60_000)]), reg([agent("ag-1", now - 10)]), cell),
    true,
    "a real heartbeat",
  );
  const idle = agent("ag-2", now - AGENT_FORGET_MS - 1000);
  assert.equal(
    listenersHousekeepingOnly(reg([agent("ag-1", now - 5), idle]), reg([agent("ag-1", now - 5)]), cell),
    true,
    "a really idle agent forgotten",
  );
  // Codex re-score 5, X-20 seeds 3 and 4: a fresh agent removed at once, and an active agent's lastActive backdated to 2001.
  assert.equal(
    listenersHousekeepingOnly(reg([agent("ag-1", now - 100)]), reg([]), cell),
    false,
    "a fresh agent did not go idle",
  );
  assert.equal(
    listenersHousekeepingOnly(
      reg([agent("ag-1", now - 100)]),
      reg([{ ...agent("ag-1", 0), lastActive: "2001-01-01T00:00:00Z" }]),
      cell,
    ),
    false,
    "backdated",
  );
  assert.equal(
    listenersHousekeepingOnly(reg([agent("ag-1", now - 100)]), reg([agent("ag-1", now + 60_000)]), cell),
    false,
    "future-dated past the cell's end",
  );
  assert.equal(
    listenersHousekeepingOnly(reg([idle], { claims: { "/r": "ag-2" } }), reg([], { claims: { "/r": "ag-2" } }), cell),
    false,
    "an idle agent holding a claim is not forgotten",
  );
  assert.equal(
    listenersHousekeepingOnly(reg([agent("ag-1", now - 100)]), reg([agent("ag-1", now - 50)])),
    false,
    "without the cell's clock",
  );
  assert.equal(
    listenersHousekeepingOnly(
      reg([agent("ag-1", now - 9)]),
      reg([agent("ag-1", now - 9), agent("ag-2", now - 9)]),
      cell,
    ),
    false,
    "an added agent",
  );
  assert.equal(
    listenersHousekeepingOnly(reg([agent("ag-1", now - 9)]), reg([{ ...agent("ag-1", now - 5), label: "X" }]), cell),
    false,
  );
  assert.equal(listenersHousekeepingOnly(reg([]), reg([], { pins: { "/r": "ag-1" } }), cell), false, "a pin");
  assert.equal(
    listenersHousekeepingOnly(reg([]), reg([], { owners: { "/r": { t: "ag-1" } } }), cell),
    false,
    "a thread owner",
  );
  assert.equal(listenersHousekeepingOnly(reg([]), reg([], { records: { k: 1 } }), cell), false, "delivery records");
  assert.equal(listenersHousekeepingOnly(reg([]), reg([]), cell), false, "unchanged");
});

// PD-1..3 are fixed: none is excused any more, so a recurrence is a mismatch that fails the run.
test("no product defect is listed as known", () => {
  assert.deepEqual(KNOWN_PRODUCT_DEFECTS, []);
});

test("X-20: Codex's four false-pass seeds, fed through the real helpers into the judge, are now refused-with-effect", () => {
  // The reproduction of codex-work/rs5/judge-controls.mjs, with the cell clock the tool now passes.
  const now = Date.now(),
    cell = { start: now - 200, end: now };
  const C = "state:runtime/probe.continuity.json",
    L = "state:listeners.json";
  const before = {
    version: 1,
    root: "/sandbox/project",
    files: { policy: `sha256:${"a".repeat(64)}`, entries: [] },
    writes: [{ viewId: "flow", at: now }],
  };
  const registry = {
    version: 1,
    pins: {},
    claims: {},
    owners: {},
    agents: [
      {
        agentId: "ag-0123456789ab",
        root: "/sandbox/project",
        cwd: "/sandbox/project",
        host: "other",
        label: "fresh",
        lastActive: new Date(now).toISOString(),
      },
    ],
  };
  const cases = [
    ["drop fresh announcement", C, continuityAgedOnly, before, { ...before, writes: [] }],
    ["change continuity version", C, continuityAgedOnly, before, { ...before, version: 2 }],
    ["drop fresh agent", L, listenersHousekeepingOnly, registry, { ...registry, agents: [] }],
    [
      "backdate active agent",
      L,
      listenersHousekeepingOnly,
      registry,
      { ...registry, agents: [{ ...registry.agents[0], lastActive: "2001-01-01T00:00:00Z" }] },
    ],
  ];
  const judged = (path, allowed) =>
    judge("refuse", { admitted: false, changed: [path], positive: false, negative: true }, ["project:.archer/"], {
      refusalState: allowed ? [path.slice(6)] : [],
    });
  for (const [name, path, allow, a, b] of cases) {
    assert.equal(allow(JSON.stringify(a), JSON.stringify(b), cell), false, name);
    assert.deepEqual(
      judged(path, allow(JSON.stringify(a), JSON.stringify(b), cell)),
      { verdict: "mismatch", mismatches: ["refused-with-effect"], control: "none" },
      name,
    );
  }
  // The positive controls through the same path: a real expiry and a real heartbeat stay allowed (pass, negative).
  const expired = { ...before, writes: [{ viewId: "flow", at: now - AGENT_WRITE_WINDOW_MS - 500 }] };
  assert.equal(
    judged(C, continuityAgedOnly(JSON.stringify(expired), JSON.stringify({ ...expired, writes: [] }), cell)).verdict,
    "pass",
  );
  const older = { ...registry, agents: [{ ...registry.agents[0], lastActive: new Date(now - 30_000).toISOString() }] };
  assert.equal(
    judged(L, listenersHousekeepingOnly(JSON.stringify(older), JSON.stringify(registry), cell)).verdict,
    "pass",
  );
});

// X-21 (codex-rescore6): the collector's actual quiet barrier, taken from its source as Codex's barrier-control.mjs does.
const QUIET_SOURCE = (() => {
  const text = readFileSync(new URL("../security/authority-matrix.mjs", import.meta.url), "utf8");
  const start = text.indexOf("const quiet = async (ms = quietMs) => {"),
    end = text.indexOf("const settled = () => quiet();", start);
  assert.ok(start >= 0 && end > start, "the collector's quiet function");
  return text.slice(start, end);
})();
const collectorQuiet = (dirs, quietMs = 600) =>
  new Function(
    "snapshot",
    "dirs",
    "changedPaths",
    "sleep",
    "quietMs",
    "SAMPLE_MS",
    "QUIET_CAP_MS",
    `let quietCapped=0;${QUIET_SOURCE}return quiet;`,
  )(snapshot, dirs, changedPaths, (ms) => new Promise((ok) => setTimeout(ok, ms)), quietMs, 100, 8000);
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** A scratch project and state directory; `service(entries)` rewrites the continuity baseline as a reload's last phase would. */
function scratchService(entries = []) {
  const root = mkdtempSync(join(tmpdir(), "archer-x21-")),
    project = join(root, "project"),
    state = join(root, "state");
  mkdirSync(join(project, ".archer", "notes"), { recursive: true });
  mkdirSync(join(state, "runtime"), { recursive: true });
  const continuity = join(state, "runtime", `${"c".repeat(64)}.continuity.json`),
    recovery = join(state, "runtime", `${"c".repeat(64)}.json`);
  const service = (list) =>
    writeFileSync(
      continuity,
      JSON.stringify({ version: 1, root: project, files: { policy: sha("p"), entries: list }, writes: [] }),
    );
  service(entries);
  writeFileSync(recovery, JSON.stringify({ version: 1, root: project, views: [] }));
  const dirs = [
      ["project", project],
      ["state", state],
    ],
    projectDirs = [["project", project]];
  const read = () => ({ disk: snapshot(projectDirs), continuity: readFileSync(continuity, "utf8"), root: project });
  return {
    root,
    project,
    recovery,
    service,
    dirs,
    projectDirs,
    read,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
const NOTE = "Cell note.\n\n```mermaid\nflowchart LR\n  a[A] e1@--> b[B]\n```\n";

test("X-21: a prepare the service consumes after 900 ms is waited for, and a refusal with no effect is judged negative", {
  timeout: 30_000,
}, async () => {
  for (const delay of [100, 900]) {
    const s = scratchService();
    try {
      const consumedProject = snapshot(s.projectDirs);
      // The prepare (freshEmbedded): a note written now; the service's reload persists recovery and then its baseline later.
      writeFileSync(join(s.project, ".archer/notes/cell-1.md"), NOTE);
      let landed = false;
      const service = new Promise((ok) =>
        setTimeout(() => {
          writeFileSync(
            s.recovery,
            JSON.stringify({ version: 1, root: s.project, views: [{ id: "notes/cell-1.md#diagram-1" }] }),
          );
          s.service([{ path: ".archer/notes/cell-1.md", kind: "note", revision: sha(NOTE) }]);
          landed = true;
          ok();
        }, delay),
      );
      const touched = changedPaths(consumedProject, snapshot(s.projectDirs));
      assert.deepEqual(touched, ["project:.archer/notes/cell-1.md"]);
      const quiet = collectorQuiet(s.dirs);
      const barrier = await consumedBarrier(touched, {
        read: s.read,
        quiet: () => quiet(),
        sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
        capMs: 10_000,
      });
      assert.equal(barrier.consumed, true, `${delay} ms`);
      assert.equal(landed, true, `${delay} ms: the reload landed before the baseline`);
      // Deliberately no request between the snapshots (Codex's control): a refusal that changed nothing.
      const after = await quiet(400);
      await service;
      const changed = changedPaths(barrier.before, after);
      assert.deepEqual(changed, [], `${delay} ms`);
      assert.deepEqual(
        judge("refuse", { admitted: false, changed, positive: false, negative: true }, ["project:.archer/"]),
        { verdict: "pass", mismatches: [], control: "negative" },
      );
    } finally {
      s.done();
    }
  }
});

test("X-21: silence alone (the old barrier) misjudges the 900 ms prepare; the consumed barrier does not hide a refusal's real effect", {
  timeout: 30_000,
}, async () => {
  // Control for the test itself: quiet alone returns before the late reload, which then reads as the refusal's effect.
  const s = scratchService();
  try {
    writeFileSync(join(s.project, ".archer/notes/cell-1.md"), NOTE);
    const service = new Promise((ok) =>
      setTimeout(() => {
        s.service([{ path: ".archer/notes/cell-1.md", kind: "note", revision: sha(NOTE) }]);
        ok();
      }, 900),
    );
    const quiet = collectorQuiet(s.dirs);
    const before = await quiet();
    const after = await quiet(400);
    await service;
    const changed = changedPaths(before, after);
    assert.equal(
      judge("refuse", { admitted: false, changed, positive: false, negative: true }, ["project:.archer/"]).verdict,
      "mismatch",
      "the race the old barrier had",
    );
  } finally {
    s.done();
  }
  // A refusal that really changes state after a consumed barrier is still refused-with-effect.
  const t = scratchService([{ path: ".archer/index.md", kind: "note", revision: sha("# Index\n") }]);
  try {
    writeFileSync(join(t.project, ".archer/index.md"), "# Index\n");
    const consumedProject = snapshot(t.projectDirs);
    rmSync(join(t.project, ".archer/index.md")); // docs-index's prepare
    setTimeout(() => t.service([]), 900);
    const quiet = collectorQuiet(t.dirs);
    const barrier = await consumedBarrier(changedPaths(consumedProject, snapshot(t.projectDirs)), {
      read: t.read,
      quiet: () => quiet(),
      sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
      capMs: 10_000,
    });
    assert.equal(barrier.consumed, true);
    writeFileSync(
      t.recovery,
      JSON.stringify({ version: 1, root: t.project, views: [], selection: { viewId: "flow" } }),
    );
    const changed = changedPaths(barrier.before, await quiet(400));
    assert.deepEqual(
      judge("refuse", { admitted: false, changed, positive: false, negative: true }, ["project:.archer/"]).mismatches,
      ["refused-with-effect"],
    );
    const [diff] = stateDiff(
      changed,
      { [changed[0]]: JSON.stringify({ version: 1, root: t.project, views: [] }) },
      { [changed[0]]: readFileSync(t.recovery, "utf8") },
      undefined,
    );
    assert.equal(diff.kind, "recovery");
    assert.deepEqual([diff.fieldsChanged, diff.selectedBefore, diff.selectedAfter], [["selection"], null, "flow"]);
  } finally {
    t.done();
  }
});

test("X-21: a change the service never consumes is NOT EVALUATED with its reason, never a pass", {
  timeout: 30_000,
}, async () => {
  const s = scratchService();
  try {
    const consumedProject = snapshot(s.projectDirs);
    writeFileSync(join(s.project, ".archer/notes/cell-1.md"), NOTE);
    const quiet = collectorQuiet(s.dirs);
    const barrier = await consumedBarrier(changedPaths(consumedProject, snapshot(s.projectDirs)), {
      read: s.read,
      quiet: () => quiet(),
      sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
      capMs: 1_000,
    });
    assert.equal(barrier.consumed, false);
    assert.deepEqual(barrier.pending, [
      { path: "project:.archer/notes/cell-1.md", reason: "written, not in the baseline yet" },
    ]);
  } finally {
    s.done();
  }
  const cell = {
    surface: "cli",
    row: "docs-index",
    column: "cli",
    phase: "edit-off+deny",
    expected: "refuse",
    admitted: false,
    changed: [],
    verdict: "not-evaluated",
    mismatches: [],
    control: "none",
    reason: "r",
  };
  const { totals, notEvaluatedCells } = summarise([cell, { ...cell, verdict: "pass", control: "negative" }]);
  assert.deepEqual(
    [totals.cells, totals.pass, totals.mismatch, totals.notEvaluatedCells, notEvaluatedCells.length],
    [2, 1, 0, 1, 1],
  );
});

test("X-21: what counts as consumed — the baseline at the disk's revision, a removal gone from it, links and other files ignored", () => {
  const root = "/r",
    text = (entries, more = {}) =>
      JSON.stringify({ version: 1, root, files: { policy: sha("p"), entries }, writes: [], ...more });
  const disk = {
    "project:.archer/notes/a.md": `1:${"a".repeat(64)}`,
    "project:.archer/diagrams/b.mmd": `1:${"b".repeat(64)}`,
    "project:.archer/notes/l.md": "link:x.md",
    "project:.archer/x.comments.json": `1:${"c".repeat(64)}`,
  };
  const a = { path: ".archer/notes/a.md", kind: "note", revision: `sha256:${"a".repeat(64)}` },
    b = { path: ".archer/diagrams/b.mmd", kind: "diagram", revision: `sha256:${"b".repeat(64)}` };
  const touched = Object.keys(disk);
  assert.deepEqual(unconsumed(touched, disk, text([a, b]), root), []);
  assert.deepEqual(
    unconsumed(touched, disk, text([a]), root).map((p) => p.path),
    ["project:.archer/diagrams/b.mmd"],
  );
  assert.deepEqual(
    unconsumed(touched, disk, text([a, { ...b, revision: `sha256:${"0".repeat(64)}` }]), root).map((p) => p.reason),
    ["the baseline holds another revision"],
  );
  // A removed document is consumed once the baseline drops it.
  assert.deepEqual(
    unconsumed(["project:.archer/index.md"], {}, text([{ path: ".archer/index.md", kind: "note" }]), root).map(
      (p) => p.reason,
    ),
    ["removed, still in the baseline"],
  );
  assert.deepEqual(unconsumed(["project:.archer/index.md"], {}, text([]), root), []);
  // No baseline, or another project's: pending (never assumed consumed).
  assert.equal(unconsumed(touched, disk, null, root).length, 2);
  assert.equal(unconsumed(touched, disk, text([a, b]), "/other").length, 2);
  // Nothing touched that the catalog lists: nothing to wait for.
  assert.deepEqual(unconsumed(["project:archer.toml", "project:.archer/x.comments.json"], disk, null, root), []);
});

test("X-21: a recovery record's diff names ids and counts, never captions, summaries or digests", () => {
  const before = JSON.stringify({
    version: 1,
    root: "/r",
    presentation: null,
    selection: null,
    captions: [["flow", { at: "t1", caption: "secret-ish caption" }]],
    lastChange: [],
    emphases: [],
    views: [{ id: "flow", path: "diagrams/flow.mmd", kind: "diagram", revision: `sha256:${"a".repeat(64)}` }],
  });
  const after = JSON.stringify({
    version: 1,
    root: "/r",
    presentation: { viewId: "flow" },
    selection: null,
    captions: [["flow", { at: "t2", caption: "another caption" }]],
    lastChange: [["notes/cell-1.md#diagram-1", { at: "t3", by: "person", summary: "words" }]],
    emphases: [{}],
    views: [
      { id: "flow", path: "diagrams/flow.mmd", kind: "diagram", revision: `sha256:${"b".repeat(64)}` },
      {
        id: "notes/cell-1.md#diagram-1",
        path: "notes/cell-1.md",
        kind: "embedded",
        revision: `sha256:${"c".repeat(64)}`,
      },
    ],
  });
  const d = recoveryDiff(before, after);
  assert.deepEqual(d.fieldsChanged, ["captions", "emphases", "lastChange", "presentation", "views"]);
  assert.deepEqual([d.viewsAdded, d.viewsRevised, d.viewsRemoved], [["notes/cell-1.md#diagram-1"], ["flow"], []]);
  assert.deepEqual(d.captions, { added: [], removed: [], changed: ["flow"] });
  assert.deepEqual(d.lastChange.added, ["notes/cell-1.md#diagram-1"]);
  assert.equal(d.lastChange.byAfter["notes/cell-1.md#diagram-1"], "person");
  assert.deepEqual([d.presentedBefore, d.presentedAfter, d.emphasesBefore, d.emphasesAfter], [null, "flow", 0, 1]);
  const text = JSON.stringify(d);
  for (const leak of ["secret-ish", "another caption", "words", "a".repeat(64), "b".repeat(64)])
    assert.ok(!text.includes(leak), leak);
});

test("composite rules: each AND-ed rule is denied alone in its own phase", () => {
  const phase = (id) => PHASES.find((p) => p.id === id);
  const register = { rules: ["register", "manifest"], path: "admit" },
    pin = { rules: ["comments", "notes"], path: "admit" };
  assert.equal(expectedManagement(register, phase("edit-on+deny:register")), "refuse");
  assert.equal(expectedManagement(register, phase("edit-on+deny:manifest")), "refuse");
  assert.equal(expectedManagement(register, phase("edit-on+deny:notes")), "admit");
  assert.equal(expectedManagement(pin, phase("edit-on+deny:notes")), "refuse");
  assert.equal(expectedManagement(pin, phase("edit-on+deny:comments")), "refuse");
  assert.equal(expectedManagement(pin, phase("edit-on+deny:emphasis")), "admit");
  // `register` needs `manifest` (ADR 0013): a row that checks only register is refused when manifest is denied.
  assert.equal(expectedManagement({ rules: ["register"], path: "admit" }, phase("edit-on+deny:manifest")), "refuse");
  assert.ok(phaseRuns(phase("edit-on+deny:manifest"), register) && !phaseRuns(phase("edit-on+deny:manifest"), pin));
  assert.ok(PHASES.slice(0, 4).every((p) => phaseRuns(p, pin)));
});

test("the §1 expectations: who may write what, under which switch and rule", () => {
  const edit = { capability: "edit", rules: ["diagrams"], path: "admit" },
    comment = { capability: "comment", rules: ["comments"], path: "admit" };
  assert.equal(expectedHttp(edit, "grant-cookie", ON_ALLOW), "admit");
  assert.equal(expectedHttp(edit, "owner-cookie", ON_ALLOW), "admit");
  for (const column of ["none", "grant-bearer", "owner-path", "owner-bearer", "revoked-cookie", "revoked-bearer"])
    assert.equal(expectedHttp(edit, column, ON_ALLOW), "refuse", column);
  assert.equal(expectedHttp(edit, "grant-cookie", OFF_ALLOW), "refuse");
  assert.equal(expectedHttp(edit, "grant-cookie", ON_DENY), "refuse");
  assert.equal(expectedHttp(comment, "grant-bearer", OFF_ALLOW), "admit");
  assert.equal(expectedHttp(comment, "grant-bearer", ON_DENY), "refuse");
  assert.equal(expectedHttp({ ...edit, path: "refuse" }, "grant-cookie", ON_ALLOW), "refuse");
  assert.equal(expectedManagement({ rules: ["diagrams"], path: "admit" }, OFF_ALLOW), "admit"); // agents are not bound by the person's edit switch
  assert.equal(expectedManagement({ rules: ["diagrams"], path: "admit" }, ON_DENY), "refuse");
  assert.equal(expectedManagement({ rules: [], path: "admit" }, ON_DENY), "admit");
  assert.equal(expectedManagement({ capability: "person", rules: [], path: "refuse" }, ON_ALLOW), "refuse");
  // Archive/show as built: any Bearer a bare 404; a cookie archives while edit is on. The service token in the
  // path (retired in 0.15.0) is no credential: a bare 404 too.
  const lifecycle = { capability: "lifecycle", rules: [], path: "admit" };
  for (const column of ["grant-cookie", "owner-cookie"])
    assert.equal(expectedHttp(lifecycle, column, ON_ALLOW), "admit", column);
  for (const column of ["grant-bearer", "owner-bearer", "owner-path"]) {
    assert.equal(expectedHttp(lifecycle, column, ON_ALLOW), "refuse", column);
    assert.equal(expectedHttpCode(lifecycle, column, "refuse"), "bare_404", column);
  }
  assert.equal(expectedHttp(lifecycle, "grant-cookie", OFF_ALLOW), "refuse");
  assert.equal(expectedHttp({ capability: "settings", rules: [], path: "admit" }, "owner-cookie", ON_ALLOW), "refuse");
  assert.throws(() => expectedHttp({ capability: "unknown", rules: [], path: "admit" }, "owner-cookie", ON_ALLOW));
});

test("snapshots hash a link's own text, never what it points at", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-eg3-snap-"));
  try {
    mkdirSync(join(dir, "out"));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "out", "canary"), "a");
    symlinkSync(join(dir, "out", "canary"), join(dir, "in", "link"));
    const before = snapshot([
      ["project", join(dir, "in")],
      ["canary", join(dir, "out")],
    ]);
    writeFileSync(join(dir, "out", "canary"), "b");
    assert.deepEqual(
      changedPaths(
        before,
        snapshot([
          ["project", join(dir, "in")],
          ["canary", join(dir, "out")],
        ]),
      ),
      ["canary:canary"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// One throwaway sandbox for the live runs, brought down at the end.
const NAME = `eg3-t${randomBytes(3).toString("hex")}`;
after(async () => {
  const { down, readRecord } = await import("../sandbox.mjs");
  if (readRecord(NAME) !== null) await down({ name: NAME });
});
// The full-matrix known pass runs for tens of minutes (its own timeout is an hour). A run stopped from outside never
// reaches after(): the test runner, sent SIGTERM, kills this file's process before any handler of ours runs, and its
// sandbox stayed up. A guard process holds a pipe from this one and brings the sandbox down when the pipe closes,
// however this process ends (a clean end too, after after(): `down` of a sandbox already down does nothing).
const SANDBOX_CLI = fileURLToPath(new URL("../sandbox.mjs", import.meta.url));
const guard = spawn(
  process.execPath,
  [
    "-e",
    `process.stdin.resume();process.stdin.on("close",()=>{require("node:child_process").spawnSync(process.execPath,[process.argv[1],"down","--name",process.argv[2]],{stdio:"ignore",timeout:60000});process.exit(0);});`,
    SANDBOX_CLI,
    NAME,
  ],
  { stdio: ["pipe", "ignore", "ignore"], detached: true },
);
guard.unref();
guard.stdin.unref?.();
const live = (options) =>
  run({ name: NAME, keep: true, out: mkdtempSync(join(tmpdir(), "archer-eg3-out-")), ...options });
const kinds = (report) => [...new Set(report.summary.mismatches.flatMap((m) => m.mismatches))].sort();

const COMMENTS_DENIED = ["edit-on+deny", "edit-off+deny", "edit-on+deny:comments"];

test("known pass: every cell of the full matrix is as §1 says, with an effect control per cell", {
  timeout: 3_600_000,
}, async () => {
  const { report, dir } = await live({});
  const { totals } = report.summary;
  assert.deepEqual(report.summary.mismatches, [], `mismatches (see ${dir})`);
  assert.deepEqual(report.summary.notEvaluatedCells, [], `cells whose prepare was not consumed (X-21; see ${dir})`);
  // PD-1 fixed: a reportActivity refused where comments are denied changes nothing, delivery state included.
  for (const phase of COMMENTS_DENIED)
    assert.ok(
      report.cells.some(
        (c) =>
          c.surface === "socket" &&
          c.row === "reportActivity" &&
          c.phase === phase &&
          !c.admitted &&
          c.verdict === "pass",
      ),
      `reportActivity ${phase}`,
    );
  assert.ok(totals.cells > 1000, `cells ${totals.cells}`);
  for (const surface of ["http", "cli", "mcp", "socket", "http-management"])
    assert.ok(report.summary.bySurface[surface]?.cells > 0, surface);
  for (const phase of PHASES) assert.ok(report.summary.byPhase[phase.id]?.cells > 0, phase.id);
  // Every cell has an expectation; every ADMITTED cell shows its effect (none passes on status alone); every refused cell shows none.
  for (const cell of report.cells) {
    const where = `${cell.surface} ${cell.row} ${cell.column} ${cell.phase}`;
    assert.ok(["admit", "refuse"].includes(cell.expected), where);
    assert.equal(cell.control, cell.admitted ? "positive" : "negative", where);
  }
  // The rows the reviewers named are crossed, allow-effect and deny-control both.
  const crossed = (surface, row) => {
    const cs = report.cells.filter((c) => c.surface === surface && c.row === row);
    return cs.some((c) => c.control === "positive") && cs.some((c) => c.control === "negative");
  };
  for (const row of [
    "comment-reply",
    "comment-patch",
    "comment-delete",
    "comment-resolve",
    "comment-dismiss",
    "highlight-clear",
    "draft-save",
    "draft-discard",
    "draft-send",
    "change-withdraw",
    "listener-pin",
    "listener-launch",
    "selection",
    "walkthrough-position",
    "comment-unpinned-embedded",
  ])
    assert.ok(crossed("http", row), `http ${row}`);
  for (const surface of ["cli", "mcp"])
    for (const row of ["resolve-comment", "register-inside", "comment-unpinned-embedded", "emphasis-unpinned-embedded"])
      assert.ok(crossed(surface, row), `${surface} ${row}`);
  assert.ok(crossed("http", "comment-submit"), "http comment-submit");
  // Delivery: admitted in every phase with the answer delivered; the read mark only where comments are allowed.
  for (const row of ["waitMessage", "inbox-agent", "inbox-all"]) {
    const cs = report.cells.filter((c) => c.surface === "socket" && c.row === row);
    assert.ok(cs.length === 5 && cs.every((c) => c.control === "positive"), `socket ${row}`);
    for (const c of cs)
      assert.equal(
        c.changed.includes("project:.archer/diagrams/flow.comments.json"),
        row !== "inbox-all" && !COMMENTS_DENIED.includes(c.phase),
        `${row} ${c.phase}`,
      );
  }
  assert.ok(
    report.cells.some((c) => c.row === "reportActivity" && c.phase === "edit-on+allow" && c.control === "positive"),
  );
  for (const row of [
    "settings-put-account",
    "settings-put-project",
    "project-settings-patch",
    "highlight-delete-method",
  ])
    assert.ok(
      report.cells.filter((c) => c.row === row).every((c) => c.control === "negative"),
      row,
    );
  // Composite rules: each side of register ∧ manifest and comments/emphasis ∧ notes is denied alone and refuses.
  for (const [row, phases] of [
    ["register-inside", ["edit-on+deny:register", "edit-on+deny:manifest"]],
    ["comment-unpinned-embedded", ["edit-on+deny:comments", "edit-on+deny:notes"]],
    ["emphasis-unpinned-embedded", ["edit-on+deny:emphasis", "edit-on+deny:notes"]],
  ])
    for (const phase of phases)
      assert.ok(
        report.cells.some((c) => c.row === row && c.phase === phase && !c.admitted && c.control === "negative"),
        `${row} ${phase}`,
      );
  // ... and with every rule allowed the same rows are admitted with their effect, so the refusals above come from the one rule denied.
  for (const row of ["register-inside", "comment-unpinned-embedded", "emphasis-unpinned-embedded"])
    assert.ok(
      report.cells.some((c) => c.row === row && c.phase === "edit-on+allow" && c.control === "positive"),
      `${row} admitted when all rules allow`,
    );
  // What did not run says why.
  assert.ok(
    report.notEvaluated.length > 0 &&
      report.notEvaluated.every((n) => typeof n.reason === "string" && n.reason.length > 20),
  );
  // Each admitting credential column, and each door, has at least one positive control (the rubric's "a positive
  // control per column"); the retired service token path admits nothing, so it has none.
  for (const column of ["grant-cookie", "grant-bearer", "owner-cookie"])
    assert.ok(
      report.cells.some((c) => c.surface === "http" && c.column === column && c.control === "positive"),
      column,
    );
  for (const surface of ["cli", "mcp", "socket"])
    assert.ok(
      report.cells.some((c) => c.surface === surface && c.control === "positive"),
      surface,
    );
});

test("seeded: a write rule the product does not apply is reported as over-admits that wrote", {
  timeout: 600_000,
}, async () => {
  const { report } = await live({
    seed: "rule-not-applied:comments",
    phases: ["edit-on+deny"],
    only: "^(http|mcp|cli) (comment-(view|note)|reply)$",
  });
  assert.deepEqual(kinds(report), ["over-admit"]);
  const rows = new Set(report.summary.mismatches.map((m) => `${m.surface} ${m.row}`));
  assert.deepEqual([...rows].sort(), [
    "cli comment-note",
    "cli comment-view",
    "cli reply",
    "http comment-note",
    "http comment-view",
    "mcp comment-note",
    "mcp comment-view",
    "mcp reply",
  ]);
  assert.ok(
    report.summary.mismatches.every((m) => m.changed.length > 0),
    "each over-admit changed a file",
  );
  // The columns that may never comment are still refused under the seed.
  assert.ok(
    report.cells
      .filter((c) => ["none", "revoked-cookie", "revoked-bearer", "owner-bearer"].includes(c.column))
      .every((c) => c.verdict === "pass"),
  );
});

test("seeded: a refusal that changed only private service state is reported (the lifecycle record)", {
  timeout: 600_000,
}, async () => {
  const { report } = await live({
    seed: "refused-with-state-change",
    phases: ["edit-on+allow", "edit-off+allow"],
    only: "^http archive-project$",
    transports: [],
  });
  assert.deepEqual(kinds(report), ["refused-with-effect"]);
  // With edit off every column is refused, and the record exists by then (the edit-on cookies archived): each is reported.
  const off = report.cells.filter((c) => c.phase === "edit-off+allow");
  assert.equal(off.length, 8);
  assert.ok(off.every((c) => c.verdict === "mismatch" && c.changed.includes("state:runtime/project-lifecycle.json")));
  assert.ok(
    report.summary.mismatches.every((m) => !m.admitted && m.changed.every((p) => p.startsWith("state:"))),
    "only state changed",
  );
});

test("seeded: an edit switch the product does not apply is reported on the cookie columns only", {
  timeout: 600_000,
}, async () => {
  const { report } = await live({
    seed: "edit-not-applied",
    phases: ["edit-off+allow"],
    only: "^http (apply-standalone|publish-inside|archive-project)$",
    transports: [],
  });
  assert.deepEqual(kinds(report), ["over-admit"]);
  const seen = new Set(report.summary.mismatches.map((m) => `${m.row} ${m.column}`));
  for (const row of ["apply-standalone", "publish-inside"])
    for (const column of ["grant-cookie", "owner-cookie"]) assert.ok(seen.has(`${row} ${column}`), `${row} ${column}`);
  assert.ok(seen.has("archive-project grant-cookie"));
  assert.ok(
    report.summary.mismatches.every((m) => ["grant-cookie", "owner-cookie", "grant-bearer"].includes(m.column)),
  );
});

test("seeded: a refusal that still writes, and an admission whose write is undone, are both reported", {
  timeout: 600_000,
}, async () => {
  const phantom = await live({
    seed: "phantom-write:comment-outside",
    phases: ["edit-on+allow"],
    only: "^(http|mcp) comment-outside$",
    transports: ["mcp"],
  });
  assert.deepEqual(kinds(phantom.report), ["refused-with-effect"]);
  assert.equal(phantom.report.summary.mismatches.length, phantom.report.summary.totals.cells);
  const lost = await live({
    seed: "lost-write:write-standalone",
    phases: ["edit-on+allow"],
    only: "^(mcp|cli) write-standalone$",
  });
  assert.deepEqual(kinds(lost.report), ["no-effect"]);
  assert.equal(lost.report.summary.mismatches.length, 2);
});

test("seeded (X-20): state changes dressed as housekeeping are reported, never allowed", {
  timeout: 600_000,
}, async () => {
  for (const seed of ["drop-fresh-announcement", "continuity-version", "drop-fresh-agent", "backdate-agent"]) {
    const { report } = await live({
      seed: `housekeeping:${seed}`,
      phases: ["edit-on+allow"],
      only: "^http comment-view$",
      transports: [],
    });
    const refused = report.cells.filter((c) => !c.admitted);
    assert.equal(refused.length, 4, seed);
    assert.ok(
      refused.every(
        (c) =>
          c.verdict === "mismatch" &&
          c.mismatches.join() === "refused-with-effect" &&
          c.refusalStateAllowed.length === 0,
      ),
      seed,
    );
    assert.ok(
      refused.every((c) => c.stateDiff?.length > 0 && c.changed.some((p) => p.startsWith("state:"))),
      `${seed}: each keeps its state diff`,
    );
    assert.ok(
      report.cells.filter((c) => c.admitted).every((c) => c.verdict === "pass"),
      `${seed}: admissions unaffected`,
    );
  }
});

test("setup_network_access in a private network namespace: refusals change nothing; every door's yes rebinds and its off comes back", {
  timeout: 600_000,
}, async (t) => {
  const { netnsProblem, runInNamespace } = await import("../security/network-access-netns.mjs");
  const problem = netnsProblem();
  if (problem !== undefined) {
    t.skip(problem);
    return;
  }
  const result = runInNamespace();
  assert.equal(result.unavailable, undefined, result.unavailable);
  for (const c of result.cells.filter((c) => c.expected === "refuse")) assert.equal(c.verdict, "pass", c.row);
  assert.equal(result.cells.filter((c) => c.expected === "refuse").length, 4);
  // PD-2, PD-3 fixed: each door's yes and off pass on the one try (terminal and CLI, in-process MCP, the relay).
  for (const c of result.cells)
    assert.equal(c.verdict, "pass", `${c.surface} ${c.row}: ${c.code ?? ""} ${c.cause ?? ""}`);
  assert.equal(result.cells.filter((c) => c.expected === "admit").length, 6);
  assert.equal(result.relayLater.runningHost, "10.203.0.1");
  assert.equal(result.relayLater.configHost, "10.203.0.1");
  // After the run's reset the service is back on loopback (and every service started there ends with the namespace).
  assert.equal(result.reset.runningHost, "127.0.0.1");
});

test("lifecycle: stop_service on its own sandbox and handover on this one each end their service (runs last)", {
  timeout: 600_000,
}, async () => {
  const { report } = await live({ lifecycle: true, phases: [], only: "^socket handover$", transports: [] });
  const rows = report.cells.map((c) => `${c.surface} ${c.row} ${c.control}`).sort();
  assert.deepEqual(rows, ["cli stop_service positive", "socket handover positive"]);
});
