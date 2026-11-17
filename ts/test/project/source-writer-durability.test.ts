import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tempDir, removeTempDirs, FLOW } from "./support.ts";
const injection = vi.hoisted(() => ({
  failDirectory: false,
  shortWrites: false,
  zeroWrites: false,
  driftPath: "",
  driftBytes: "",
  removeAfterRename: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // The confined seam names entries relative to an open directory (/proc/self/fd/<fd>/<name>): match on the place it names.
  const named = (path: string) => {
    const m = /^\/proc\/self\/fd\/(\d+)\/(.*)$/su.exec(path);
    if (!m) return path;
    try {
      return `${actual.readlinkSync(`/proc/self/fd/${m[1]}`)}/${m[2]}`;
    } catch {
      return path;
    }
  };
  return {
    ...actual,
    writeSync(fd: number, data: string | Uint8Array, ...args: unknown[]) {
      // Leave single-byte bakery tickets working so create reaches its own source publication.
      if (injection.zeroWrites && (typeof data === "string" ? Buffer.byteLength(data) : (args[1] as number)) > 1)
        return 0;
      if (injection.shortWrites) {
        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        const offset = typeof data === "string" ? 0 : (args[0] as number);
        const length = typeof data === "string" ? bytes.length : (args[1] as number);
        return actual.writeSync(fd, bytes, offset, Math.min(2, length), null);
      }
      return (actual.writeSync as (...args: unknown[]) => number)(fd, data, ...args);
    },
    linkSync(from: string, to: string) {
      actual.linkSync(from, to);
      if (named(to) === injection.driftPath) actual.writeFileSync(to, injection.driftBytes);
    },
    renameSync(from: string, to: string) {
      actual.renameSync(from, to);
      if (named(to) === injection.driftPath) {
        if (injection.removeAfterRename) actual.unlinkSync(to);
        else actual.writeFileSync(to, injection.driftBytes);
      }
    },
    fsyncSync(fd: number) {
      if (injection.failDirectory && actual.fstatSync(fd).isDirectory())
        throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
      actual.fsyncSync(fd);
    },
  };
});
import { findProject, writeConfined } from "../../src/project/project.ts";
import { applySource, createConfined } from "../../src/project/source-writer.ts";
import { revisionOf } from "../../src/project/envelope.ts";
afterEach(() => {
  Object.assign(injection, {
    failDirectory: false,
    shortWrites: false,
    zeroWrites: false,
    driftPath: "",
    driftBytes: "",
    removeAfterRename: false,
  });
  removeTempDirs();
});
test("post-rename directory-sync failure is uncertain and preserves the applied bytes without rollback", async () => {
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
  injection.failDirectory = true;
  const next = FLOW.replace("Client", "Changed");
  await expect(
    applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, { syncDirectory: true }),
  ).rejects.toMatchObject({ code: "write_uncertain" });
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(next);
  // Legacy default never invokes directory durability, retaining its compatibility contract.
  expect(() => writeConfined(project, "a.mmd", FLOW, "diagrams")).not.toThrow();
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
});
test("exclusive create reports uncertain durability with the new file present, never replays over it", () => {
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
  injection.failDirectory = true;
  expect(() => createConfined(project, "diagrams/new.mmd", FLOW, { syncDirectory: true })).toThrowError(
    expect.objectContaining({ code: "write_uncertain" }),
  );
  expect(readFileSync(join(project.folder, "diagrams/new.mmd"), "utf8")).toBe(FLOW);
  expect(() => createConfined(project, "diagrams/new.mmd", "retry")).toThrowError(
    expect.objectContaining({ code: "EEXIST" }),
  );
  expect(readFileSync(join(project.folder, "diagrams/new.mmd"), "utf8")).toBe(FLOW);
});

test("partial OS writes publish exact complete UTF-8 for replacement and exclusive creation", () => {
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
  const exact = "\uFEFF" + FLOW.replace("Client", "🐦 café").replace(/\n/g, "\r\n");
  injection.shortWrites = true;
  writeConfined(project, "a.mmd", exact, "diagrams");
  expect(readFileSync(join(project.folder, "a.mmd"))).toEqual(Buffer.from(exact));
  createConfined(project, "diagrams/new.mmd", exact);
  expect(readFileSync(join(project.folder, "diagrams/new.mmd"))).toEqual(Buffer.from(exact));
});
test("zero-progress writes abort before publication without clobbering existing bytes", () => {
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
  injection.zeroWrites = true;
  expect(() => writeConfined(project, "a.mmd", "changed", "diagrams")).toThrow();
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
  expect(() => createConfined(project, "diagrams/new.mmd", FLOW)).toThrow();
  expect(() => readFileSync(join(project.folder, "diagrams/new.mmd"))).toThrowError(
    expect.objectContaining({ code: "ENOENT" }),
  );
});
for (const removed of [false, true])
  test(`post-publication standalone ${removed ? "read failure" : "byte drift"} is uncertain and never rolled back`, async () => {
    const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
    injection.driftPath = join(project.folder, "a.mmd");
    injection.driftBytes = "external writer";
    injection.removeAfterRename = removed;
    await expect(
      applySource(
        project,
        { kind: "view", viewId: "a" },
        revisionOf(Buffer.from(FLOW)),
        FLOW.replace("Client", "Changed"),
      ),
    ).rejects.toMatchObject({ code: "write_uncertain" });
    if (removed)
      expect(() => readFileSync(injection.driftPath)).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    else expect(readFileSync(injection.driftPath, "utf8")).toBe("external writer");
  });
test("post-publication embedded-body drift is uncertain without rollback or a fabricated written revision", async () => {
  const note = "Prose\n```mermaid\n%% archer-id: x\n" + FLOW + "```\nTail";
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/n.md": note }));
  const { readEmbedded } = await import("../../src/notes/embedded.ts");
  const read = readEmbedded(project, "n.md#x")!;
  injection.driftPath = join(project.folder, "n.md");
  injection.driftBytes = note.replace("Client", "External");
  await expect(
    applySource(
      project,
      { kind: "embedded", address: read.address },
      read.sourceRevision,
      FLOW.replace("Client", "Changed"),
    ),
  ).rejects.toMatchObject({ code: "write_uncertain" });
  expect(readFileSync(injection.driftPath, "utf8")).toBe(injection.driftBytes);
});

test("exclusive create also observes post-link drift and leaves the external bytes for reconciliation", () => {
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
  injection.driftPath = join(project.folder, "diagrams/new.mmd");
  injection.driftBytes = "external after link";
  expect(() => createConfined(project, "diagrams/new.mmd", FLOW)).toThrowError(
    expect.objectContaining({ code: "write_uncertain" }),
  );
  expect(readFileSync(injection.driftPath, "utf8")).toBe(injection.driftBytes);
});
