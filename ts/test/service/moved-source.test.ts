// flows-r1 (S4): a registered diagram whose file is gone. The inventory flags it, and when another
// diagram file now holds exactly the bytes it last compiled from, names that one as where it moved.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, FLOW, FLOW2, project, write } from "./support.ts";

afterEach(cleanUp);

const open = (root: string) =>
  ProjectState.open(
    root,
    () => "http://localhost/project",
    () => {},
  );
const entry = (state: ProjectState, id: string) => state.inventory().views.find((v) => v.id === id);

test("a registered view whose file is gone says so, and names no new place without one", async () => {
  const root = project();
  const state = await open(root);
  try {
    expect(entry(state, "flow")).not.toHaveProperty("sourceMissing");
    rmSync(join(root, ".archer/flow.mmd"));
    await state.reload();
    expect(entry(state, "flow")).toMatchObject({ sourceMissing: true });
    expect(entry(state, "flow")).not.toHaveProperty("movedTo");
    // Different bytes elsewhere are not this diagram.
    write(root, ".archer/flow-other.mmd", FLOW2);
    await state.reload();
    expect(entry(state, "flow")).not.toHaveProperty("movedTo");
  } finally {
    state.close();
  }
});

test("a registered view whose bytes now live in another file names that file as where it moved", async () => {
  const root = project();
  const state = await open(root);
  try {
    rmSync(join(root, ".archer/flow.mmd"));
    write(root, ".archer/flow-v2.mmd", FLOW);
    await state.reload();
    expect(entry(state, "flow")).toMatchObject({
      sourceMissing: true,
      movedTo: { id: "flow-v2", sourcePath: "flow-v2.mmd" },
    });
    // The file coming back clears both.
    write(root, ".archer/flow.mmd", FLOW);
    await state.reload();
    expect(entry(state, "flow")).not.toHaveProperty("sourceMissing");
    expect(entry(state, "flow")).not.toHaveProperty("movedTo");
  } finally {
    state.close();
  }
});
