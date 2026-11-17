import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// Running the package without a command (e.g. `npx ./archer-x.y.z.tgz`) before it is installed
// must say how to install it, not print the CLI help.
const ENTRY = resolve(__dirname, "../../pkg/bin/archer.mjs");
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "archer-hint-"));
  homes.push(home);
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home },
  });
}

test("no command from an uninstalled copy gives the setup command", () => {
  const result = run([]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/not installed/i);
  expect(result.stderr).toMatch(/npx --yes \.\/archer-\d+\.\d+\.\d+\.tgz setup/);
  expect(result.stdout).toBe("");
});
