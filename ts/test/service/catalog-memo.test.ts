// The project catalog (api/browser-projects) is memoized until a file event, not re-walked per request:
// the watcher reports changes (forgetReads), and the reads a page load needs are made again in the
// background once a burst of events settles, so the request that follows finds them memoized.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectState, READ_MEMO_MS, READ_WARM_DELAY_MS } from "../../src/service/project-state.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

const walks = vi.hoisted(() => ({ count: 0, files: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const counted = ((...args: unknown[]) => {
    walks.count++;
    return Reflect.apply(actual.opendirSync, actual, args);
  }) as typeof actual.opendirSync;
  const read = ((...args: unknown[]) => {
    walks.files++;
    return Reflect.apply(actual.readFileSync, actual, args);
  }) as typeof actual.readFileSync;
  // The confined seam reads a bounded file from its descriptor (readSync): that is a file read too.
  const readFromDescriptor = ((...args: unknown[]) => {
    walks.files++;
    return Reflect.apply(actual.readSync, actual, args);
  }) as typeof actual.readSync;
  return { ...actual, opendirSync: counted, readFileSync: read, readSync: readFromDescriptor };
});

const states: ProjectState[] = [];
afterEach(() => {
  states.splice(0).forEach((state) => state.close());
  vi.restoreAllMocks();
  removeTempDirs();
});

async function opened(): Promise<{ root: string; state: ProjectState }> {
  const root = tempDir({ ".archer/notes/a.md": "# A\n", ".archer/diagrams/flow.mmd": "flowchart LR\n  a --> b\n" });
  const state = await ProjectState.open(
    root,
    (slug) => `http://127.0.0.1/projects/${slug}/`,
    () => {},
    { restoreState: false },
  );
  states.push(state);
  return { root, state };
}

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("the catalog is reused well past five seconds while no file event says it changed", async () => {
  const { state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + 30_000);
  walks.count = 0;
  state.documentCatalog();
  expect(walks.count).toBe(0);
});

test("past READ_MEMO_MS a request answers from the held catalog, and the catalog is walked again off the request path", async () => {
  const { root, state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  writeFileSync(join(root, ".archer/notes/unreported.md"), "# Unreported\n");
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + READ_MEMO_MS + 1);
  walks.count = 0;
  // The request does not wait for a walk (O6: ~300 ms at scale M, once a minute).
  expect(state.documentCatalog().documents.map((entry) => entry.source.path)).not.toContain(
    ".archer/notes/unreported.md",
  );
  expect(walks.count).toBe(0);
  // The walk follows on its own turn, bounding what a change no watcher reported can hide.
  await vi.waitFor(() => expect(walks.count).toBeGreaterThan(0));
  await settle(10);
  walks.count = 0;
  expect(state.documentCatalog().documents.map((entry) => entry.source.path)).toContain(".archer/notes/unreported.md");
  expect(walks.count).toBe(0);
});

test("each expired read is made again in its own turn, so other requests run between them", async () => {
  const { state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + READ_MEMO_MS + 1);
  state.documentCatalog();
  state.allNotes();
  walks.count = walks.files = 0;
  // Directories walked and files read by the end of each turn of the event loop while the two reads are made again.
  const seen: number[] = [walks.count + walks.files];
  await new Promise<void>((done) => {
    const tick = (): void => {
      seen.push(walks.count + walks.files);
      if (seen.length < 6) setImmediate(tick);
      else done();
    };
    setImmediate(tick);
  });
  // None during the requests; then the catalog in one turn and the notes in a later one.
  expect(seen[0]).toBe(0);
  expect(new Set(seen).size).toBeGreaterThan(2);
});

test("after a file event the catalog is read again in the background, so the next request does not walk", async () => {
  const { root, state } = await opened();
  writeFileSync(join(root, ".archer/notes/b.md"), "# B\n");
  state.forgetReads(); // what the watcher does on an event
  await settle(READ_WARM_DELAY_MS * 4);
  walks.count = 0;
  const paths = state.documentCatalog().documents.map((entry) => entry.source.path);
  expect(walks.count).toBe(0);
  expect(paths).toContain(".archer/notes/b.md");
  expect(state.allNotes().notes.map((note) => note.path)).toContain("notes/b.md");
});

test("after a file event the background reads are made one per turn, so requests run between them", async () => {
  const { state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  state.forgetReads();
  walks.count = walks.files = 0;
  // Directories walked and files read by the end of each turn, until the warm has long finished.
  const seen: number[] = [],
    until = performance.now() + READ_WARM_DELAY_MS * 4;
  await new Promise<void>((done) => {
    const tick = (): void => {
      seen.push(walks.count + walks.files);
      if (performance.now() < until) setImmediate(tick);
      else done();
    };
    setImmediate(tick);
  });
  expect(seen[0]).toBe(0);
  const steps = seen.filter((value, index) => index > 0 && value !== seen[index - 1]).length;
  expect(steps).toBeGreaterThan(1);
});

test("configuring the discovery settings the reads were made under keeps them", async () => {
  const { state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  const held = state.documentCatalog();
  walks.count = 0;
  state.configureDiscovery(() => ({ roots: [".archer"], exclude: [] }));
  expect(state.documentCatalog()).toBe(held);
  expect(walks.count).toBe(0);
  // Other settings are other reads.
  state.configureDiscovery(() => ({ roots: [".archer", "docs"], exclude: [] }));
  expect(state.documentCatalog()).not.toBe(held);
});

test("a reload commits in phases on separate turns: views, then comments and notes, then the catalog (O12)", async () => {
  const { root, state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  writeFileSync(join(root, ".archer/diagrams/flow.mmd"), "flowchart LR\n  a --> c\n");
  writeFileSync(join(root, ".archer/notes/later.md"), "# Later\n");
  let turn = 0,
    running = true;
  const tick = (): void => {
    turn++;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const at: Record<string, number> = {};
  state.subscribe((event) => {
    at[event] ??= turn;
  });
  await state.reload();
  running = false;
  // Each phase publishes as it commits: the inventory with the views, notes after the comments and notes
  // pass, documents with the catalog. No single turn does all three.
  expect(at).toMatchObject({ inventory: expect.any(Number), notes: expect.any(Number), documents: expect.any(Number) });
  expect(at["notes"]!).toBeGreaterThan(at["inventory"]!);
  expect(at["documents"]!).toBeGreaterThan(at["notes"]!);
});

test("a burst during a reload's phases folds into one more reload, and the result has every change", async () => {
  const { root, state } = await opened();
  await settle(READ_WARM_DELAY_MS * 3);
  writeFileSync(join(root, ".archer/notes/first.md"), "# First\n");
  const reloads: Promise<void>[] = [state.reload()];
  // Between the phases (the views are committed, the notes and catalog not yet): more files, more reloads.
  let wrote = false;
  state.subscribe(() => {
    if (wrote) return;
    wrote = true;
    writeFileSync(join(root, ".archer/notes/second.md"), "# Second\n");
    writeFileSync(join(root, ".archer/diagrams/flow.mmd"), "flowchart LR\n  a --> late\n");
    state.forgetReads();
    reloads.push(state.reload(), state.reload());
  });
  await reloads[0];
  await Promise.all(reloads);
  expect(wrote).toBe(true);
  const notes = state.allNotes().notes.map((note) => note.path);
  expect(notes).toEqual(expect.arrayContaining(["notes/first.md", "notes/second.md"]));
  expect(state.documentCatalog().documents.map((entry) => entry.source.path)).toEqual(
    expect.arrayContaining([".archer/notes/first.md", ".archer/notes/second.md"]),
  );
  expect(JSON.stringify(state.inventory())).toContain("flow");
});

test("a closed state warms nothing", async () => {
  const { state } = await opened();
  state.forgetReads();
  state.close();
  walks.count = 0;
  await settle(READ_WARM_DELAY_MS * 3);
  expect(walks.count).toBe(0);
});

test("a reload of many diagrams lets other work run between compiles", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++)
    files[`.archer/d${i}.mmd`] = `flowchart LR\n  a${i}[A ${i}]\n  b${i}[B ${i}]\n  a${i} e${i}@--> b${i}\n`;
  const root = tempDir(files);
  const state = await ProjectState.open(
    root,
    (slug) => `http://127.0.0.1/projects/${slug}/`,
    () => {},
    { restoreState: false },
  );
  states.push(state);
  let ticks = 0,
    done = false;
  const timer = setInterval(() => {
    if (!done) ticks++;
  }, 1);
  try {
    for (let i = 0; i < 40; i++)
      writeFileSync(
        join(root, `.archer/d${i}.mmd`),
        `flowchart LR\n  a${i}[Changed ${i}]\n  b${i}[B]\n  a${i} e${i}@--> b${i}\n`,
      );
    await state.reload();
    done = true;
  } finally {
    clearInterval(timer);
  }
  expect(ticks).toBeGreaterThan(0);
});
