import { expect, test, vi } from "vitest";
import { LayoutPool } from "../../src/measurement/pool.ts";
import { measureSnapshot } from "../../src/measurement/index.ts";

// Worker threads load their own modules. Framing on the calling thread must not
// load the production layout engine just to apply viewport arithmetic.
vi.mock("../../src/measurement/load.ts", () => ({
  loadAnalysis: () => {
    throw new Error("Layout engines belong in the worker, not the calling thread");
  },
}));

test("a real worker result can be framed without loading layout engines on the calling thread", async () => {
  const pool = new LayoutPool();
  try {
    const report = await measureSnapshot(pool, {
      viewId: "flow",
      sourceRevision: "captured-source",
      envelope: null,
      diagnostics: [],
      basis: "saved-source",
      compilation: {
        source: "flowchart LR\n a[Client] edge@--> b[API]\n",
        view: { id: "flow", kind: "freeform", title: "Flow", source: "flow.mmd", registration: "ephemeral" },
      },
    });
    expect(report).toMatchObject({ status: "ready", complete: true, viewport: { basis: "desktop-profile" } });
    expect(report.states[0]!.bounds.width).toBeGreaterThan(0);
  } finally {
    pool.close();
  }
});
