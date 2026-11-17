// The service compiles off its event loop, with a budget per compile (server review S1).

import { afterEach, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { compileInThisThread } from "../../src/mermaid/compile.ts";
import {
  COMPILE_BUDGET_MS,
  CompilePool,
  compileWorkerLocation,
  useCompilePool,
} from "../../src/service/compile-pool.ts";

const pools: CompilePool[] = [];
const releases: (() => void)[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.close();
  for (const release of releases.splice(0)) release();
});
const pool = (options: ConstructorParameters<typeof CompilePool>[0] = {}): CompilePool => {
  const made = new CompilePool(options);
  pools.push(made);
  return made;
};

const SOURCES = [
  "flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n",
  "sequenceDiagram\n  participant a as A\n  a->>a: hi\n",
  "flowchart LR\n  a --> \n",
  'C4Context\n  Person(a, "A")\n',
];

test("the worker is found beside the module and answers what compiling in this thread does", async () => {
  expect(compileWorkerLocation()?.pathname.endsWith("/ts/src/service/compile-worker.ts")).toBe(true);
  const compiler = pool();
  for (const source of SOURCES) expect(await compiler.compile(source)).toEqual(await compileInThisThread(source));
  expect(compiler.threaded).toBe(true);
});

test("a compile past its budget answers compile_timeout, leaves the event loop free, and the next compile gets a fresh worker", async () => {
  const compiler = pool({ workers: 1, budgetMs: 300 });
  await compiler.compile(SOURCES[0]!); // loaded
  // Many flat fragments: linear but slow in Mermaid (a config copy per statement), seconds of work.
  const slow = `sequenceDiagram\n  participant a\n${"loop l\n  a->>a: x\nend\n".repeat(8000)}`;
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 20);
  const started = performance.now();
  const result = await compiler.compile(slow);
  clearInterval(ticker);
  expect(result.model).toBeNull();
  expect(result.diagnostics.map((d) => d.code)).toEqual(["compile_timeout"]);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(ticks).toBeGreaterThan(5);
  expect((await compiler.compile(SOURCES[0]!)).model).not.toBeNull();
}, 30_000);

test("the default budget is ten seconds", () => {
  expect(COMPILE_BUDGET_MS).toBe(10_000);
});

test("without a worker it compiles in this thread", async () => {
  const compiler = pool({ worker: null });
  expect(compiler.threaded).toBe(false);
  expect(await compiler.compile(SOURCES[0]!)).toEqual(await compileInThisThread(SOURCES[0]!));
});

test("a worker that cannot start falls back to this thread", async () => {
  const compiler = pool({ worker: new URL("data:text/javascript,throw new Error('no')") });
  expect((await compiler.compile(SOURCES[0]!)).model).not.toBeNull();
  expect(compiler.threaded).toBe(false);
});

test("closing fails what is queued and running, and every later compile", async () => {
  const compiler = pool({ workers: 1 });
  const pending = compiler.compile(SOURCES[0]!);
  compiler.close();
  await expect(pending).rejects.toThrow(/stopping/);
  await expect(compiler.compile(SOURCES[0]!)).rejects.toThrow(/stopping/);
});

test("useCompilePool routes compile() through the pool until the last user releases it", async () => {
  const first = useCompilePool({ budgetMs: 300 }).release;
  const second = useCompilePool().release;
  releases.push(first, second);
  const slow = `sequenceDiagram\n  participant a\n${"loop l\n  a->>a: x\nend\n".repeat(8000)}`;
  expect((await compile(slow)).diagnostics.map((d) => d.code)).toEqual(["compile_timeout"]);
  first();
  expect((await compile(slow)).diagnostics.map((d) => d.code)).toEqual(["compile_timeout"]);
  second();
  expect((await compile(SOURCES[0]!)).model).not.toBeNull();
}, 60_000);

test("a sole user's stop fails compiles until it releases; then they run in this thread", async () => {
  const use = useCompilePool();
  releases.push(use.release);
  use.stop();
  await expect(compile(SOURCES[0]!)).rejects.toThrow(/stopping/);
  use.release();
  expect((await compile(SOURCES[0]!)).model).not.toBeNull();
});
