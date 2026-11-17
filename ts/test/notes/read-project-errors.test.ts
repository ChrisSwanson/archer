import { symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication, OperationError } from "../../src/application/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test.each(["external-folder", "untrusted-manifest", "unavailable-cwd"] as const)(
  "read_note sanitizes project loading: %s",
  async (kind) => {
    const root = tempDir(),
      outside = tempDir({ "a.md": "private outside source" });
    let cwd = root;
    if (kind === "external-folder") symlinkSync(outside, join(root, ".archer"));
    if (kind === "untrusted-manifest") {
      writeFileSync(join(root, "archer.toml"), "version=1\n");
      chmodSync(join(root, "archer.toml"), 0o666);
    }
    if (kind === "unavailable-cwd") cwd = join(root, "missing");
    const app = createApplication({ cwd });
    try {
      let failure: unknown;
      try {
        await app.call("read_note", { notePath: "a.md" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OperationError);
      const error = failure as OperationError;
      expect(error.data).toMatchObject({ code: "io_failure", reason: "project_unavailable" });
      expect(error.message).toContain("project");
      expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(root);
      expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(outside);
      expect(error.message).not.toMatch(/ENOENT|ELOOP|EACCES/);
    } finally {
      app.close();
    }
  },
);
