// node --test tools/devkit/test/flows-state.test.mjs
// The user-flows collectors' predicates (tools/devkit/harness/flows-state.mjs) on a known pass and a known fail,
// without a browser; the browser-level demonstration is tools/devkit/harness/flows-prove.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAULTS,
  activeFaults,
  compareState,
  flowsActions,
  g2Verdict,
  g5Verdict,
  sha256,
} from "../harness/flows-state.mjs";
import { changedLines, onlyLabelChanged } from "../journeys/flows/state-lib.mjs";

const base = "flowchart LR\n  a[Client]\n  b[API]\n  a calls@-->|HTTP| b\n";

test("G1: a read-back equal to the capture passes; a lost draft, a moved target or a new base fails", () => {
  const captured = {
    text: "x",
    target: { project: "journeys", path: "diagrams/flow.mmd", draftId: "drf_1" },
    baseRevision: sha256(base),
  };
  assert.deepEqual(compareState(captured, structuredClone(captured)), []);
  assert.deepEqual(
    compareState(captured, { ...captured, text: "" }).map((d) => d.field),
    ["text"],
  );
  assert.deepEqual(
    compareState(captured, { ...captured, target: { ...captured.target, path: "diagrams/other.mmd" } }).map(
      (d) => d.field,
    ),
    ["target"],
  );
  assert.deepEqual(
    compareState(captured, { ...captured, baseRevision: null }).map((d) => d.field),
    ["baseRevision"],
  );
  // A comment has no base revision in its request: compared on text and anchor only.
  assert.deepEqual(
    compareState(
      { text: "q", target: { anchor: "Node: Customer" } },
      { text: "q", target: { anchor: "Node: Customer" }, baseRevision: "x" },
      ["text", "target"],
    ),
    [],
  );
});

test("G2: refused, bytes unchanged, other writer on disk and the person's version kept passes; an applied stale save fails", () => {
  const other = base.replace("b[API]", "b[API by agent]"),
    person = base.replace("a[Client]", 'a["Mine"]');
  const pass = g2Verdict({
    answer: { outcome: "conflict", conflict: { kind: "source" } },
    sent: true,
    diskBeforeSave: other,
    diskAfterSave: other,
    otherWriter: other,
    personSource: person,
    editorSource: person,
  });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.refusal, { outcome: "conflict", kind: "source" });
  assert.equal(pass.kept, "editor");
  const overwrite = g2Verdict({
    answer: { outcome: "applied" },
    sent: true,
    diskBeforeSave: other,
    diskAfterSave: person,
    otherWriter: other,
    personSource: person,
    editorSource: null,
  });
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.problems.length, 4);
  // Refused by the page before sending counts as refused; a copy keeps the person's version.
  assert.equal(
    g2Verdict({
      answer: null,
      sent: false,
      diskBeforeSave: other,
      diskAfterSave: other,
      otherWriter: other,
      personSource: person,
      editorSource: null,
      copies: [person],
    }).ok,
    true,
  );
});

test("G5: exactly the expected number of effects", () => {
  assert.equal(g5Verdict({ effects: 1, expected: 1, label: "x" }).ok, true);
  assert.match(g5Verdict({ effects: 2, expected: 1, label: "comment" }).problem, /2 durable effect/);
  assert.equal(g5Verdict({ effects: 0, expected: 1, label: "x" }).ok, false);
});

test("J6: only the renamed label's line may change (Archer quotes the new label)", () => {
  assert.equal(
    onlyLabelChanged(base, base.replace("a[Client]", 'a["Customer"]'), { node: "a", from: "Client", to: "Customer" })
      .ok,
    true,
  );
  assert.equal(
    onlyLabelChanged(base, base.replace("a[Client]", "a[Customer]"), { node: "a", from: "Client", to: "Customer" }).ok,
    true,
  );
  assert.equal(
    onlyLabelChanged(base, base.replace("a[Client]", 'a["Customer"]').replace("b[API]", "b[Api]"), {
      node: "a",
      from: "Client",
      to: "Customer",
    }).ok,
    false,
  );
  assert.equal(
    onlyLabelChanged(base, base.replace("a[Client]", 'a["Customer"]').replace("|HTTP|", "|HTTPS|"), {
      node: "a",
      from: "Client",
      to: "Customer",
    }).ok,
    false,
  );
  assert.deepEqual(changedLines("a\nb", "a\nc"), [{ line: 2, before: "b", after: "c" }]);
});

test("seeded faults: named in ARCHER_FLOWS_FAULT; an unknown name is refused", () => {
  assert.deepEqual([...activeFaults({})], []);
  assert.deepEqual(
    [...activeFaults({ ARCHER_FLOWS_FAULT: "drop-draft, repeat-effect" })],
    ["drop-draft", "repeat-effect"],
  );
  assert.throws(() => activeFaults({ ARCHER_FLOWS_FAULT: "drop-everything" }), /known faults/);
  assert.ok(FAULTS.includes("skip-revision-check"));
});

test("a check's verdict is its own, never replaced by an `ok` in its details (O150)", () => {
  const run = {};
  const ui = flowsActions({
    page: {},
    context: {},
    sandbox: { name: "x", origin: "http://h" },
    step: async (t, f) => f(),
    expect: () => {},
    run,
    faults: new Set(),
  });
  const verdict = g5Verdict({ effects: 1, expected: 1, label: "x" });
  assert.equal(verdict.ok, true);
  assert.equal(ui.flowCheck("G5", "b", verdict.ok && false, { ...verdict }), false);
  assert.equal(run.flowState.checks[0].ok, false);
  assert.equal(run.flowState.checks[0].gate, "G5");
});
