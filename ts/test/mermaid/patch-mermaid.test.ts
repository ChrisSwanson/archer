// The postinstall patch that makes Mermaid's flowchart parser copy its config once per parse
// (scripts/patch-mermaid.mjs): applied to the installed Mermaid, guarded, idempotent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error -- a plain .mjs script outside the TypeScript project
import { MARKER, patchFlowDb } from "../../../scripts/patch-mermaid.mjs";

const CORE = join(import.meta.dirname, "../../../node_modules/mermaid/dist/chunks/mermaid.core");

test("the installed Mermaid copies its config once per flowchart parse (npm install ran the patch)", () => {
  const flowDb = readdirSync(CORE)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFileSync(join(CORE, name), "utf8"))
    .filter((text) => text.includes("var FlowDB = class"));
  expect(flowDb.length).toBeGreaterThan(0);
  for (const text of flowDb) expect(text).toContain(MARKER);
});

test("the patch applies only to the code it was written against, once", () => {
  const original = [
    "var FlowDB = class {",
    "    if (textObj !== void 0) {\n      this.config = getConfig();\n      txt = this.sanitizeText(textObj.text.trim());",
    "    this.version = ver;\n    this.config = getConfig();\n    clear();\n  }",
  ].join("\n");
  const patched = patchFlowDb(original) as string;
  expect(patched).toContain("if (!this.configFresh) { this.config = getConfig(); this.configFresh = true; }");
  expect(patched).toContain("this.configFresh = false;\n    clear();");
  expect(patchFlowDb(patched)).toBe(patched);
  expect(patchFlowDb("var other = 1;")).toBeNull();
  expect(() => patchFlowDb("var FlowDB = class { addVertex() { this.config = getConfig(); } }")).toThrow(
    /not the code/,
  );
});
