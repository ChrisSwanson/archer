#!/usr/bin/env node
// The `archer` executable: `node dist/archer.js <command>`.
// The Node check comes before anything else loads: the shim, Claude Code's `.mcp.json` and Codex all
// run whichever `node` is first on PATH, which need not be the one setup checked.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(
    `archer: Archer needs Node 22.18 or newer; ${process.execPath} is ${process.versions.node}. Put a newer node first on PATH.\n`,
  );
  process.exit(1);
}
const argv = process.argv.slice(2);
if (argv[0] === "inbox" && argv.includes("--hook")) {
  // The turn-start hook runs before every prompt: it loads only the socket client, not main's graph.
  const { runHook } = await import("./hook.ts");
  process.exitCode = await runHook(argv.slice(1), {
    stdout: (text) => process.stdout.write(text),
    env: process.env,
    cwd: process.cwd(),
  });
} else if (argv[0] === "mcp" && argv.length === 1) {
  // The MCP relay: the socket and stdio only; the in-process server loads only as its fallback.
  const { runMcp } = await import("../mcp/relay.ts");
  process.exitCode = await runMcp(process.env, process.cwd());
} else {
  const { main } = await import("./main.ts");
  process.exitCode = await main(argv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    env: process.env,
    cwd: process.cwd(),
  });
}
