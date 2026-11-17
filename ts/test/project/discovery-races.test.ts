import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { findProject } from "../../src/project/project.ts";
import { discoverDocuments, readDiscoveredDocument } from "../../src/project/discovery.ts";
import { removeTempDirs, tempDir } from "./support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});

test("directory replacement cannot enumerate an outside symlink target", () => {
  const root = tempDir({ "docs/inside.md": "inside" }),
    outside = tempDir({ "PRIVATE?.md": "secret" });
  const project = findProject(root),
    original = fs.opendirSync;
  let swapped = false;
  vi.spyOn(fs, "opendirSync").mockImplementation(((path: fs.PathLike, options?: fs.OpenDirOptions) => {
    if (!swapped) {
      swapped = true;
      fs.renameSync(join(root, "docs"), join(root, "saved"));
      fs.symlinkSync(outside, join(root, "docs"));
    }
    return original(path, options);
  }) as typeof fs.opendirSync);
  syncBuiltinESMExports();
  const catalog = discoverDocuments(project, { roots: ["docs"] });
  expect(swapped).toBe(true);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE");
  expect(catalog.documents.every((entry) => entry.source.path === "docs/inside.md")).toBe(true);
});

test("ancestor replacement during open cannot return bytes from the moved outside source", () => {
  const root = tempDir({ "docs/a.md": "INSIDE" }),
    outside = tempDir();
  const project = findProject(root),
    catalog = discoverDocuments(project, { roots: ["docs"] }),
    original = fs.openSync;
  let swapped = false;
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!swapped && String(path).endsWith("/a.md")) {
      swapped = true;
      fs.renameSync(join(root, "docs"), join(outside, "moved"));
      fs.symlinkSync(join(outside, "moved"), join(root, "docs"));
      fs.writeFileSync(join(outside, "moved/a.md"), "SECRET");
    }
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  const read = readDiscoveredDocument(project, catalog, "docs/a.md");
  expect(swapped).toBe(true);
  expect(read).toBeNull();
});

test("component replacement before a directory open never follows the replacement link", () => {
  const root = tempDir({ "docs/a.md": "inside" }),
    outside = tempDir({ "a.md": "outside" });
  const project = findProject(root),
    original = fs.openSync;
  let swapped = false;
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!swapped && String(path).endsWith("/docs")) {
      swapped = true;
      fs.renameSync(join(root, "docs"), join(root, "saved"));
      fs.symlinkSync(outside, join(root, "docs"));
    }
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  const catalog = discoverDocuments(project, { roots: ["docs"] });
  expect(swapped).toBe(true);
  expect(catalog.documents).toHaveLength(0);
  expect(catalog.complete).toBe(false);
});

// macOS has no descriptor filesystem with directory suffixes: discovery runs on the D7 path anchor there,
// not refused (it was, and a Mac's project page listed nothing). ADR 0018, amended 2026-11-10.
test("without a verified descriptor filesystem (macOS), discovery and its reads use the path anchor", () => {
  const root = tempDir({ "docs/a.md": "inside" }),
    project = findProject(root);
  const admitted = discoverDocuments(project, { roots: ["docs"] }),
    original = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (/^\/(?:proc\/self|dev)\/fd\/\d+\/\.$/u.test(String(path))) throw new Error("descriptor suffix unavailable");
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  const anchored = discoverDocuments(project, { roots: ["docs"] });
  expect(anchored).toMatchObject({ complete: true, documents: [{ source: { path: "docs/a.md" } }], diagnostics: [] });
  expect(readDiscoveredDocument(project, anchored, "docs/a.md")?.text).toBe("inside");
  expect(readDiscoveredDocument(project, admitted, "docs/a.md")?.text).toBe("inside");
  expect(discoverDocuments(project, { roots: [] })).toMatchObject({ complete: true, documents: [], diagnostics: [] });
});

test("a file moved outside while reading cannot return changed bytes", () => {
  const root = tempDir({ "docs/a.md": "INSIDE" }),
    outside = tempDir();
  const project = findProject(root),
    catalog = discoverDocuments(project, { roots: ["docs"] }),
    original = fs.readSync;
  let swapped = false;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (!swapped) {
      swapped = true;
      fs.renameSync(join(root, "docs"), join(outside, "moved"));
      fs.symlinkSync(join(outside, "moved"), join(root, "docs"));
      fs.writeFileSync(join(outside, "moved/a.md"), "SECRET");
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  expect(readDiscoveredDocument(project, catalog, "docs/a.md")).toBeNull();
  expect(swapped).toBe(true);
});

test("directory read failures report incomplete coverage and release the open directory", () => {
  const root = tempDir({ "docs/a.md": "inside" }),
    project = findProject(root),
    original = fs.opendirSync;
  let closed = false;
  vi.spyOn(fs, "opendirSync").mockImplementation(((path: fs.PathLike, options?: fs.OpenDirOptions) => {
    const directory = original(path, options),
      close = directory.closeSync.bind(directory);
    directory.readSync = () => {
      throw new Error("injected filesystem read failure");
    };
    directory.closeSync = () => {
      closed = true;
      close();
    };
    return directory;
  }) as typeof fs.opendirSync);
  syncBuiltinESMExports();
  expect(discoverDocuments(project, { roots: ["docs"] })).toMatchObject({
    complete: false,
    diagnostics: [{ code: "directory_unreadable" }],
  });
  expect(closed).toBe(true);
});

test("a handle whose file was unlinked, moved or replaced after opening is no longer bound", async () => {
  const { ConfinedFileSystem } = await import("../../src/project/confined-fs.ts");
  const root = tempDir({ "docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c" }),
    outside = tempDir();
  const confined = new ConfinedFileSystem(root);
  try {
    const kept = confined.open("docs/a.md"),
      unlinked = confined.open("docs/b.md"),
      moved = confined.open("docs/c.md");
    try {
      expect(confined.bound(kept)).toBe(true);
      fs.unlinkSync(join(root, "docs/b.md"));
      fs.renameSync(join(root, "docs/c.md"), join(outside, "c.md"));
      fs.writeFileSync(join(root, "docs/c.md"), "replacement");
      expect(confined.bound(unlinked)).toBe(false);
      expect(confined.bound(moved)).toBe(false);
      expect(confined.bound(kept)).toBe(true);
    } finally {
      for (const handle of [kept, unlinked, moved]) fs.closeSync(handle.fd);
    }
  } finally {
    confined.close();
  }
});
