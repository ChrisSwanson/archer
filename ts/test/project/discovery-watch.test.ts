import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ProjectWatcher } from "../../src/service/watch.ts";
import { removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);
test("explicit admitted directory subscriptions report external document changes", async () => {
  const root = tempDir({ ".archer/a.md": "old", "docs/deep/a.md": "old" });
  let changes = 0;
  const watcher = new ProjectWatcher(root, join(root, ".archer"), () => changes++, [join(root, "docs/deep")]);
  try {
    writeFileSync(join(root, "docs/deep/a.md"), "new");
    await expect.poll(() => changes, { timeout: 1200 }).toBeGreaterThan(0);
  } finally {
    watcher.close();
  }
});
