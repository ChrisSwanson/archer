// A transaction that fails to commit puts back everything it touched, the walkthroughs' counts and
// moved set included (ADR 0034 §6): a refused reload must not leave a count the next one does not know of.
import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject } from "../../src/project/index.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { AccountStateStore } from "../../src/state/account.ts";
import { WalkthroughsStore } from "../../src/walkthroughs/store.ts";
import { cleanUp, FLOW2, project, tempDir, write } from "./support.ts";

afterEach(cleanUp);

test("a reload that cannot be saved leaves the walkthrough counts and the announced file state as they were", async () => {
  const root = project();
  const store = new AccountStateStore(tempDir());
  const state = await ProjectState.open(
    root,
    () => "http://localhost/p/",
    () => {},
    { store },
  );
  try {
    state.persist();
    const count = () => state.inventory().views.find((v) => v.id === "flow")?.walkthroughs;
    expect(count()).toBeUndefined();
    new WalkthroughsStore(findProject(root)).write(
      { viewId: "flow", path: "flow.walkthroughs.json" },
      {
        walkthrough: {
          id: "ask",
          title: "Asking",
          steps: [{ title: "Ask", kind: "sends", what: "A request.", edges: [{ id: "e1", source: "a", target: "b" }] }],
        },
        modelRevision: `sha256:${"a".repeat(64)}`,
        author: "agent",
      },
    );
    const sources = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
    rmSync(sources, { recursive: true });
    symlinkSync(tempDir(), sources);
    // A reload with nothing new to record saves nothing, so the source changes too: that is what cannot be saved.
    write(root, ".archer/flow.mmd", FLOW2);
    await expect(state.reload()).rejects.toThrow();
    expect(count()).toBeUndefined();
    // Put the store right: the next reload sees the file as news and counts it.
    rmSync(sources);
    mkdirSync(sources, { mode: 0o700 });
    await state.reload();
    expect(count()).toBe(1);
  } finally {
    state.close();
  }
});

test("a reload with nothing to save does not need the store", async () => {
  const root = project();
  const store = new AccountStateStore(tempDir());
  const state = await ProjectState.open(
    root,
    () => "http://localhost/p/",
    () => {},
    { store },
  );
  try {
    state.persist();
    const sources = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
    rmSync(sources, { recursive: true });
    symlinkSync(tempDir(), sources);
    await expect(state.reload()).resolves.toBeUndefined();
  } finally {
    state.close();
  }
});
