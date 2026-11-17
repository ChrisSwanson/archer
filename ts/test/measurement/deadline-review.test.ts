import { expect, test } from "vitest";
import { LayoutPool } from "../../src/measurement/pool.ts";
import { compileDiagramBytes } from "../../src/project/envelope.ts";
import { reviewLayout, measureSnapshot } from "../../src/measurement/index.ts";

test("a pending persistent review explicitly requires measurement and that measurement completes", async () => {
  const compiled = await compileDiagramBytes(
    { path: "flow.mmd" },
    Buffer.from("flowchart LR\n a[Client] calls@--> b[API]\n"),
  );
  expect(compiled.envelope).not.toBeNull();
  const pool = new LayoutPool({ worker: new URL("./fixtures/slow-start-worker.ts", import.meta.url) });
  const snapshot = {
    viewId: "flow",
    sourceRevision: compiled.envelope!.revision,
    envelope: compiled.envelope,
    diagnostics: [],
    basis: "saved-source" as const,
  };
  try {
    const pending = await reviewLayout(pool, snapshot, "session/flow", new Set());
    expect(pending.review).toMatchObject({
      status: "pending",
      inspect: { tool: "measure_diagram", arguments: { viewId: "flow" } },
    });
    expect(pending.text).toContain("Run measure_diagram with the inspect arguments");
    expect(pending.text).toContain("it is not delivered automatically");
    const measured = await measureSnapshot(pool, snapshot);
    expect(measured).toMatchObject({ status: "ready", complete: true, states: [{ mode: "full" }] });
  } finally {
    pool.close();
  }
});

test("a deduplicated explicit caller retains its shorter remaining operation deadline", async () => {
  const compiled = await compileDiagramBytes(
    { path: "deadline.mmd" },
    Buffer.from("flowchart LR\n a[Client] calls@--> b[API]\n"),
  );
  expect(compiled.envelope).not.toBeNull();
  const pool = new LayoutPool();
  try {
    const original = pool.request({ envelope: compiled.envelope, deadlineMs: 5_000 });
    const shortened = pool.request({ envelope: compiled.envelope, deadlineMs: 1 });
    expect(await shortened).toMatchObject({ status: "unavailable", reason: "budget_exceeded", complete: false });
    await original;
    await expect.poll(() => pool.stats.terminated).toBe(1);
  } finally {
    pool.close();
  }
});
