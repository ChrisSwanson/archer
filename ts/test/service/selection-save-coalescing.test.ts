// A reader dragging a selection posts many; their saves coalesce (refactor slice c5): 50 selection posts
// in about 100 ms make at most two atomic saves (each one fsync), where a durable save of each made 50.
import { dirname } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { DEFER_MS } from "../../src/service/project-state/persister.ts";
import { AccountStateStore } from "../../src/state/account.ts";
import { cleanUp, project, tempDir } from "./support.ts";

const syncs = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fsyncSync = ((...args: unknown[]) => {
    syncs.count++;
    return Reflect.apply(actual.fsyncSync, actual, args);
  }) as typeof actual.fsyncSync;
  return { ...actual, fsyncSync };
});

afterEach(cleanUp);

test("50 selection posts in about 100 ms make at most two atomic saves", async () => {
  const store = new AccountStateStore(tempDir());
  const state = await ProjectState.open(
    project(),
    () => "http://localhost/p/",
    () => {},
    { store },
  );
  try {
    state.persist();
    const { presentationId } = state.present("flow");
    const revision = state.envelope("flow")!.revision;
    syncs.count = 0;
    for (let i = 0; i < 50; i++) {
      const outcome = state.postSelection({
        schemaVersion: 1,
        viewId: "flow",
        revision,
        presentationId,
        nodes: [{ id: i % 2 === 0 ? "a" : "b" }],
        edges: [],
      });
      expect(outcome.ok).toBe(true);
      await new Promise((done) => setTimeout(done, 2));
    }
    await new Promise((done) => setTimeout(done, DEFER_MS * 2));
    expect(syncs.count).toBeGreaterThanOrEqual(1);
    expect(syncs.count).toBeLessThanOrEqual(2);
    expect(state.context().selection).toMatchObject({ nodes: [{ id: "b" }] });
    // The save that was made holds the last selection.
    expect(new AccountStateStore(dirname(store.directory)).load(state.root)?.selection).toMatchObject({
      nodes: [{ id: "b" }],
    });
  } finally {
    state.close();
  }
});
