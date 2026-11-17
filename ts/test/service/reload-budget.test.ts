// Performance plan slice 3 (F3's O(V^2), F5): file-operation budgets per operation at 10, 100 and
// 1,000 diagrams. Counts, not timings, so they hold on a loaded host. "Linear" means that ten times
// the project costs at most about twelve times the operations: a quadratic walk costs a hundred.
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import { afterAll, expect, test, vi } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { findProject, listNotes } from "../../src/project/index.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { AccountStateStore } from "../../src/state/account.ts";
import { scaleProject } from "../support/scale-project.ts";
import { cleanUp, tempDir } from "./support.ts";

vi.mock("node:fs", { spy: true });

const SIZES = [10, 100, 1000] as const;
const LINEAR_SLACK = 12;
const NAMES = [
  "openSync",
  "readFileSync",
  "readdirSync",
  "opendirSync",
  "statSync",
  "lstatSync",
  "realpathSync",
  "existsSync",
] as const;
const WALKS = ["readdirSync", "opendirSync"] as const;
const total = (names: readonly (keyof typeof fs)[] = NAMES) =>
  names.reduce((sum, name) => sum + vi.mocked(fs[name] as never as () => unknown).mock.calls.length, 0);
const reset = () => {
  for (const name of NAMES) vi.mocked(fs[name] as never as () => unknown).mockClear();
};
const url = () => "http://localhost/p/";

interface Measure {
  ops: number;
  walks: number;
}
async function measure(run: () => unknown): Promise<Measure> {
  reset();
  await run();
  return { ops: total(), walks: total(WALKS) };
}
function expectLinear(label: string, counts: Record<number, Measure>): void {
  expect(counts[100]!.ops, `${label}: 100 vs 10`).toBeLessThanOrEqual(counts[10]!.ops * LINEAR_SLACK);
  expect(counts[1000]!.ops, `${label}: 1000 vs 100`).toBeLessThanOrEqual(counts[100]!.ops * LINEAR_SLACK);
}

const made: string[] = [];
const roots = new Map<number, string>();
function root(n: number): string {
  let held = roots.get(n);
  if (held === undefined) {
    held = scaleProject({ diagrams: n, notes: n });
    roots.set(n, held);
    made.push(held);
  }
  return held;
}
afterAll(async () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  await cleanUp();
});

test("an unchanged reload, a no-match search and a restore grow at most linearly with the project", async () => {
  const reload: Record<number, Measure> = {},
    search: Record<number, Measure> = {},
    browser: Record<number, Measure> = {},
    restore: Record<number, Measure> = {};
  for (const n of SIZES) {
    const stateDir = tempDir("archer-budget-");
    const store = new AccountStateStore(stateDir);
    const first = await ProjectState.open(root(n), url, () => {}, { store });
    first.persist();
    first.warmReads();
    // A reload drops the memoized reads and schedules their warming a moment later. Hold that timer
    // so the count is the same at every size (a slow reload would otherwise let it fire, and warm twice).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      reload[n] = await measure(async () => {
        await first.reload();
        first.warmReads();
      });
    } finally {
      vi.useRealTimers();
    }
    first.warmReads();
    search[n] = await measure(() => first.search("zzqqxx"));
    browser[n] = await measure(() => first.browserSearch("zzqqxx"));
    first.close();
    let second: ProjectState | undefined;
    restore[n] = await measure(async () => {
      second = await ProjectState.open(root(n), url, () => {}, { store });
    });
    second?.close();
  }
  expectLinear("unchanged reload", reload);
  expectLinear("no-match search", search);
  expectLinear("no-match browser search", browser);
  expectLinear("restore", restore);
  // Absolute walk caps: a second walk of the folder anywhere in a reload would fail here.
  expect(reload[1000]!.walks).toBeLessThanOrEqual(40);
  expect(reload[1000]!.walks).toBe(reload[10]!.walks);
  // A search on warm reads walks nothing: the notes and the catalog are the memoized ones.
  expect(search[100]!.walks).toBe(0);
  expect(browser[100]!.walks).toBe(0);
  // A restore walks the folder a fixed number of times, not once per saved view.
  expect(restore[100]!.walks).toBeLessThanOrEqual(restore[10]!.walks + 12);
}, 240_000);

test("write_diagram walks the folder a fixed number of times and grows at most linearly", async () => {
  const write: Record<number, Measure> = {};
  for (const n of SIZES) {
    const app = createApplication({ cwd: root(n) });
    try {
      const read = (await app.call("read_diagram", { viewId: "d2" })) as unknown as {
        structured: { sourceRevision: string };
      };
      write[n] = await measure(() =>
        app.call("write_diagram", {
          viewId: "d2",
          source: `flowchart LR\n  x${n}[X] e1@--> y[Y]\n`,
          expectedRevision: read.structured.sourceRevision,
        }),
      );
    } finally {
      app.close();
    }
  }
  expectLinear("write_diagram", write);
  expect(write[100]!.walks).toBeLessThanOrEqual(12);
  expect(write[1000]!.walks).toBe(write[10]!.walks);
}, 240_000);

test("listNotes walks the folder once", () => {
  const found = findProject(root(100));
  reset();
  const notes = listNotes(found);
  expect(notes.length).toBeGreaterThan(100);
  expect(total(WALKS)).toBeLessThanOrEqual(4); // one pass: the Archer folder, diagrams/ and notes/ (a second pass would be 6)
});
