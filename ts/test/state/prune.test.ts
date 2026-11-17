import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AccountStateStore } from "../../src/state/account.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, project, tempDir } from "../service/support.ts";

afterEach(cleanUp);

test("post-commit source pruning cannot refuse or roll back an accepted presentation", async () => {
  const store = new AccountStateStore(tempDir());
  const state = await ProjectState.open(
    project(),
    () => "http://localhost/p/",
    () => {},
    { store },
  );
  state.persist();
  const sourceDir = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
  const events: string[] = [];
  state.subscribe((name) => events.push(name));
  chmodSync(sourceDir, 0o300);
  try {
    // Write and execute permit the commit; listing this optional cleanup directory refuses.
    expect(() => readdirSync(sourceDir)).toThrow();
    expect(() => state.present("flow", "Committed caption")).not.toThrow();
    expect(state.context().presentation).toMatchObject({ annotation: "Committed caption" });
    expect(store.load(state.root)?.presentation).toMatchObject(state.context().presentation!);
    expect(events).toContain("presentation");
  } finally {
    chmodSync(sourceDir, 0o700);
    state.close();
  }
});
