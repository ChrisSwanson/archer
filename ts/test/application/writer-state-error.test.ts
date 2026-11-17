import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { findProject, revisionOf } from "../../src/project/index.ts";
import { withSourceWriterLock } from "../../src/project/source-writer.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

const applications: ReturnType<typeof createApplication>[] = [];
afterEach(() => {
  for (const app of applications.splice(0)) app.close();
  vi.unstubAllEnvs();
  removeTempDirs();
});

test("a private writer-state setup failure names that directory without blaming the writable diagram", async () => {
  const cwd = tempDir({ ".archer/flow.mmd": FLOW });
  const blocker = join(cwd, "not-a-directory");
  writeFileSync(blocker, "regular file");
  const writers = join(blocker, "writers");
  vi.stubEnv("ARCHER_WRITERS_DIR", writers);
  const app = createApplication({ cwd });
  applications.push(app);
  let failure: unknown;
  try {
    await app.call("write_diagram", {
      viewId: "flow",
      source: FLOW.replace("Client", "Updated client"),
      expectedRevision: revisionOf(Buffer.from(FLOW)),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    data: { code: "io_failure" },
    message: expect.stringContaining(`private writer-state directory ${writers}`),
  });
  expect((failure as Error).message).toContain("ARCHER_WRITERS_DIR");
  expect((failure as Error).message).not.toContain("diagram are writable");
  expect(readFileSync(join(cwd, ".archer/flow.mmd"), "utf8")).toBe(FLOW);
});

test("filesystem errors from the protected operation remain file errors", () => {
  const cwd = tempDir({ ".archer/flow.mmd": FLOW });
  vi.stubEnv("ARCHER_WRITERS_DIR", join(cwd, "writers"));
  const missing = join(cwd, "absent");
  expect(() => withSourceWriterLock(findProject(cwd), "flow.mmd", () => readFileSync(missing))).toThrowError(
    expect.objectContaining({ code: "ENOENT", path: missing }),
  );
});
