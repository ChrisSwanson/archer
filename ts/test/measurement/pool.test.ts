import { afterEach, expect, test } from "vitest";
import { LayoutPool, useLayoutPool } from "../../src/measurement/pool.ts";
import { compileDiagramBytes } from "../../src/project/envelope.ts";
const pools: LayoutPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.close();
});
const poolOf = (options: ConstructorParameters<typeof LayoutPool>[0] = {}) => {
  const pool = new LayoutPool(options);
  pools.push(pool);
  return pool;
};
async function envelope(label = "Client") {
  const result = await compileDiagramBytes(
    { path: "flow.mmd" },
    Buffer.from(`flowchart LR\n a[${label}] edge@--> b[API]\n`),
  );
  expect(result.envelope).not.toBeNull();
  return result.envelope!;
}

test("one worker is reused for different revisions while identical work deduplicates and caches", async () => {
  const pool = poolOf();
  const first = { envelope: await envelope() };
  const pending = pool.request(first);
  expect(pool.request(first)).toBe(pending);
  expect(await pending).toMatchObject({ status: "ready", complete: true });
  await pool.request({ envelope: await envelope("A different client") });
  expect(pool.stats.started).toBe(1);
  expect((await pool.request(first)).status).toBe("ready");
  expect(pool.stats.started).toBe(1);
});

test("hard deadline terminates actual worker and later work can start", async () => {
  const pool = poolOf({ workerMs: 1 });
  expect(await pool.request({ envelope: await envelope() })).toMatchObject({
    status: "unavailable",
    reason: "budget_exceeded",
    complete: false,
  });
  await expect.poll(() => pool.stats.terminated).toBe(1);
  expect(pool.stats.active).toBe(0);
  expect(await pool.request({ envelope: await envelope("Next source") })).toMatchObject({ reason: "budget_exceeded" });
  await expect.poll(() => pool.stats.terminated).toBe(2);
});

test("queue saturates, newer automatic revisions supersede queued reports, cancellation stops work", async () => {
  const pool = poolOf({ queue: 1 });
  const abort = new AbortController();
  const env = await envelope();
  const running = pool.request({ envelope: env, signal: abort.signal });
  const old = pool.request({ envelope: { ...env, revision: "old" }, automatic: "project/view" });
  const next = pool.request({ envelope: { ...env, revision: "new" }, automatic: "project/view" });
  expect(await old).toMatchObject({ reason: "superseded" });
  const full = await pool.request({ envelope: { ...env, revision: "overflow" }, automatic: "another/view" });
  expect(full).toMatchObject({ reason: "queue_full", complete: false });
  abort.abort();
  expect(await running).toMatchObject({ reason: "cancelled" });
  await expect.poll(() => pool.stats.terminated).toBe(1);
  pool.close();
  expect(await next).toMatchObject({ reason: "stopped" });
});

