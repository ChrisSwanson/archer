import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readNoteSource, NoteReadError } from "../../src/notes/read.ts";
import { findProject } from "../../src/project/project.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-note-read-property-")));
const text = "\uFEFF---\r\nstatus: proposed\r\n---\r\nPolicy: keep 37 days.\r\n";
const sourceRevision = `sha256:${createHash("sha256").update(text).digest("hex")}`;
let state = 0x4e4f5445;
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
const words = [
  "notes",
  "/",
  "policy.md",
  ".md",
  "../",
  ".",
  "*",
  "[",
  "]",
  "{",
  "}",
  "!",
  "#",
  "?",
  ":",
  "\\",
  "\0",
  "日",
  "%2e%2e",
  "build",
  "dist",
  "\n",
];
const pick = () => words[next() % words.length];
let count = 0;
try {
  mkdirSync(join(root, ".archer/notes"), { recursive: true });
  writeFileSync(join(root, ".archer/notes/policy.md"), text);
  const project = findProject(root);
  const check = (raw) => {
    try {
      const result = readNoteSource(project, raw);
      if (
        raw !== "notes/policy.md" ||
        result.source.text !== text ||
        result.sourceRevision !== sourceRevision ||
        result.bytes !== Buffer.byteLength(text) ||
        !result.complete ||
        result.provenance.scope !== "authoring-folder"
      )
        throw new Error("invalid successful note read");
    } catch (error) {
      if (!(error instanceof NoteReadError)) throw error;
      if (
        !["invalid_arguments", "resource_not_found", "source_too_large", "invalid_source", "io_failure"].includes(
          error.code,
        ) ||
        !error.message ||
        JSON.stringify(error.details).includes(root) ||
        error.message.includes(root)
      )
        throw new Error("invalid refusal");
    }
    count++;
  };
  for (let i = 0; i < 1000; i++) {
    let value = "";
    for (let j = 0, n = next() % 150; j < n; j++) value += String.fromCharCode(next() % 0x10000);
    check(i % 7 === 0 ? [null, undefined, {}, [], true, 17][next() % 6] : value);
  }
  for (let i = 0; i < 1000; i++) {
    let path = "";
    for (let j = 0, n = next() % 12; j < n; j++) path += pick();
    check(path);
  }
  for (let i = 0; i < 1000; i++) {
    const path = "notes/policy.md",
      at = next() % (path.length + 1),
      cut = next() % 4;
    check(i % 20 === 0 ? path : path.slice(0, at) + pick() + path.slice(at + cut));
  }
  check("a/".repeat(5000) + "policy.md");
  console.log(`refused or valid: ${count}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
