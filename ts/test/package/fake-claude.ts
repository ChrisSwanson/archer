/**
 * A stand-in `claude` CLI keeping its marketplaces and plugins in $CLAUDE_CONFIG_DIR/stub.json and its
 * user MCP servers where Claude Code keeps them ($CLAUDE_CONFIG_DIR/.claude.json `mcpServers`): just the
 * `claude plugin` and `claude mcp add/remove` commands setup runs, with the real CLI's --json shapes.
 * Every call is appended to $CLAUDE_CONFIG_DIR/calls.log.
 */
export const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.CLAUDE_CONFIG_DIR, "stub.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { marketplaces: [], plugins: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const args = process.argv.slice(2).filter(arg => arg !== "--json");
const json = process.argv.includes("--json");
fs.appendFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "calls.log"), process.argv.slice(2).join(" ") + "\\n");
const [group, verb, ...rest] = args;
const fail = message => { console.error(message); process.exit(1); };
if (group === "mcp") {
  const user = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
  const config = fs.existsSync(user) ? JSON.parse(fs.readFileSync(user, "utf8")) : {};
  const options = rest.slice(0, rest.includes("--") ? rest.indexOf("--") : rest.length);
  const name = options.filter((arg, i) => !arg.startsWith("-") && !(options[i - 1] || "").startsWith("--scope")).pop();
  if (verb === "add") {
    const [command, ...commandArgs] = rest.slice(rest.indexOf("--") + 1);
    if ((config.mcpServers || {})[name]) fail("MCP server " + name + " already exists in user config");
    config.mcpServers = { ...(config.mcpServers || {}), [name]: { type: "stdio", command, args: commandArgs, env: {} } };
  } else if (verb === "remove") {
    if (!(config.mcpServers || {})[name]) fail("No MCP server found with name: " + name);
    delete config.mcpServers[name];
  } else fail("stub: unsupported " + args.join(" "));
  fs.writeFileSync(user, JSON.stringify(config, null, 2));
  process.exit(0);
}
if (group !== "plugin") fail("stub: unsupported " + args.join(" "));
if (verb === "marketplace") {
  const [action, target] = rest;
  if (action === "list") {
    if (json) console.log(JSON.stringify(state.marketplaces.map(m => ({ name: m.name, source: "directory", path: m.path, installLocation: m.path }))));
    else console.log(state.marketplaces.map(m => "  > " + m.name + "\\n    Source: Folder (" + m.path + ")").join("\\n"));
  } else if (action === "add") {
    const name = JSON.parse(fs.readFileSync(path.join(target, ".claude-plugin", "marketplace.json"), "utf8")).name;
    state.marketplaces = state.marketplaces.filter(m => m.name !== name).concat([{ name, path: path.resolve(target) }]);
  } else if (action === "remove") {
    if (!state.marketplaces.some(m => m.name === target)) fail("Marketplace not found: " + target);
    state.marketplaces = state.marketplaces.filter(m => m.name !== target);
    state.plugins = state.plugins.filter(p => !p.id.endsWith("@" + target));
  } else if (action !== "update") fail("stub: unsupported " + args.join(" "));
} else if (verb === "list") {
  console.log(JSON.stringify(state.plugins.map(p => ({ id: p.id, scope: p.scope, enabled: true }))));
} else if (verb === "install") {
  const id = rest[0];
  if (!state.marketplaces.some(m => id.endsWith("@" + m.name))) fail("Plugin not found: " + id);
  if (!state.plugins.some(p => p.id === id)) state.plugins.push({ id, scope: "user" });
} else if (verb === "uninstall") {
  const id = rest[0], scope = rest.includes("--scope") ? rest[rest.indexOf("--scope") + 1] : "user";
  if (!state.plugins.some(p => p.id === id && p.scope === scope)) fail("Plugin not installed: " + id);
  state.plugins = state.plugins.filter(p => !(p.id === id && p.scope === scope));
} else if (verb !== "update") fail("stub: unsupported " + args.join(" "));
save();
`;
