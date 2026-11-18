import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { readNoteSource, NoteReadError } from "../../src/notes/read.ts";
import { findProject } from "../../src/project/project.ts";
import { DISCOVERY_LIMITS, discoverDocuments } from "../../src/project/discovery.ts";
import { listNotes, MAX_NOTE_BYTES } from "../../src/project/inventory.ts";
import { removeTempDirs, tempDir, write } from "../project/support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function refusal(action: () => unknown, code: string, reason?: string): NoteReadError {
  try {
    action();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(NoteReadError);
    const refused = error as NoteReadError;
    expect(refused.code).toBe(code);
    if (reason !== undefined) expect(refused.details).toMatchObject({ reason });
    expect(refused.message).not.toMatch(/\/tmp\/|ENOENT|ELOOP/);
    return refused;
  }
}

test.each([
  "",
  "---\nstatus: proposed\n---",
  "\uFEFF---\r\nstatus: approved\r\n---\r\n# 日\r\nRetention: 37 days.\r\n```mermaid\r\nINVALID\r\n```\r\n",
])("one exact UTF-8 source supplies bytes, revision and frontmatter: %j", (text) => {
  const project = findProject(tempDir({ ".archer/notes/policy.md": text }));
  const result = readNoteSource(project, "notes/policy.md");
  expect(result).toMatchObject({
    schemaVersion: 1,
    notePath: "notes/policy.md",
    sourceRevision: hash(Buffer.from(text)),
    source: { status: "text", text },
    bytes: Buffer.byteLength(text),
    complete: true,
    provenance: { scope: "authoring-folder", currentSource: true },
    inventory: { complete: true, diagnostics: [], diagnosticCount: 0, diagnosticsTruncated: false },
  });
  if (text.includes("approved")) expect(result.frontMatter).toEqual({ status: "approved" });
});

test("a prose edit changes the whole-note revision", () => {
  const root = tempDir({ ".archer/a.md": "old\n```mermaid\n%% archer-id: flow\nflowchart LR\n a[A]\n```\n" }),
    project = findProject(root);
  const before = readNoteSource(project, "a.md");
  write(root, ".archer/a.md", before.source.text.replace("old", "new"));
  expect(readNoteSource(project, "a.md").sourceRevision).not.toBe(before.sourceRevision);
});

test.each(['roots=[]\nexclude=["**"]', 'roots=["docs"]'])(
  "authoring policy ignores broader discovery settings: %s",
  (settings) => {
    const project = findProject(
      tempDir({
        "archer.toml": `version=1\nfolder="writing"\n[discovery]\n${settings}\n`,
        "writing/notes/a.md": "inside",
        "docs/notes/a.md": "outside",
      }),
    );
    expect(readNoteSource(project, "notes/a.md").source.text).toBe("inside");
    refusal(() => readNoteSource(project, "docs/notes/a.md"), "resource_not_found");
  },
);

test("percent escapes are literal filename characters", () => {
  const project = findProject(tempDir({ ".archer/%2e%2e.md": "literal" }));
  expect(readNoteSource(project, "%2e%2e.md").source.text).toBe("literal");
});

test.each([
  null,
  undefined,
  5,
  {},
  [],
  "/a.md",
  "../a.md",
  "a/../b.md",
  ".hidden.md",
  "a/.b.md",
  "a\\b.md",
  "a.md#f",
  "a?.md",
  "a:\nb.md",
  "a\u0000.md",
  "a.mmd",
  "x".repeat(1196) + ".md",
])("malformed note path is refused: %j", (path) => {
  refusal(() => readNoteSource(findProject(tempDir()), path), "invalid_arguments");
});

test("authoring admits generated directories and literal metacharacters without widening browser policy", () => {
  const project = findProject(
    tempDir({ ".archer/build/a.md": "generated", ".archer/[proposal]*{v1}!.md": "literal metacharacters" }),
  );
  expect(readNoteSource(project, "build/a.md").source.text).toBe("generated");
  expect(readNoteSource(project, "[proposal]*{v1}!.md").source.text).toBe("literal metacharacters");
  expect(discoverDocuments(project).documents).toEqual([]);
  refusal(() => readNoteSource(findProject(tempDir()), "absent.md"), "io_failure", "coverage_incomplete");
  refusal(() => readNoteSource(project, "absent.md"), "resource_not_found");
});

test("exact byte bound succeeds, over-bound and invalid UTF-8 have distinct refusals", () => {
  const root = tempDir({ ".archer/a.md": "a".repeat(MAX_NOTE_BYTES) }),
    project = findProject(root);
  expect(readNoteSource(project, "a.md").bytes).toBe(MAX_NOTE_BYTES);
  fs.writeFileSync(join(root, ".archer/a.md"), "a".repeat(MAX_NOTE_BYTES + 1));
  refusal(() => readNoteSource(project, "a.md"), "source_too_large");
  fs.writeFileSync(join(root, ".archer/a.md"), Buffer.from([0xff]));
  refusal(() => readNoteSource(project, "a.md"), "invalid_source");
});

