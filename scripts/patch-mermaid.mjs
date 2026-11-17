#!/usr/bin/env node
// Postinstall: one Mermaid config copy per flowchart parse, not one per labelled node.
//
// Mermaid's FlowDB.addVertex calls getConfig() for every node with a label, and getConfig()
// deep-copies the whole configuration (~970 entries, 322 of them theme variables). On a
// 150-node flowchart that copy was ~77 % of Archer's compile (profile, 2026-10-21). The config
// cannot change while the parser runs, so the patched FlowDB copies it at the first labelled
// node of each parse (after the diagram's init, as before) and reuses it for the rest.
//
// Guarded: the patch applies only to the exact text it was written against, is idempotent, and
// fails the install loudly when a Mermaid upgrade moved the code (re-check, then update or drop it).
// Upstream: worth proposing to mermaid-js (cache getConfig() in FlowDB per parse).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "/* archer: one config copy per parse */";
const VERTEX_OLD =
  "    if (textObj !== void 0) {\n      this.config = getConfig();\n      txt = this.sanitizeText(textObj.text.trim());";
const VERTEX_NEW = `    if (textObj !== void 0) {\n      if (!this.configFresh) { this.config = getConfig(); this.configFresh = true; } ${MARKER}\n      txt = this.sanitizeText(textObj.text.trim());`;
const CLEAR_OLD = "    this.version = ver;\n    this.config = getConfig();\n    clear();\n  }";
const CLEAR_NEW =
  "    this.version = ver;\n    this.config = getConfig();\n    this.configFresh = false;\n    clear();\n  }";

/** The patched text of a Mermaid chunk; `null` when it holds no FlowDB. Throws when FlowDB's code is not the expected one. */
export function patchFlowDb(text) {
  if (!text.includes("var FlowDB = class")) return null;
  if (text.includes(MARKER)) return text;
  const once = (s, needle) => s.split(needle).length - 1 === 1;
  if (!once(text, VERTEX_OLD) || !once(text, CLEAR_OLD))
    throw new Error("Mermaid's FlowDB is not the code scripts/patch-mermaid.mjs was written against");
  return text.replace(VERTEX_OLD, VERTEX_NEW).replace(CLEAR_OLD, CLEAR_NEW);
}

/** Patches every FlowDB chunk of the installed Mermaid build Node loads (`mermaid.core`); returns the files changed. */
export function patchMermaid(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const chunks = join(root, "node_modules/mermaid/dist/chunks/mermaid.core");
  let names;
  try {
    names = readdirSync(chunks);
  } catch {
    return [];
  }
  const changed = [];
  let found = false;
  for (const name of names.filter((n) => n.endsWith(".mjs"))) {
    const file = join(chunks, name),
      text = readFileSync(file, "utf8");
    const next = patchFlowDb(text);
    if (next === null) continue;
    found = true;
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(file);
    }
  }
  if (!found) throw new Error("no FlowDB chunk found in the installed Mermaid (scripts/patch-mermaid.mjs)");
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = patchMermaid();
  if (changed.length)
    process.stdout.write(`patch-mermaid: one config copy per flowchart parse (${changed.length} file)\n`);
}
