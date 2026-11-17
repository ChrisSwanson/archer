// `archer upgrade` installs the package with `npx ./<tgz> setup`. npm must not wait on the registry for that:
// with a fresh cache it would audit the install and ask for npm's latest version, and a stalled network
// then held the upgrade with no output (known failure O4). Here the registry accepts and never answers.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { REPO } from "../terminal/models.ts";

const scratch = mkdtempSync(join(tmpdir(), "archer-upgrade-offline-"));
const held: Socket[] = [];
const registry = createServer((socket) => {
  held.push(socket);
});
afterAll(() => {
  for (const socket of held) socket.destroy();
  registry.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A package whose `setup` only makes an installed copy that says Archer is not running. */
function fakePackage(): string {
  const root = join(scratch, "pkg", "package");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "archer", version: "9.9.9", bin: { archer: "bin/setup.mjs" } }),
  );
  writeFileSync(
    join(root, "bin", "setup.mjs"),
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      "const bin = `${process.env.ARCHER_INSTALL_DIR}/current/bin`;",
      "mkdirSync(bin, { recursive: true });",
      "writeFileSync(`${bin}/archer.mjs`, 'console.error(\"Archer is not running\"); process.exit(1);\\n');",
      'console.log("installed");',
    ].join("\n"),
    { mode: 0o755 },
  );
  const tgz = join(scratch, "archer-9.9.9.tgz");
  expect(spawnSync("tar", ["-czf", tgz, "-C", dirname(root), "package"]).status).toBe(0);
  return tgz;
}

test("archer upgrade installs without waiting on a registry that never answers", async () => {
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const port = (registry.address() as { port: number }).port;
  const tgz = fakePackage();
  const home = join(scratch, "home");
  mkdirSync(home);
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    ARCHER_INSTALL_DIR: join(home, "data"),
    // Every request npm makes goes to the stalled registry; the cache is empty.
    npm_config_registry: `http://127.0.0.1:${port}/`,
    npm_config_cache: join(home, "npm-cache"),
  };
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [join(REPO, "ts", "pkg", "bin", "archer.mjs"), "upgrade", tgz, "--no-claude", "--no-codex"],
    { cwd: scratch, env },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  expect(status, output).toBe(0);
  expect(output).toContain("installed");
  expect(output).toContain("Archer was not running");
  expect(Date.now() - started).toBeLessThan(60_000);
}, 90_000);
