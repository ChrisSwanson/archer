import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectState, readText } from "../../src/service/project-state.ts";
import { findProject } from "../../src/project/index.ts";
import { MAX_SOURCE_BYTES } from "../../src/mermaid/limits.ts";
import { AccountStateStore } from "../../src/state/account.ts";
import { cleanUp, FLOW, project, SEQ, tempDir, write } from "./support.ts";

vi.mock("node:fs", { spy: true });

afterEach(cleanUp);

test("declared and derived descriptions survive account-state reopen and unchanged reload", async () => {
  const root = project(),
    stateDir = tempDir("archer-metadata-");
  write(root, ".archer/flow.mmd", `%% description: Declared request path.\n${FLOW}`);
  write(root, ".archer/chat.mmd", `%% A derived conversation.\n${SEQ}`);
  const first = await ProjectState.open(
    root,
    () => "http://localhost/project",
    () => {},
    { store: new AccountStateStore(stateDir) },
  );
  const descriptions = () =>
    expect.arrayContaining([
      expect.objectContaining({ id: "flow", description: "Declared request path.", descriptionFrom: "comment" }),
      expect.objectContaining({ id: "chat", description: "A derived conversation.", descriptionFrom: "derived" }),
    ]);
  expect(first.inventory().views).toEqual(descriptions());
  first.persist();
  expect(new AccountStateStore(stateDir).load(root)?.views).toHaveLength(2);
  first.close();
  const fresh = await ProjectState.open(
    root,
    () => "http://localhost/project",
    () => {},
    { store: new AccountStateStore(stateDir) },
  );
  try {
    expect(fresh.inventory().views).toEqual(descriptions());
    await fresh.reload();
    expect(fresh.inventory().views).toEqual(descriptions());
  } finally {
    fresh.close();
  }
});

test("description source refuses an oversized file before consuming its bytes", () => {
  const root = project();
  write(root, ".archer/large.mmd", "x".repeat(MAX_SOURCE_BYTES + 1));
  const found = findProject(root);
  const read = vi.spyOn(fs, "readFileSync").mockClear();
  const readDescriptor = vi.spyOn(fs, "readSync").mockClear();
  try {
    expect(readText(found, "large.mmd")).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(readDescriptor).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    readDescriptor.mockRestore();
  }
});

test("description source reads the exact size limit and refuses directories and non-UTF-8", () => {
  const root = project();
  write(root, ".archer/exact.mmd", "x".repeat(MAX_SOURCE_BYTES));
  const found = findProject(root);
  expect(readText(found, "exact.mmd")).toBe("x".repeat(MAX_SOURCE_BYTES));
  expect(readText(found, "missing.mmd")).toBeNull();
  fs.mkdirSync(join(root, ".archer/directory.mmd"));
  expect(readText(found, "directory.mmd")).toBeNull();
  fs.writeFileSync(join(root, ".archer/invalid.mmd"), Buffer.from([0xff]));
  expect(readText(found, "invalid.mmd")).toBeNull();
});

test.skipIf(process.platform === "win32")("description source refuses a FIFO without blocking", () => {
  const root = project();
  execFileSync("mkfifo", [join(root, ".archer/pipe.mmd")]);
  const found = findProject(root);
  const read = vi.spyOn(fs, "readSync").mockClear();
  try {
    expect(readText(found, "pipe.mmd")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
