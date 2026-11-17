// api/diagram-source names the model revision of the text it returns: just after a Save the file on disk can be
// newer than the compiled view (the watcher has not reloaded yet), and the page must not be told the new text is
// the old revision (it would read it again once it learns the new one: source-panel journey, release check).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, FLOW2, project } from "./support.ts";

const states: ProjectState[] = [];
afterEach(() => {
  states.splice(0).forEach((state) => state.close());
  cleanUp();
});

test("a source newer than the compiled view is answered with its own model revision, not the old one", async () => {
  const root = project();
  const state = await ProjectState.open(
    root,
    (slug) => `http://127.0.0.1/projects/${slug}/`,
    () => {},
    { restoreState: false },
  );
  states.push(state);
  await state.reload();
  const before = (await state.diagramSource("flow"))!;
  expect(before.modelRevision).toBe(state.envelope("flow")!.revision);
  // A Save writes the file; no reload has run yet.
  writeFileSync(join(root, ".archer/flow.mmd"), FLOW2);
  const after = (await state.diagramSource("flow"))!;
  expect(after.source).toBe(FLOW2);
  expect(after.modelRevision).not.toBe(before.modelRevision);
  expect(after.modelRevision).toBe(state.envelope("flow")!.revision);
});
