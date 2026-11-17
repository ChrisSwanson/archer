// Performance plan slice 2 (F1, F4): a project past the 256-view recovery bound keeps working, and a
// selection or emphasis change costs a constant number of file operations, whatever the project size.
import * as fs from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { AccountStateStore } from "../../src/state/account.ts";
import { scaleProject } from "../support/scale-project.ts";
import { cleanUp, tempDir } from "./support.ts";

vi.mock("node:fs", { spy: true });

const states: ProjectState[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanUp();
});

const url = () => "http://localhost/p/";
async function open(root: string, store: AccountStateStore): Promise<ProjectState> {
  const state = await ProjectState.open(root, url, () => {}, { store });
  states.push(state);
  return state;
}
function generated(diagrams: number): string {
  const root = scaleProject({ diagrams, notes: 0 });
  roots.push(root);
  return root;
}
const select = (state: ProjectState, viewId: string, node: string) => {
  const shown = state.context().presentation!;
  return state.postSelection({
    schemaVersion: 1,
    viewId,
    revision: shown.revision,
    presentationId: shown.presentationId,
    nodes: [{ id: node }],
    edges: [],
  });
};
const emphasis = (viewId: string, node: string) => [
  { id: "look", viewId, groups: [{ id: "g", label: "g", style: "highlight", nodes: [node] }] },
];
/** The operations a selection pays for the files: every open, read and directory listing. */
const CALLS = ["openSync", "readFileSync", "readSync", "readdirSync", "opendirSync"] as const;
const calls = () => CALLS.reduce((sum, name) => sum + vi.mocked(fs[name]).mock.calls.length, 0);
const resetCalls = () => {
  for (const name of CALLS) vi.mocked(fs[name]).mockClear();
};

test("a 257-view project attaches, presents, selects and sets emphasis, and recovery keeps the presented view", async () => {
  const root = generated(257),
    stateDir = tempDir("archer-cap-");
  const state = await open(root, new AccountStateStore(stateDir));
  expect(state.inventory().views).toHaveLength(257);
  expect(() => state.persist()).not.toThrow();
  // Sorted last, so only the relevance rule (not file order) can keep it.
  state.present("d99");
  expect(select(state, "d99", "a99")).toMatchObject({ ok: true });
  state.setEmphasis("d256", emphasis("d256", "a256"));
  const saved = new AccountStateStore(stateDir).load(root)!;
  expect(saved.views.length).toBeLessThanOrEqual(256);
  expect(saved.views.map((v) => v.id)).toEqual(expect.arrayContaining(["d99", "d256"]));
  state.close();
  const again = await open(root, new AccountStateStore(stateDir));
  expect(again.context().presentation?.viewId).toBe("d99");
  expect(again.context().selection?.viewId).toBe("d99");
  expect(again.listEmphases("d256").views[0]?.emphases).toHaveLength(1);
}, 90_000);

test("a selection or an emphasis change opens and reads a constant number of files, however many views", async () => {
  const cost: Record<number, { selection: number; emphasis: number }> = {};
  for (const n of [10, 100]) {
    const state = await open(generated(n), new AccountStateStore(tempDir("archer-cap-")));
    state.persist();
    state.present("d3");
    select(state, "d3", "a3"); // The first save of the process verifies what it has not seen.
    resetCalls();
    select(state, "d3", "b3");
    const selection = calls();
    resetCalls();
    state.setEmphasis("d3", emphasis("d3", "a3"));
    cost[n] = { selection, emphasis: calls() };
  }
  expect(cost[100]!.selection).toBeLessThanOrEqual(cost[10]!.selection);
  expect(cost[100]!.emphasis).toBeLessThanOrEqual(cost[10]!.emphasis);
  expect(cost[100]!.selection).toBeLessThanOrEqual(12);
}, 60_000);

test("an unchanged record costs no file operation at all", async () => {
  const state = await open(generated(20), new AccountStateStore(tempDir("archer-cap-")));
  state.persist();
  resetCalls();
  state.persist();
  expect(calls()).toBe(0);
});

test("a blob corrupted after its commit is still caught when the project is restored", async () => {
  const root = generated(5),
    stateDir = tempDir("archer-cap-");
  const store = new AccountStateStore(stateDir);
  const state = await open(root, store);
  state.persist();
  state.present("d1");
  const sources = join(store.directory, fs.readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
  const blob = join(sources, fs.readdirSync(sources)[0]!);
  fs.chmodSync(blob, 0o600);
  writeFileSync(blob, "flowchart LR\n  tampered --> blob\n");
  state.close();
  await expect(ProjectState.open(root, url, () => {}, { store: new AccountStateStore(stateDir) })).rejects.toThrow(
    /digest|corrupt/i,
  );
});

test("a blob deleted after its commit is written again by the next save, and the project restores", async () => {
  const root = generated(5),
    stateDir = tempDir("archer-cap-");
  const store = new AccountStateStore(stateDir);
  const state = await open(root, store);
  state.persist();
  state.present("d1");
  const sources = join(store.directory, fs.readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
  for (const name of fs.readdirSync(sources)) rmSync(join(sources, name));
  select(state, "d1", "a1"); // The record changes, so the missing blobs are noticed and rewritten.
  // A selection's save is deferred (c5); closing saves it at once.
  state.close();
  expect(fs.readdirSync(sources).length).toBeGreaterThan(0);
  const again = await open(root, new AccountStateStore(stateDir));
  expect(again.context().presentation?.viewId).toBe("d1");
});

test("views that never compiled do not cost the others their history or emphasis", async () => {
  const root = generated(257),
    stateDir = tempDir("archer-cap-");
  // Two broken views leave 255 recoverable: under the bound, so nothing may be dropped.
  fs.writeFileSync(join(root, ".archer/diagrams/d0.mmd"), "flowchart LR\n  a[A] --> b[B]\n");
  fs.writeFileSync(join(root, ".archer/diagrams/d1.mmd"), "flowchart LR\n  a[A] --> b[B]\n");
  const state = await open(root, new AccountStateStore(stateDir));
  state.present("d256", "kept caption");
  state.setEmphasis("d256", emphasis("d256", "a256"));
  const saved = new AccountStateStore(stateDir).load(root)!;
  expect(saved.views).toHaveLength(255);
  expect(saved.captions.map(([id]) => id)).toContain("d256");
  expect(saved.emphases).toHaveLength(1);
}, 90_000);
