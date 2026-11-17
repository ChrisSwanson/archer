// Interrupting the scale gate (release-check stops it with SIGTERM) leaves no sandbox, record or work directory behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PAGE = join(REPO, "ui/dist/index.html");

test("SIGTERM during a run tears the sandbox down, removes its record and work directory, and exits 3", {
  skip: !existsSync(PAGE) && "needs a built ui/dist/index.html",
  timeout: 120_000,
}, async () => {
  // A private registry and temp root: this test inspects and removes only what it made.
  const scratch = mkdtempSync(join(tmpdir(), "archer-scale-signal-"));
  const registry = join(scratch, "registry"),
    tmp = join(scratch, "tmp");
  for (const dir of [registry, tmp]) await import("node:fs").then((fs) => fs.mkdirSync(dir));
  const out = join(scratch, "out");
  // Sandbox roots must sit directly under os.tmpdir() to be deletable by `down`, so keep the real tmpdir for them
  // and watch the registry (private) for the sandbox record instead.
  const child = spawn(
    process.execPath,
    [join(REPO, "tools/perf/scale-gates.mjs"), "--sizes", "S", "--page", PAGE, "--out", out],
    {
      cwd: REPO,
      env: { ...process.env, ARCHER_DEVKIT_REGISTRY: registry },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
  try {
    const deadline = Date.now() + 90_000;
    // The record is written before the service spawns; wait for the service to be up so there is something to stop.
    let record = null;
    while (Date.now() < deadline && record === null) {
      await new Promise((r) => setTimeout(r, 200));
      const file = readdirSync(registry).find((f) => /^sg-s-.*\.json$/.test(f));
      if (file) {
        try {
          const r = JSON.parse((await import("node:fs")).readFileSync(join(registry, file), "utf8"));
          if (r.pid && r.root) record = r;
        } catch {
          /* mid-write */
        }
      }
    }
    assert.ok(record, `no sandbox record appeared; stderr: ${stderr.slice(-300)}`);
    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.code, 3, `exit ${JSON.stringify(result)}; stderr: ${stderr.slice(-300)}`);
    assert.deepEqual(readdirSync(registry), [], "the sandbox record is removed");
    assert.equal(existsSync(record.root), false, "the sandbox root is removed");
    let alive = true;
    try {
      process.kill(record.pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the sandbox service is stopped");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
});