test.each([{ directories: 0 }, { entries: 0 }, { documents: 0 }, { bytes: 0 }])(
  "budget exhaustion refuses absence as incomplete: %j",
  (limits) => {
    const project = findProject(tempDir({ ".archer/a.md": "yes" }));
    const error = refusal(() => readNoteSource(project, "a.md", limits), "io_failure", "coverage_incomplete");
    expect(error.details).toMatchObject({ inventory: { complete: false, diagnosticCount: 1 } });
  },
);

test("admitted content succeeds while inventory diagnostics remain bounded", () => {
  const root = tempDir({ ".archer/a.md": "yes" }),
    project = findProject(root);
  for (let i = 0; i < 25; i++) fs.symlinkSync(join(root, ".archer/a.md"), join(root, `.archer/link-${i}.md`));
  const read = readNoteSource(project, "a.md");
  expect(read.source.text).toBe("yes");
  expect(read.inventory).toMatchObject({ complete: false, diagnosticCount: 25, diagnosticsTruncated: true });
  expect(read.inventory.diagnostics).toHaveLength(20);
});

test("a missing note reads the same with or without an unrelated symlink in the notes folder", () => {
  const plain = tempDir({ ".archer/a.md": "yes" });
  const linked = tempDir({ ".archer/a.md": "yes" });
  fs.symlinkSync(join(linked, ".archer/a.md"), join(linked, ".archer/link.md"));
  const without = refusal(() => readNoteSource(findProject(plain), "absent.md"), "resource_not_found");
  const withLink = refusal(() => readNoteSource(findProject(linked), "absent.md"), "resource_not_found");
  expect(withLink.message).toBe(without.message);
});

test("depth exactly 64 is admitted and 65 is refused by name", () => {
  const path = Array.from({ length: DISCOVERY_LIMITS.depth }, () => "a").join("/");
  const root = tempDir({ [`.archer/${path}/yes.md`]: "limit", [`.archer/${path}/a/no.md`]: "beyond" }),
    project = findProject(root);
  expect(readNoteSource(project, `${path}/yes.md`).source.text).toBe("limit");
  const error = refusal(() => readNoteSource(project, `${path}/a/no.md`), "io_failure", "coverage_incomplete");
  expect(error.details).toMatchObject({
    inventory: { diagnostics: [expect.objectContaining({ code: "depth_limit" })] },
  });
});

test("legacy-listed internal symlinks and external symlinks are refused", () => {
  const root = tempDir({ ".archer/a.md": "inside" }),
    outside = tempDir({ "secret.md": "outside" });
  fs.symlinkSync(join(root, ".archer/a.md"), join(root, ".archer/internal.md"));
  fs.symlinkSync(join(outside, "secret.md"), join(root, ".archer/external.md"));
  const project = findProject(root);
  expect(listNotes(project).some((note) => note.path === "internal.md")).toBe(true);
  for (const path of ["internal.md", "external.md"])
    refusal(() => readNoteSource(project, path), "io_failure", "coverage_incomplete");
});

test("FIFO never blocks and cannot become source text", () => {
  const root = tempDir({ ".archer/a.md": "yes" });
  expect(spawnSync("mkfifo", [join(root, ".archer/pipe.md")]).status).toBe(0);
  refusal(() => readNoteSource(findProject(root), "pipe.md"), "resource_not_found");
});

// Without a descriptor filesystem (macOS) the read runs on the D7 path anchor, not refused (ADR 0018, amended 2026-11-10).
test("without a verified descriptor filesystem (macOS), a note still reads, through the path anchor", () => {
  const project = findProject(tempDir({ ".archer/a.md": "inside" })),
    original = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (/^\/(?:proc\/self|dev)\/fd\/\d+\/\.$/u.test(String(path))) throw new Error("descriptor suffix unavailable");
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  expect(readNoteSource(project, "a.md")).toMatchObject({ source: { status: "text", text: "inside" } });
});

test.each(["open", "read"] as const)("ancestor move during %s cannot return changed outside bytes", (when) => {
  const root = tempDir({ ".archer/notes/a.md": "INSIDE" }),
    outside = tempDir(),
    project = findProject(root);
  let swapped = false,
    opens = 0;
  const move = () => {
    swapped = true;
    fs.renameSync(join(root, ".archer/notes"), join(outside, "moved"));
    fs.symlinkSync(join(outside, "moved"), join(root, ".archer/notes"));
    fs.writeFileSync(join(outside, "moved/a.md"), "SECRET");
  };
  if (when === "open") {
    const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!swapped && String(path).endsWith("/a.md") && ++opens === 2) move();
      return original(path, flags, mode);
    }) as typeof fs.openSync);
  } else {
    const original = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (!swapped) move();
      return Reflect.apply(original, fs, args);
    }) as typeof fs.readSync);
  }
  syncBuiltinESMExports();
  refusal(() => readNoteSource(project, "notes/a.md"), "resource_not_found");
  expect(swapped).toBe(true);
});

