import { afterEach, expect, test, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findProject } from "../../src/project/project.ts";
import { applySource, createConfined, withSourceWriterLock } from "../../src/project/source-writer.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { FLOW, tempDir, removeTempDirs } from "./support.ts";

const fault = vi.hoisted(() => ({ mode: "", folder: "", fds: new Map<number, string>(), hits: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const ioError = (code = "EIO") => Object.assign(new Error(`injected source syscall ${code}`), { code });
  // The confined seam names entries relative to an open directory (/proc/self/fd/<fd>/<name>): match on the place it names.
  const named = (path: string) => {
    const m = /^\/proc\/self\/fd\/(\d+)\/(.*)$/su.exec(path);
    if (!m) return path;
    try {
      const dir = actual.readlinkSync(`/proc/self/fd/${m[1]}`);
      return m[2] === "." ? dir : `${dir}/${m[2]}`;
    } catch {
      return path;
    }
  };
  const temporary = (raw: string) => {
    const path = named(raw);
    return (
      path.startsWith(fault.folder + "/") &&
      /^\.(?:a|new)\.mmd\.[0-9a-f]+\.tmp$/u.test(path.slice(path.lastIndexOf("/") + 1))
    );
  };
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const path = String(args[0]);
      if (temporary(path) && fault.mode === "temp-open") {
        fault.hits++;
        throw ioError("EACCES");
      }
      const fd = actual.openSync(...args);
      fault.fds.set(fd, named(path));
      return fd;
    },
    closeSync(fd: number) {
      const path = fault.fds.get(fd) ?? "";
      try {
        const result = actual.closeSync(fd);
        if (temporary(path) && ["temp-close", "temp-fsync-close"].includes(fault.mode)) {
          fault.hits++;
          throw ioError("EACCES");
        }
        return result;
      } finally {
        fault.fds.delete(fd);
      }
    },
    writeSync(fd: number, ...args: unknown[]) {
      if (temporary(fault.fds.get(fd) ?? "") && fault.mode === "temp-write") {
        fault.hits++;
        throw ioError();
      }
      if (temporary(fault.fds.get(fd) ?? "") && fault.mode === "zero-write") {
        fault.hits++;
        return 0;
      }
      return Reflect.apply(actual.writeSync, actual, [fd, ...args]);
    },
    fsyncSync(fd: number) {
      const path = fault.fds.get(fd) ?? "";
      if (
        (temporary(path) && ["temp-fsync", "temp-fsync-cleanup", "temp-fsync-close"].includes(fault.mode)) ||
        ((path === fault.folder || path === join(fault.folder, "diagrams")) && fault.mode === "directory-sync")
      ) {
        fault.hits++;
        throw ioError();
      }
      return actual.fsyncSync(fd);
    },
    renameSync(from: import("node:fs").PathLike, to: import("node:fs").PathLike) {
      if (named(String(to)) === join(fault.folder, "a.mmd") && fault.mode.startsWith("rename-")) {
        fault.hits++;
        if (fault.mode === "rename-after") actual.renameSync(from, to);
        throw ioError();
      }
      return actual.renameSync(from, to);
    },
    linkSync(from: import("node:fs").PathLike, to: import("node:fs").PathLike) {
      if (named(String(to)) === join(fault.folder, "diagrams/new.mmd") && fault.mode.startsWith("link-")) {
        fault.hits++;
        if (fault.mode === "link-after") actual.linkSync(from, to);
        if (fault.mode === "link-exists") {
          actual.writeFileSync(to, "foreign source bytes");
          return actual.linkSync(from, to);
        }
        throw ioError();
      }
      return actual.linkSync(from, to);
    },
    rmSync(path: import("node:fs").PathLike, options?: import("node:fs").RmOptions) {
      if (temporary(String(path)) && fault.mode === "temp-fsync-cleanup") {
        fault.hits++;
        throw ioError("EACCES");
      }
      return actual.rmSync(path, options);
    },
  };
});
afterEach(() => {
  fault.mode = "";
  fault.folder = "";
  fault.hits = 0;
  fault.fds.clear();
  removeTempDirs();
});
const next = "\ufeff" + FLOW.replace("Client", "Changed").replace(/\n/gu, "\r\n");
function setup() {
  const project = findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW }));
  fault.folder = project.folder;
  return project;
}
for (const operation of ["apply", "create"] as const)
  for (const mode of ["temp-open", "temp-write", "zero-write", "temp-fsync", "temp-close"] as const)
    test(`${operation}: ${mode} is a known prepublication refusal with no canonical effect`, async () => {
      const project = setup();
      fault.mode = mode;
      let completed = false;
      const action = async () =>
        operation === "apply"
          ? applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, {
              afterWrite() {
                completed = true;
              },
            })
          : createConfined(project, "diagrams/new.mmd", next, {
              afterWrite() {
                completed = true;
              },
            });
      await expect(action()).rejects.toMatchObject({
        phase: "prepublication",
        code: ["temp-open", "temp-close"].includes(mode) ? "EACCES" : "EIO",
      });
      expect(fault.hits).toBe(1);
      expect(completed).toBe(false);
      expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
      expect(() => readFileSync(join(project.folder, "diagrams/new.mmd"))).toThrow();
      expect(withSourceWriterLock(project, operation === "apply" ? "a.mmd" : "diagrams/new.mmd", () => 42, 10)).toBe(
        42,
      );
    });
