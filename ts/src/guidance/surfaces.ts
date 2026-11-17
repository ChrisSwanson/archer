// ADR 0035 §1: the one rule on which surface an agent uses. This constant is the only copy; the
// skill, the MCP instructions and the sandbox hint include it byte for byte (test/guidance/surfaces.test.ts).
// A TypeScript constant rather than an asset, so the bundle and package need no new file.
export const SURFACES_RULE =
  "Use the `archer` CLI: `archer tools` lists the operations and `archer call <operation>` runs one. " +
  "MCP is an opt-in adapter over the same operations; when its tools are older than the CLI, the CLI wins. " +
  "When a call is refused, follow the fix the error names.";