test("note path plus synthetic address fragment accepts exactly 1200 characters", () => {
  const segment = "a".repeat(198),
    file = `${"b".repeat(200)}.md`;
  const path = `${(segment + "/").repeat(5)}${file}`;
  expect(path.length + 2).toBe(1200);
  if (process.platform !== "darwin") {
    const root = tempDir({ [`.archer/${path}`]: "exact path bound" }),
      project = findProject(root);
    expect(readNoteSource(project, path).source.text).toBe("exact path bound");
    refusal(() => readNoteSource(project, `c${path}`), "invalid_arguments");
    return;
  }
  // macOS: a path given to a syscall holds at most 1024 bytes (PATH_MAX), and with no descriptor filesystem
  // every open is by absolute path (ADR 0018 D7 path anchor), so a note this deep exists but cannot be read
  // (docs/document-discovery.md). The bound is still accepted, and the catalog says it is incomplete rather
  // than calling the note absent. The fixture is built with short names renamed long from the bottom up, so
  // no single path handed to the OS is too long; cleanup renames them back.
  const root = tempDir({ ".archer/1/2/3/4/5/.keep": "" }),
    short = ["1", "2", "3", "4", "5"],
    at = (...parts: string[]) => join(root, ".archer", ...parts);
  fs.rmSync(at(...short, ".keep"));
  fs.writeFileSync(at(...short, file), "exact path bound");
  for (let depth = short.length; depth > 0; depth--)
    fs.renameSync(at(...short.slice(0, depth)), at(...short.slice(0, depth - 1), segment));
  try {
    expect(Buffer.byteLength(at(path))).toBeGreaterThan(1024);
    const project = findProject(root);
    const refused = refusal(() => readNoteSource(project, path), "io_failure", "coverage_incomplete");
    expect(refused.details).toMatchObject({
      inventory: { complete: false, diagnostics: [{ code: "directory_unreadable" }] },
    });
    refusal(() => readNoteSource(project, `c${path}`), "invalid_arguments");
  } finally {
    for (let depth = 1; depth <= short.length; depth++)
      fs.renameSync(at(...short.slice(0, depth - 1), segment), at(...short.slice(0, depth)));
  }
});

test("frontmatter and revision derive from the captured bytes even when the same file changes after capture", () => {
  const before = "---\nstatus: proposed\n---\nold source\n",
    after = "---\nstatus: approved\n---\nnew source\n";
  expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after));
  const root = tempDir({ ".archer/a.md": before }),
    project = findProject(root),
    original = fs.readSync;
  let changed = false;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args);
    if (!changed) {
      changed = true;
      fs.writeFileSync(join(root, ".archer/a.md"), after);
    }
    return count;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  const read = readNoteSource(project, "a.md");
  expect(changed).toBe(true);
  expect(read).toMatchObject({
    source: { text: before },
    sourceRevision: hash(Buffer.from(before)),
    frontMatter: { status: "proposed" },
    bytes: Buffer.byteLength(before),
  });
});

test.each(["fifo", "large"] as const)(
  "an admitted source replaced before its descriptor read is refused: %s",
  (kind) => {
    const root = tempDir({ ".archer/a.md": "inside" }),
      project = findProject(root),
      original = fs.openSync;
    let opens = 0,
      changed = false;
    vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(path).endsWith("/a.md") && ++opens === 2) {
        changed = true;
        if (kind === "fifo") {
          fs.unlinkSync(join(root, ".archer/a.md"));
          expect(spawnSync("mkfifo", [join(root, ".archer/a.md")]).status).toBe(0);
        } else fs.writeFileSync(join(root, ".archer/a.md"), "x".repeat(MAX_NOTE_BYTES + 1));
      }
      return original(path, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    refusal(() => readNoteSource(project, "a.md"), kind === "large" ? "source_too_large" : "resource_not_found");
    expect(changed).toBe(true);
  },
);

test("normalized custom authoring folders retain catalog identity", () => {
  const project = findProject(
    tempDir({ "archer.toml": 'version=1\nfolder="writing//./"\n', "writing/notes/a.md": "normalized" }),
  );
  expect(project.folderSetting).toBe("writing");
  expect(readNoteSource(project, "notes/a.md").source.text).toBe("normalized");
});
