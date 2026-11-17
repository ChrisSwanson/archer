// register_diagram's edit to archer.toml: one `[[views]]` entry added, or the
// entry for the same source rewritten in place. Everything else in the file
// (comments, other tables, other views) is kept byte for byte. archer.toml is
// outside the Archer folder, so it is the one file this server writes there;
// it is read and written through the confined seam from the project root, as
// writeConfined writes inside the folder: a new file created in the opened
// root without following a link, synced, then renamed over it in that root.
import { lstatSync } from "node:fs";
import { assertWriteAllowed } from "../config/write-policy.ts";
import { toolError } from "./errors.ts";
import { join, normalize } from "node:path";
import type { DiagramKind } from "../model/index.ts";
import { MANIFEST, type Project } from "../project/index.ts";
import { readManifestFile } from "../project/project.ts";
import { publishConfined } from "../project/confined-fs.ts";
import { parseToml, type TomlTable } from "../project/toml.ts";

export interface ViewEntryToWrite {
  readonly id: string;
  readonly kind: DiagramKind;
  readonly title: string;
  /** Relative to the Archer folder. */
  readonly source: string;
  readonly covers?: readonly string[];
}

const HEADER = /^\s*\[\[\s*views\s*\]\]/;

/** A TOML basic string. */
function tomlString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function block(project: Project, view: ViewEntryToWrite): string[] {
  const covers = view.covers ?? project.views.find((held) => held.source === view.source)?.covers;
  return [
    "[[views]]",
    `id = ${tomlString(view.id)}`,
    `kind = ${tomlString(view.kind)}`,
    `title = ${tomlString(view.title)}`,
    `source = ${tomlString(`${project.folderSetting}/${view.source}`)}`,
    ...(covers === undefined ? [] : [`covers = [${covers.map(tomlString).join(", ")}]`]),
  ];
}

/** The text archer.toml will hold with `view` registered, and the text it holds now (null if none). */
export function manifestWith(project: Project, view: ViewEntryToWrite): { before: string | null; after: string } {
  const before = project.manifest === null ? null : readManifestFile(project.root).bytes.toString("utf8");
  const text =
    before ??
    `# Archer: diagrams and notes for this project live in the folder below.\nversion = 1\nfolder = ${tomlString(project.folderSetting)}\n`;
  const lines = text.split("\n");
  const raw = parseToml(text)["views"];
  const entries = Array.isArray(raw) ? (raw as TomlTable[]) : [];
  const target = normalize(join(project.folder, view.source));
  const index = entries.findIndex(
    (e) => typeof e["source"] === "string" && normalize(join(project.root, e["source"])) === target,
  );
  if (index < 0) {
    const gap = text.endsWith("\n\n") || text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { before, after: `${text}${gap}${block(project, view).join("\n")}\n` };
  }
  const headers = lines.flatMap((line, i) => (HEADER.test(line) ? [i] : []));
  const start = headers[index] ?? lines.length;
  let end = lines.findIndex((line, i) => i > start && line.trim().startsWith("["));
  if (end < 0) end = lines.length;
  // Keep the blank lines and comments that close the old entry before the next header.
  while (end - 1 > start && (lines[end - 1]?.trim() === "" || lines[end - 1]?.trim().startsWith("#"))) end -= 1;
  const after = [...lines.slice(0, start), ...block(project, view), ...lines.slice(end)].join("\n");
  return { before, after };
}

/** Replaces archer.toml with `text`, never writing through a link. */
export function writeManifest(project: Project, text: string): void {
  assertWriteAllowed(project.root, ["manifest", "register"]);
  const destination = join(project.root, MANIFEST);
  // Only an archer.toml that exists is rewritten; Archer never creates one here (ADR 0028).
  try {
    if (!lstatSync(destination).isFile()) throw new Error("not a file");
  } catch {
    throw toolError(
      "no_manifest",
      "This project has no archer.toml (it was removed while register_diagram ran): run `archer init`, then register the diagram. Nothing was written.",
    );
  }
  // The rename replaces the entry (a link or another name there is replaced, never written through).
  publishConfined(project.root, [], MANIFEST, text, MANIFEST, { syncDirectory: true });
}
