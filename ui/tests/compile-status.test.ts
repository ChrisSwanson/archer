// The compile-status payload (ADR 0010): what the page accepts, what it
// refuses, and how a payload becomes the state the notice is drawn from.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCompileStatus,
  failureFor,
  forgetSavedFailure,
  parseCompileStatus,
  problemPosition,
  sourceIsMissing,
  type CompileFailure,
} from "../src/app/compile-status";

const REVISION_A = `sha256:${"a".repeat(64)}`;
const REVISION_B = `sha256:${"b".repeat(64)}`;

/** One failure exactly as the server spells it. */
function wireFailure(viewId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    viewId,
    sourceRevision: REVISION_B,
    lastValidRevision: REVISION_A,
    diagnostics: [
      {
        code: "expected_label",
        message: "expected a label inside delimiters",
        span: { start: { line: 2, column: 9 }, end: { line: 2, column: 10 } },
      },
    ],
    ...overrides,
  };
}

const payload = (...failures: unknown[]) => ({ schemaVersion: 1, failures });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCompileStatus", () => {
  it("reads a failure with each problem's code, message, line and column", () => {
    expect(parseCompileStatus(payload(wireFailure("graph")))).toEqual([
      {
        viewId: "graph",
        sourceRevision: REVISION_B,
        lastValidRevision: REVISION_A,
        problems: [{ code: "expected_label", message: "expected a label inside delimiters", line: 2, column: 9 }],
      },
    ]);
  });

  it("reads nothing failing as an empty list, which is an answer and not a fault", () => {
    expect(parseCompileStatus(payload())).toEqual([]);
  });

  it("keeps a problem that has no position, without inventing one", () => {
    const parsed = parseCompileStatus(
      payload(wireFailure("graph", { diagnostics: [{ code: "source_missing", message: "gone" }] })),
    );
    expect(parsed?.[0].problems).toEqual([{ code: "source_missing", message: "gone" }]);
  });

  // flows-r1 claude-204: a registered view whose file was deleted has no bytes, so the service sends
  // sourceRevision null. Dropping that failure left the stale drawing looking current, with Edit.
  it("reads a view whose file is gone: no source revision, the problem source_missing", () => {
    const parsed = parseCompileStatus(
      payload(
        wireFailure("graph", {
          sourceRevision: null,
          diagnostics: [{ code: "source_missing", message: "diagrams/graph.mmd cannot be read" }],
        }),
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].sourceRevision).toBeNull();
    expect(sourceIsMissing(parsed![0])).toBe(true);
  });

  it("reads a view that has never compiled: there is no last valid revision", () => {
    const parsed = parseCompileStatus(payload(wireFailure("graph", { lastValidRevision: null })));
    expect(parsed?.[0].lastValidRevision).toBeNull();
  });

  it("refuses any other schemaVersion whole, and says so", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseCompileStatus({ schemaVersion: 2, failures: [wireFailure("graph")] })).toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("schemaVersion");
  });

  it.each([null, undefined, 3, "failures", [], {}, { schemaVersion: 1 }, { schemaVersion: 1, failures: {} }])(
    "refuses %j, which is not a compile status",
    (value) => {
      expect(parseCompileStatus(value)).toBeUndefined();
    },
  );

  it("drops one malformed failure and keeps the rest", () => {
    const parsed = parseCompileStatus(
      payload(
        wireFailure("graph"),
        { viewId: 7 },
        wireFailure("broken", { sourceRevision: undefined }),
        wireFailure("no-list", { diagnostics: "none" }),
        wireFailure("sequence"),
      ),
    );
    expect(parsed?.map((failure) => failure.viewId)).toEqual(["graph", "sequence"]);
  });

  it("drops one malformed problem and keeps the failure it belongs to", () => {
    const parsed = parseCompileStatus(
      payload(
        wireFailure("graph", {
          diagnostics: [
            { code: "a", message: "first" },
            { code: "b" },
            "not a diagnostic",
            { code: "c", message: "third", span: { start: { line: "2", column: 1 } } },
          ],
        }),
      ),
    );
    // The third keeps its message and loses a position that was not one.
    expect(parsed?.[0].problems).toEqual([
      { code: "a", message: "first" },
      { code: "c", message: "third" },
    ]);
  });
});

describe("applyCompileStatus", () => {
  const graph: CompileFailure = {
    viewId: "graph",
    sourceRevision: REVISION_B,
    lastValidRevision: REVISION_A,
    problems: [{ code: "expected_label", message: "expected a label", line: 2, column: 9 }],
  };

  it("replaces what was held: a payload is the whole state", () => {
    const sequence = { ...graph, viewId: "sequence" };
    expect(applyCompileStatus([graph], [sequence])).toEqual([sequence]);
    expect(applyCompileStatus([graph], [])).toEqual([]);
  });

  it("keeps the held state's identity when a payload says the same thing", () => {
    // `App` hands this to React Flow's parent on every render. A new array
    // for an unchanged status is a re-render the canvas did nothing to earn.
    const held = [graph];
    const same = [{ ...graph, problems: [{ ...graph.problems[0] }] }];
    expect(applyCompileStatus(held, same)).toBe(held);
  });

  it("notices a change in the problems of a view that is still failing", () => {
    const held = [graph];
    const moved = [{ ...graph, sourceRevision: `sha256:${"c".repeat(64)}`, problems: [] }];
    expect(applyCompileStatus(held, moved)).toBe(moved);
  });
});

describe("failureFor", () => {
  const failures: CompileFailure[] = [
    { viewId: "graph", sourceRevision: REVISION_B, lastValidRevision: REVISION_A, problems: [] },
  ];

  it("finds the failure of the view on screen", () => {
    expect(failureFor(failures, "graph")).toBe(failures[0]);
  });

  it("finds nothing for a view that compiles, or for no view", () => {
    expect(failureFor(failures, "sequence")).toBeUndefined();
    expect(failureFor(failures, null)).toBeUndefined();
  });
});

describe("problemPosition", () => {
  it("names the line and the column", () => {
    expect(problemPosition({ code: "c", message: "m", line: 12, column: 3 })).toBe("Line 12, column 3");
  });

  it("says nothing for a problem with no position", () => {
    expect(problemPosition({ code: "c", message: "m" })).toBe("");
  });
});

// O157: the person saved this view's file from the editor (Save, or Save as a new diagram here over a missing file).
// The service accepted a source that compiles, so the failure held from before is stale until the service says
// otherwise: the reading page the editor hands back to must not say the file is gone.
describe("forgetSavedFailure", () => {
  const gone: CompileFailure = {
    viewId: "flow",
    sourceRevision: null,
    lastValidRevision: REVISION_A,
    problems: [{ code: "source_missing", message: "missing" }],
  };
  const other: CompileFailure = { ...gone, viewId: "seq" };

  it("drops the saved view's failure and keeps the others", () => {
    expect(forgetSavedFailure([gone, other], "flow")).toEqual([other]);
  });

  it("keeps the held state's identity when the saved view had none", () => {
    const held = [other];
    expect(forgetSavedFailure(held, "flow")).toBe(held);
    expect(forgetSavedFailure(held, null)).toBe(held);
  });
});