test("cache is bounded and a missing worker never falls back onto the event loop", async () => {
  const pool = poolOf({ cacheEntries: 1 });
  expect((await pool.request({ envelope: await envelope() })).status).toBe("ready");
  expect((await pool.request({ envelope: await envelope("Second") })).status).toBe("ready");
  expect(pool.stats.cached).toBe(1);
  expect(pool.stats.cacheBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  const missing = poolOf({ worker: new URL("file:///nonexistent-layout-worker.js") });
  expect(await missing.request({ envelope: await envelope() })).toMatchObject({
    status: "unavailable",
    reason: "worker_failed",
  });
});

test("cancellation after a streamed production state retains truthful partial geometry and stops remaining ELK work", async () => {
  const pool = poolOf();
  const compiled = await compileDiagramBytes(
    { path: "grouped.mmd" },
    Buffer.from("flowchart LR\n subgraph group[Detail]\n a[Client]\n b[API]\n a edge@--> b\n end\n"),
  );
  expect(compiled.envelope).not.toBeNull();
  const abort = new AbortController();
  const result = await pool.request({
    envelope: compiled.envelope!,
    states: [{ mode: "nested", open: [] }, { mode: "full" }],
    signal: abort.signal,
    onState: () => abort.abort(),
  });
  expect(result).toMatchObject({
    status: "partial",
    complete: false,
    reason: "cancelled",
    unmeasuredStates: [{ stateIndex: 1, reason: "cancelled" }],
  });
  expect(result.geometry?.states).toHaveLength(1);
  await expect.poll(() => pool.stats.terminated).toBe(1);
  expect(pool.stats.cached).toBe(0);
});

test("explicit source compilation and geometry share the cancellable worker budget", async () => {
  const pool = poolOf();
  const result = await pool.request({
    envelope: null,
    compilation: {
      source: "flowchart LR\n a[Client] edge@--> b[API]\n",
      view: { id: "flow", kind: "freeform", title: "Flow", source: "flow.mmd", registration: "ephemeral" },
    },
  });
  expect(result).toMatchObject({
    status: "ready",
    complete: true,
    compiled: { envelope: { view: { id: "flow" } }, diagnostics: [] },
  });
  const invalid = await pool.request({
    envelope: null,
    compilation: {
      source: "flowchart LR\n a[Client] --> b[API]\n",
      view: { id: "flow", kind: "freeform", title: "Flow", source: "flow.mmd", registration: "ephemeral" },
    },
  });
  expect(invalid).toMatchObject({
    status: "unavailable",
    complete: false,
    reason: "does_not_compile",
    compiled: { envelope: null },
  });
  expect(invalid.compiled?.diagnostics.length).toBeGreaterThan(0);
});

test("cache isolates geometry and compiled metadata from the first caller and every cache hit", async () => {
  const pool = poolOf();
  const request = {
    envelope: null,
    compilation: {
      source: "flowchart LR\n a[Client] edge@--> b[API]\n",
      view: {
        id: "flow",
        kind: "freeform" as const,
        title: "Flow",
        source: "flow.mmd",
        registration: "ephemeral" as const,
      },
    },
  };
  const first = await pool.request(request);
  expect(first.status).toBe("ready");
  const expected = structuredClone(first);
  // Readonly is a TypeScript convenience; callers can still mutate received objects at runtime.
  Object.assign(first.geometry!.states[0]!.bounds, { width: -1 });
  Object.assign(first.compiled!.envelope!.view, { title: "Mutated first answer" });
  const hit = await pool.request(request);
  expect(hit).toEqual(expected);
  Object.assign(hit.geometry!.states[0]!.bounds, { width: -2 });
  Object.assign(hit.compiled!.envelope!.view, { title: "Mutated cached answer" });
  expect(await pool.request(request)).toEqual(expected);
});

test("shared layout leases release once and close only after the final user", async () => {
  const first = useLayoutPool(),
    second = useLayoutPool();
  try {
    expect(first.pool).toBe(second.pool);
    first.release();
    first.release();
    const request = { envelope: await envelope() };
    expect((await second.pool.request(request)).status).toBe("ready");
    second.release();
    expect(await second.pool.request(request)).toMatchObject({ reason: "stopped" });
    const next = useLayoutPool();
    try {
      expect(next.pool).not.toBe(first.pool);
      expect((await next.pool.request(request)).status).toBe("ready");
    } finally {
      next.release();
    }
  } finally {
    first.release();
    second.release();
  }
});

test("same source with different compilation metadata cannot reuse stale compiled envelopes", async () => {
  const pool = poolOf();
  const compilation = {
    source: "flowchart LR\n a[Client] edge@--> b[API]\n",
    view: {
      id: "flow",
      kind: "freeform" as const,
      title: "Original",
      source: "flow.mmd",
      registration: "ephemeral" as const,
    },
  };
  const first = await pool.request({ envelope: null, compilation });
  expect(first.compiled!.envelope!.view.title).toBe("Original");
  const changed = await pool.request({
    envelope: null,
    compilation: { ...compilation, view: { ...compilation.view, title: "Renamed" } },
  });
  expect(changed.compiled!.envelope!.view.title).toBe("Renamed");
  expect(pool.stats.cached).toBe(2);
});

test("a worker's cold start does not count against the layout budget, only against the caller's deadline", async () => {
  // Loading the worker takes 1.5 s, longer than the 1 s layout budget; the layout itself is quick.
  const pool = poolOf({ worker: new URL("./fixtures/cold-start-worker.ts", import.meta.url), workerMs: 1_000 });
  expect(await pool.request({ envelope: await envelope() })).toMatchObject({ status: "ready", complete: true });
  // The caller's own deadline still bounds the whole wait, start-up included.
  const late = poolOf({ worker: new URL("./fixtures/cold-start-worker.ts", import.meta.url), workerMs: 1_000 });
  expect(await late.request({ envelope: await envelope(), deadlineMs: 500 })).toMatchObject({
    status: "unavailable",
    reason: "budget_exceeded",
  });
}, 15_000);
