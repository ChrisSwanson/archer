import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findProject } from "../../src/project/index.ts";

test("actual project loader retains per-view coverage without changing semantic metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-covers-"));
  try {
    mkdirSync(join(root, ".archer"));
    writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\n a[Client]\n");
    writeFileSync(
      join(root, "archer.toml"),
      'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\ncovers = ["src/**", "README.md"]\n',
    );
    expect(findProject(root).views[0]).toMatchObject({ id: "flow", covers: ["src/**", "README.md"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
