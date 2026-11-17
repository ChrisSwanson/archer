// node --test tools/devkit/test/*.test.mjs
// Sandbox safety: names, record identity, corpus isolation and process identity. Uses its own
// registry (ARCHER_DEVKIT_REGISTRY), never tools/devkit/.sandboxes, and never starts a service.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "devkit-sandbox-test-")));
process.env.ARCHER_DEVKIT_REGISTRY = join(scratch, "registry");
mkdirSync(process.env.ARCHER_DEVKIT_REGISTRY);
const sb = await import("../sandbox.mjs");
const roots = [];
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A sandbox-shaped root and record, as `up` leaves them, for a process the test owns. */
function fakeSandbox(name, extra = {}) {
  const nonce = "0123456789abcdef0123456789abcdef";
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archer-devkit-${name}-`)));
  roots.push(root);
  writeFileSync(join(root, ".archer-devkit-sandbox"), JSON.stringify({ name, nonce }));
  const record = { name, nonce, root, pid: null, ...extra };
  writeFileSync(sb.registryPath(name), JSON.stringify(record));
  return record;
}

test("every name goes through one validated registry path", async () => {
  assert.equal(sb.registryPath("smoke-a"), join(sb.REGISTRY, "smoke-a.json"));
  for (const bad of ["../../../package", "../victim", "A", "", "-x", "a/b", "a".repeat(42), "a.json", undefined])
    assert.throws(() => sb.registryPath(bad), /sandbox name must match/, String(bad));
  // `down --name ../victim` cannot reach a JSON file beside the registry.
  const victim = join(sb.REGISTRY, "..", "victim.json");
  writeFileSync(victim, JSON.stringify({ name: "x" }));
  await assert.rejects(sb.down({ name: "../victim" }), /sandbox name must match/);
  assert.equal(existsSync(victim), true);
  assert.throws(() => sb.readRecord("../victim"), /sandbox name must match/);
});

test("down deletes only a record that names itself and carries a nonce", async () => {
  writeFileSync(
    sb.registryPath("impostor"),
    JSON.stringify({ name: "other", nonce: "0123456789abcdef0123456789abcdef" }),
  );
  await assert.rejects(sb.down({ name: "impostor" }), /names "other"/);
  assert.equal(existsSync(sb.registryPath("impostor")), true);
  writeFileSync(sb.registryPath("plain"), JSON.stringify({ name: "plain", version: "1.0.0" }));
  await assert.rejects(sb.down({ name: "plain" }), /no sandbox nonce/);
  assert.equal(existsSync(sb.registryPath("plain")), true);
  const record = fakeSandbox("tidy");
  const result = await sb.down({ name: "tidy" });
  assert.deepEqual(
    [result.stopped, result.removed, existsSync(record.root), existsSync(sb.registryPath("tidy"))],
    ["not-running", true, false, false],
  );
});

test("a corpus copy carries no .git and refuses symlinks", () => {
  const src = join(scratch, "corpus-a"),
    dest = join(scratch, "copy-a");
  mkdirSync(join(src, ".git", "objects"), { recursive: true });
  mkdirSync(join(src, "notes", ".git"), { recursive: true });
  writeFileSync(join(src, "archer.toml"), "version = 1\n");
  writeFileSync(join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(src, "notes", "a.md"), "# a\n");
  sb.copyCorpusProject(src, dest);
  assert.deepEqual(
    [
      existsSync(join(dest, "archer.toml")),
      existsSync(join(dest, "notes", "a.md")),
      existsSync(join(dest, ".git")),
      existsSync(join(dest, "notes", ".git")),
    ],
    [true, true, false, false],
  );
  const linked = join(scratch, "corpus-b");
  mkdirSync(linked);
  symlinkSync("/etc/passwd", join(linked, "escape.md"));
  assert.throws(() => sb.copyCorpusProject(linked, join(scratch, "copy-b")), /symlink/);
});

test("the snapshot repository is fresh and inside the sandbox, whatever GIT_* the caller has", () => {
  const outside = join(scratch, "user-repo");
  mkdirSync(outside);
  const plain = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: sb.withoutGitEnv() });
  plain(outside, "init", "-q");
  const root = join(scratch, "sb-root"),
    dest = join(root, "projects", "p");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "archer.toml"), "version = 1\n");
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  Object.assign(process.env, {
    GIT_DIR: join(outside, ".git"),
    GIT_WORK_TREE: outside,
    GIT_INDEX_FILE: join(outside, ".git", "index"),
  });
  try {
    sb.snapshotRepo(dest, root);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  assert.equal(existsSync(join(dest, ".git", "HEAD")), true);
  assert.equal(plain(dest, "log", "--oneline").stdout.trim().split("\n").length, 1);
  assert.notEqual(plain(outside, "rev-parse", "HEAD").status, 0, "the caller's repository gained no commit");
  assert.equal(existsSync(join(outside, ".git", "index")), false, "nor an index");
  assert.deepEqual(Object.keys(sb.withoutGitEnv({ GIT_DIR: "x", git_work_tree: "y", PATH: "/bin" })), ["PATH"]);
});

test("down signals a recorded PID only while it is still the sandbox's own process", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const identity = sb.processIdentity(child.pid);
    assert.ok(identity !== null && identity.cmdline === "sleep 30" && identity.start);
    // A stale record whose PID now belongs to another process (here: the start time differs).
    fakeSandbox("reused", { pid: child.pid, process: { ...identity, start: `${identity.start}0` } });
    const refused = await sb.down({ name: "reused" });
    assert.deepEqual(
      [refused.stopped, refused.removed, existsSync(sb.registryPath("reused"))],
      ["refused", false, true],
    );
    assert.doesNotThrow(() => process.kill(child.pid, 0), "the process was not signalled");
    // An old-style record (no recorded identity) only matches this worktree's `archer.ts serve`.
    fakeSandbox("legacy", { pid: child.pid, port: 1234, stateDir: "/nowhere" });
    assert.equal((await sb.down({ name: "legacy" })).stopped, "refused");
    // The matching identity: stopped and cleaned.
    fakeSandbox("mine", { pid: child.pid, process: identity });
    const stopped = await sb.down({ name: "mine" });
    assert.deepEqual([stopped.stopped, stopped.removed], ["stopped", true]);
  } finally {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

test("readRecord fills ownerToken for an older record from the sandbox's own state directory", () => {
  const stateDir = join(scratch, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(stateDir, "service.json"), JSON.stringify({ token: "c".repeat(64), port: 1 }), { mode: 0o600 });
  fakeSandbox("older", { stateDir });
  assert.equal(sb.readRecord("older").ownerToken, "c".repeat(64));
  assert.equal(JSON.parse(readFileSync(sb.registryPath("older"), "utf8")).ownerToken, undefined, "not written back");
  chmodSync(join(stateDir, "service.json"), 0o644);
  assert.equal(sb.serviceToken(stateDir), null, "a readable-by-others identity is ignored");
});

test("serviceToken reads the token the service writes today (newToken: 32 hex), and the older 64", async () => {
  const { newToken } = await import("../../../ts/src/service/token.ts");
  const stateDir = join(scratch, "state-current");
  mkdirSync(stateDir, { mode: 0o700 });
  for (const token of [newToken(), "d".repeat(64)]) {
    writeFileSync(join(stateDir, "service.json"), JSON.stringify({ token, port: 1 }), { mode: 0o600 });
    assert.equal(sb.serviceToken(stateDir), token);
  }
  writeFileSync(join(stateDir, "service.json"), JSON.stringify({ token: "e".repeat(40), port: 1 }), { mode: 0o600 });
  assert.equal(sb.serviceToken(stateDir), null, "not a credential's spelling");
});

test("--tls material is a throwaway CA and a loopback leaf it signed, private to the sandbox root", async () => {
  const { X509Certificate } = await import("node:crypto");
  const { statSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-devkit-tls-")));
  roots.push(root);
  const tls = sb.sandboxTls(root);
  for (const path of [tls.caPath, tls.certPath, tls.keyPath]) assert.ok(path.startsWith(join(root, "tls") + "/"), path);
  assert.equal(statSync(join(root, "tls")).mode & 0o077, 0);
  assert.equal(statSync(tls.keyPath).mode & 0o077, 0);
  assert.ok(!existsSync(join(root, "tls", "ca.key")), "the CA key is not kept once the leaf is signed");
  const ca = new X509Certificate(readFileSync(tls.caPath)),
    leaf = new X509Certificate(readFileSync(tls.certPath));
  assert.ok(ca.ca);
  assert.ok(leaf.verify(ca.publicKey));
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(leaf.checkHost("localhost"), "localhost");
  assert.ok(Date.parse(leaf.validTo) - Date.now() < 8 * 24 * 3600 * 1000);
});

test("resetPresentations logs in once per link, not on every reset (svc.duplicate-request: the page's login plus two resets)", async () => {
  const { createServer } = await import("node:http");
  const { resetPresentations } = await import("../sandbox.mjs");
  let logins = 0,
    stale = false;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/projects/?token=")) {
      logins++;
      stale = false;
      res.writeHead(303, { location: "/projects/", "set-cookie": `archer-1=c${logins}; Path=/` }).end();
      return;
    }
    if (req.url === "/p/demo/api/diagrams") {
      if (stale || !/archer-1=c\d+/.test(req.headers.cookie ?? "")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"views":[]}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const root = mkdtempSync(join(tmpdir(), "archer-devkit-reset-"));
    const args = { origin, slug: "demo", link: `${origin}/projects/?token=abc`, root };
    for (let i = 0; i < 3; i++) await resetPresentations(args);
    assert.equal(logins, 1);
    // A cookie the service no longer takes (a restarted sandbox) is replaced by one new login.
    stale = true;
    await resetPresentations(args);
    assert.equal(logins, 2);
    rmSync(root, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test("restart refuses a record from before restart existed; up refuses an unknown comment_submission", async () => {
  fakeSandbox("oldrec", { link: "http://127.0.0.1:1/projects/" });
  await assert.rejects(sb.restart({ name: "oldrec" }), /no serveArgs/);
  await assert.rejects(sb.startService({ name: "oldrec" }), /no serveArgs/);
  await assert.rejects(sb.restart({ name: "nosuch" }), /needs --name of a sandbox/);
  await assert.rejects(
    sb.up({ name: "badmode", commentSubmission: "later" }),
    /--comment-submission must be one of immediate, queued/,
  );
  assert.equal(existsSync(sb.registryPath("badmode")), false);
});

test("every file in a corpus copy's Archer folder has its snapshot commit's time, also after a reset (O72)", () => {
  // The project page lists files most recently edited first (file mtime), so a copy whose files landed a few
  // milliseconds apart, or a reset that rewrote one, put the rows in a different order on each sandbox.
  const root = join(scratch, "sb-times"),
    dest = join(root, "projects", "p");
  mkdirSync(join(dest, ".archer", "diagrams"), { recursive: true });
  writeFileSync(join(dest, "archer.toml"), "version = 1\n");
  for (const name of ["a.mmd", "b.mmd", "c.mmd"])
    writeFileSync(join(dest, ".archer", "diagrams", name), `flowchart LR\n ${name[0]} --> z\n`);
  utimesSync(join(dest, ".archer", "diagrams", "c.mmd"), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  sb.snapshotRepo(dest, root);
  const at =
    Number(
      spawnSync("git", ["log", "-1", "--format=%ct"], {
        cwd: dest,
        encoding: "utf8",
        env: sb.withoutGitEnv(),
      }).stdout.trim(),
    ) * 1000;
  const times = () =>
    ["a.mmd", "b.mmd", "c.mmd"].map((name) => statSync(join(dest, ".archer", "diagrams", name)).mtimeMs);
  assert.deepEqual(times(), [at, at, at]);
  writeFileSync(join(dest, ".archer", "diagrams", "b.mmd"), "flowchart LR\n changed\n");
  spawnSync("git", ["checkout", "-q", "--", "."], { cwd: dest, env: sb.withoutGitEnv() });
  assert.notEqual(times()[1], at);
  sb.settleCorpusTimes(dest);
  assert.deepEqual(times(), [at, at, at]);
});

test("a sandbox's service never stops on idle; the rest of its processes, and the product default, keep the setting they had (O126)", () => {
  const env = sb.serviceEnv({ root: "/tmp/archer-devkit-x" });
  assert.equal(env.ARCHER_IDLE_TIMEOUT_MS, "0");
  // Whatever the caller's shell says: a long flows-prove run must not lose its service half way (O123).
  const before = process.env.ARCHER_IDLE_TIMEOUT_MS;
  process.env.ARCHER_IDLE_TIMEOUT_MS = "1800000";
  try {
    assert.equal(sb.serviceEnv({ root: "/tmp/archer-devkit-x" }).ARCHER_IDLE_TIMEOUT_MS, "0");
  } finally {
    if (before === undefined) delete process.env.ARCHER_IDLE_TIMEOUT_MS;
    else process.env.ARCHER_IDLE_TIMEOUT_MS = before;
  }
  assert.equal("ARCHER_IDLE_TIMEOUT_MS" in sb.sandboxEnv({ root: "/tmp/archer-devkit-x" }), false);
});