for (const operation of ["apply", "create"] as const)
  for (const effect of ["before", "after"] as const)
    test(`${operation}: publication syscall EIO ${effect} its effect remains uncertain`, async () => {
      const project = setup();
      fault.mode = `${operation === "apply" ? "rename" : "link"}-${effect}`;
      let completed = false;
      const action = async () =>
        operation === "apply"
          ? applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, {
              afterWrite() {
                completed = true;
              },
            })
          : createConfined(project, "diagrams/new.mmd", next, {
              afterWrite() {
                completed = true;
              },
            });
      await expect(action()).rejects.toMatchObject({ code: "write_uncertain" });
      expect(fault.hits).toBe(1);
      expect(completed).toBe(false);
      const target = join(project.folder, operation === "apply" ? "a.mmd" : "diagrams/new.mmd");
      if (effect === "after") expect(readFileSync(target)).toEqual(Buffer.from(next));
      else if (operation === "apply") expect(readFileSync(target, "utf8")).toBe(FLOW);
      else expect(() => readFileSync(target)).toThrow();
      expect(withSourceWriterLock(project, operation === "apply" ? "a.mmd" : "diagrams/new.mmd", () => 42, 10)).toBe(
        42,
      );
    });
test("exclusive link EEXIST after preflight is a known refusal and preserves the foreign canonical file", () => {
  const project = setup();
  fault.mode = "link-exists";
  let completed = false;
  expect(() =>
    createConfined(project, "diagrams/new.mmd", next, {
      afterWrite() {
        completed = true;
      },
    }),
  ).toThrowError(expect.objectContaining({ phase: "prepublication", code: "EEXIST" }));
  expect(fault.hits).toBe(1);
  expect(completed).toBe(false);
  expect(readFileSync(join(project.folder, "diagrams/new.mmd"), "utf8")).toBe("foreign source bytes");
});
for (const operation of ["apply", "create"] as const)
  for (const mode of ["directory-sync", "completion"] as const)
    test(`${operation}: ${mode} failure after canonical effect stays uncertain and keeps observed bytes`, async () => {
      const project = setup();
      fault.mode = mode;
      let completions = 0;
      const action = async () =>
        operation === "apply"
          ? applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, {
              syncDirectory: true,
              afterWrite() {
                completions++;
                throw new Error("terminal journal unavailable");
              },
            })
          : createConfined(project, "diagrams/new.mmd", next, {
              syncDirectory: true,
              afterWrite() {
                completions++;
                throw new Error("terminal journal unavailable");
              },
            });
      await expect(action()).rejects.toMatchObject({ code: "write_uncertain" });
      expect(readFileSync(join(project.folder, operation === "apply" ? "a.mmd" : "diagrams/new.mmd"))).toEqual(
        Buffer.from(next),
      );
      expect(completions).toBe(mode === "completion" ? 1 : 0);
      if (mode === "directory-sync") expect(fault.hits).toBe(1);
      expect(withSourceWriterLock(project, operation === "apply" ? "a.mmd" : "diagrams/new.mmd", () => 42, 10)).toBe(
        42,
      );
    });
for (const operation of ["apply", "create"] as const)
  for (const cleanup of ["cleanup", "close"] as const)
    test(`${operation}: temporary fsync plus ${cleanup} failure retains original prepublication phase and cause`, async () => {
      const project = setup();
      fault.mode = `temp-fsync-${cleanup}`;
      const action = async () =>
        operation === "apply"
          ? applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next)
          : createConfined(project, "diagrams/new.mmd", next);
      await expect(action()).rejects.toMatchObject({
        phase: "prepublication",
        code: "EIO",
        cause: expect.objectContaining({ code: "EIO" }),
      });
      expect(fault.hits).toBe(2);
      expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
      expect(() => readFileSync(join(project.folder, "diagrams/new.mmd"))).toThrow();
      expect(
        readdirSync(operation === "apply" ? project.folder : join(project.folder, "diagrams")).some((path) =>
          path.endsWith(".tmp"),
        ),
      ).toBe(cleanup === "cleanup");
    });
