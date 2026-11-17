#!/usr/bin/env node
// The packaged `archer` command: `setup`, `upgrade` and `uninstall` manage this installation;
// everything else is the bundled Archer CLI.
const [command] = process.argv.slice(2);
// Node 22.18 (setup.mjs MIN_NODE, the package's engines and ts/src/bin/archer.ts say the same). The shim may fall
// back to whichever node or nodejs is on PATH (with none, the shim itself says so: setup.mjs shimText); the
// turn-start hook then stays silent and exits 0 (exit 2 would block the person's prompt, any other failure shows as
// a hook error on every prompt), everything else says what to do.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  if (command === "inbox" && process.argv.includes("--hook")) process.exit(0);
  process.stderr.write(
    `archer: Archer needs Node 22.18 or newer; ${process.execPath} is ${process.versions.node}. Put a newer node first on PATH.\n`,
  );
  process.exit(1);
}
if (command === "setup" || command === "uninstall") {
  const { main } = await import("./setup.mjs");
  process.exitCode = await main(command, process.argv.slice(3));
} else if (command === "upgrade") {
  const { upgrade } = await import("./upgrade.mjs");
  process.exitCode = await upgrade(process.argv.slice(3));
} else if (command === undefined && !(await installedCopy())) {
  // Run straight from the tgz (`npx ./archer-x.y.z.tgz`) with no command: say how to install.
  const { readFileSync } = await import("node:fs");
  // The package root holds package.json; in the source tree it is ts/package.json, one level up.
  let version = "<version>";
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      version = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
      break;
    } catch {}
  }
  console.error(
    `Archer is not installed yet. To install it, run this in the folder holding the file:\n\n  npx --yes ./archer-${version}.tgz setup\n\nThen open a new terminal and run: archer --help`,
  );
  process.exitCode = 2;
} else {
  if (command === "--help" || command === "help" || command === undefined) {
    console.log(
      "       archer setup [--mcp] [--no-claude] [--no-codex]   install or upgrade this package for Claude Code and Codex (--mcp: also as an MCP server)\n       archer upgrade <archer-x.y.z.tgz>          install a new package and hot swap the running Archer to it\n       archer uninstall                          remove what setup installed (keeps diagrams, config and state)\n",
    );
  }
  await import("../dist/archer.js");
}

/** True when this file is the copy `archer setup` installed (under its data folder). */
async function installedCopy() {
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { sep } = await import("node:path");
  const { paths } = await import("./setup.mjs");
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    return here.startsWith(realpathSync(paths().data) + sep);
  } catch {
    return false;
  }
}
