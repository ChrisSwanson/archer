import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, unlinkSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoringPresentationStore } from "../../src/authoring/presentation-store.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const rev = (c: string) => "sha256:" + c.repeat(64);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "presentation-"));
  dirs.push(dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  return {
    dir,
    stateDir,
    options: { stateDir, serviceName: "test", assertOwner: () => {} },
    projectRoot: join(dir, "project"),
    targetRevision: rev("a"),
    sourceRevision: rev("b"),
    expectedRevision: null,
    positions: { node: { x: 12, y: -20 } },
  };
}
test("persists positions across owners, exact project scope and idempotent stale-layout CAS", () => {
  const f = setup(),
    { projectRoot, targetRevision, sourceRevision, expectedRevision, positions } = f,
    input = { projectRoot, targetRevision, sourceRevision, expectedRevision, positions },
    store = new AuthoringPresentationStore(f.options),
    saved = store.put(input);
  expect(saved).toMatchObject({
    sourceRevision: f.sourceRevision,
    positions: f.positions,
    revision: expect.stringMatching(/^sha256:/),
  });
  expect(new AuthoringPresentationStore(f.options).get(f.projectRoot, f.targetRevision)).toEqual(saved);
  expect(store.get(f.projectRoot + "other", f.targetRevision)).toBeNull();
  expect(store.put(input)).toEqual(saved);
  expect(() => store.put({ ...input, positions: { node: { x: 99, y: 20 } } })).toThrow(/conflict/);
});

test("publication uncertainty latches this owner; reopen observes durable latest layout", () => {
  const f = setup(),
    { projectRoot, targetRevision, sourceRevision, expectedRevision, positions } = f,
    input = { projectRoot, targetRevision, sourceRevision, expectedRevision, positions };
  let fault = false;
  const store = new AuthoringPresentationStore({
    ...f.options,
    onCommitStep: (step) => {
      if (fault && step === "after_index_publish") throw new Error("publication fault");
    },
  });
  fault = true;
  expect(() => store.put(input)).toThrow("publication fault");
  expect(() => store.get(projectRoot, targetRevision)).toThrow(/unavailable/);
  expect(new AuthoringPresentationStore(f.options).get(projectRoot, targetRevision)?.positions).toEqual(positions);
});
test("missing initialization authority refuses after restart, including an empty initialized store", () => {
  const f = setup();
  new AuthoringPresentationStore(f.options);
  unlinkSync(join(f.stateDir, "runtime/authoring-presentations/index.json"));
  expect(() => new AuthoringPresentationStore(f.options)).toThrow(/missing/);
});
test("ownership on every call, clones and external authority replacement are enforced", () => {
  const f = setup();
  let owned = true;
  const store = new AuthoringPresentationStore({
    ...f.options,
    assertOwner: () => {
      if (!owned) throw new Error("owner lost");
    },
  });
  owned = false;
  expect(() => store.get(f.projectRoot, f.targetRevision)).toThrow("owner lost");
  owned = true;
  writeFileSync(join(f.stateDir, "runtime/authoring-presentations/index.json"), "{}", { mode: 0o600 });
  expect(() => store.get(f.projectRoot, f.targetRevision)).toThrow(/authority/);
  expect(() => store.get(f.projectRoot, f.targetRevision)).toThrow(/unavailable/);
});
test("private index/symlink and missing marker corruption refuse", () => {
  for (const mode of ["public", "symlink", "marker", "marker-content"]) {
    const f = setup();
    new AuthoringPresentationStore(f.options);
    const index = join(f.stateDir, "runtime/authoring-presentations/index.json");
    if (mode === "public") chmodSync(index, 0o644);
    if (mode === "symlink") {
      unlinkSync(index);
      symlinkSync("/dev/null", index);
    }
    if (mode === "marker-content")
      writeFileSync(join(f.stateDir, "runtime/authoring-presentations/snapshots", "0".repeat(64)), "", { mode: 0o600 });
    if (mode === "marker") rmSync(join(f.stateDir, "runtime/authoring-presentations/snapshots"), { recursive: true });
    expect(() => new AuthoringPresentationStore(f.options)).toThrow();
  }
});

test("layout CAS advances on source identity and returned positions cannot mutate authority", () => {
  const f = setup(),
    { projectRoot, targetRevision, sourceRevision, expectedRevision, positions } = f,
    input = { projectRoot, targetRevision, sourceRevision, expectedRevision, positions },
    store = new AuthoringPresentationStore(f.options),
    first = store.put(input);
  first.positions.node!.x = 999;
  expect(store.get(projectRoot, targetRevision)?.positions.node?.x).toBe(12);
  const advanced = store.put({ ...input, sourceRevision: rev("c"), expectedRevision: first.revision });
  expect(advanced.revision).not.toBe(first.revision);
  expect(() =>
    store.put({ ...input, positions: { node: { x: 500, y: 2 } }, expectedRevision: first.revision }),
  ).toThrow(/conflict/);
});
