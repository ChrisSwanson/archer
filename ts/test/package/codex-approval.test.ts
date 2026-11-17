// archer setup keeps Codex asking before setup_network_access: it recognises the person's own table for it
// by TOML structure (spacing, quotes, a comment), never one written inside a multi-line string.
import { expect, test } from "vitest";
// @ts-expect-error -- a plain .mjs script without types
import { hasToolTable } from "../../pkg/bin/setup.mjs";

test.each([
  ['[mcp_servers.archer.tools.setup_network_access]\napproval_mode = "approve"', true],
  ['[ mcp_servers . "archer" . tools . "setup_network_access" ] # mine\napproval_mode = "prompt"', true],
  ['[mcp_servers.archer.env]\nNOTE = """\n[mcp_servers.archer.tools.setup_network_access]\n"""', false],
  ['[mcp_servers.archer.tools.write_diagram]\napproval_mode = "prompt"', false],
  ['["mcp_servers".archer."tools".setup_network_access]\napproval_mode = "approve"', true],
])("%j has the table: %s", (text, expected) => {
  expect(hasToolTable(text, "setup_network_access")).toBe(expected);
});
