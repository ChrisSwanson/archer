// node --test tools/devkit/test/artifact-chain.test.mjs
// The R7 artifact-chain tool (tools/devkit/security/artifact-chain.mjs), shown on a known pass (this
// checkout's package, built twice with ts/scripts/package.ts --skip-ui-build from the existing ui/dist:
// SHA256SUMS verifies, nothing runs at install, every bundled package is in the lockfile, and the second
// build is byte-identical) and on seeded fails: one byte changed in a shipped file (against the original
// SHA256SUMS, and against a SHA256SUMS rewritten to match), a bundled package the lockfile lacks, and an
// install hook planted in the manifest.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sha256, tarEntries, verifyArtifact } from "../security/artifact-chain.mjs";

const TOOL = fileURLToPath(new URL("../security/artifact-chain.mjs", import.meta.url));
const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = join(REPO, "package-lock.json");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "devkit-artifact-chain-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let tgz, reference, name;
const sumsFor = (file, dir) => {
  const p = join(dir, "SHA256SUMS");
  writeFileSync(p, `${sha256(readFileSync(file))}  ${name}\n`);
  return p;
};

/** One package build into `dir`, as package.ts writes it; returns the tarball path. */
function pack(dir) {
  const out = spawnSync(
    process.execPath,
    ["--import", "tsx", join(REPO, "ts/scripts/package.ts"), dir, "--skip-ui-build"],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return out.stdout
    .trim()
    .split("\n")
    .find((l) => l.endsWith(".tgz"));
}

/** The tarball unpacked, changed by `edit(root)`, and packed again with tar into `dir`. */
function repack(dir, edit) {
  const root = join(dir, "x");
  mkdirSync(root, { recursive: true });
  assert.equal(spawnSync("tar", ["xzf", tgz, "-C", root]).status, 0);
  edit(join(root, "package"));
  mkdirSync(join(dir, "out"), { recursive: true });
  const file = join(dir, "out", name);
  assert.equal(spawnSync("tar", ["czf", file, "-C", root, "package"]).status, 0);
  return file;
}

before(() => {
  tgz = pack(join(scratch, "a"));
  reference = pack(join(scratch, "b"));
  name = tgz.split("/").pop();
});

test("known pass: SHA256SUMS verifies, no install-time code, bundled set in the lockfile, rebuild byte-identical", () => {
  const sums = sumsFor(tgz, join(scratch, "a"));
  const result = verifyArtifact({ tgz, sums, lock: LOCK, reference });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.comparison.identical, true);
  assert.deepEqual(result.installScripts, []);
  assert.ok(result.bundled.length > 30, `${result.bundled.length} bundled packages`);
  assert.ok(result.bundled.some((b) => b.key === "node_modules/mermaid"));
  assert.ok(!result.bundled.some((b) => b.key === "node_modules/dompurify"), "DOMPurify is aliased to a stub");
  assert.ok(result.notices > 30);
  const cli = spawnSync(
    process.execPath,
    [TOOL, "verify", "--tgz", tgz, "--sums", sums, "--lock", LOCK, "--reference", reference],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("seeded fail: one byte changed in a shipped file fails SHA256SUMS, and the rebuild comparison even with matching sums", () => {
  const dir = join(scratch, "tampered");
  mkdirSync(dir, { recursive: true });
  // Same size, so every header and offset stays valid: only the file's bytes (and the gzip) change.
  const tar = gunzipSync(readFileSync(tgz));
  const target = tarEntries(readFileSync(tgz)).find((e) => e.path === "package/bin/archer.mjs");
  const at = tar.indexOf(target.data) + 10;
  tar[at] = tar[at] ^ 0x20;
  const file = join(dir, name);
  writeFileSync(file, gzipSync(tar));
  const original = join(dir, "SHA256SUMS.orig");
  writeFileSync(original, readFileSync(sumsFor(tgz, join(scratch, "a"))));

  const stale = verifyArtifact({ tgz: file, sums: original, lock: LOCK, reference });
  assert.equal(stale.ok, false);
  assert.ok(
    stale.failures.some((f) => f.startsWith("SHA256SUMS says")),
    stale.failures.join("\n"),
  );

  const forged = verifyArtifact({ tgz: file, sums: sumsFor(file, dir), lock: LOCK, reference });
  assert.equal(forged.ok, false);
  assert.ok(!forged.failures.some((f) => f.startsWith("SHA256SUMS")), "the forged sums match the tampered file");
  assert.deepEqual(forged.comparison.differences, [{ path: "package/bin/archer.mjs", change: "content" }]);

  const cli = spawnSync(
    process.execPath,
    [TOOL, "verify", "--tgz", file, "--sums", original, "--lock", LOCK, "--reference", reference],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /^FAIL /);
});

test("seeded fail: a byte overwritten in the compressed stream is reported, not thrown", () => {
  const dir = join(scratch, "corrupt");
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(readFileSync(tgz));
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const file = join(dir, name);
  writeFileSync(file, bytes);
  const result = verifyArtifact({ tgz: file, sums: sumsFor(file, dir), lock: LOCK, reference });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.startsWith("unreadable tarball")),
    result.failures.join("\n"),
  );
  assert.equal(result.comparison.identical, false);
});

test("seeded fail: a bundled package the lockfile lacks", () => {
  const dir = join(scratch, "foreign");
  const file = repack(dir, (pkg) => {
    const chunk = join(pkg, "dist", "archer.js");
    writeFileSync(chunk, `${readFileSync(chunk, "utf8")}\n// node_modules/left-padder/index.js\nvar pad = 1;\n`);
  });
  const result = verifyArtifact({ tgz: file, sums: sumsFor(file, join(dir, "out")), lock: LOCK });
  assert.deepEqual(result.failures, ["bundled node_modules/left-padder is not in the lockfile"]);
});

test("seeded fail: an install hook in the shipped manifest", () => {
  const dir = join(scratch, "hook");
  const file = repack(dir, (pkg) => {
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    manifest.scripts.postinstall = "node bin/setup.mjs";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
  });
  const result = verifyArtifact({ tgz: file, sums: sumsFor(file, join(dir, "out")), lock: LOCK });
  assert.deepEqual(result.failures, ["install-time code in the tarball: package/package.json postinstall"]);
});

// The repacked trees are system tar's, so the parser is also shown on a second producer's format.
test("tarEntries reads system tar's output as it reads npm pack's", () => {
  const dir = join(scratch, "same");
  const file = repack(dir, () => {});
  const ours = tarEntries(readFileSync(tgz))
    .map((e) => `${e.path} ${e.sha256}`)
    .sort();
  const theirs = tarEntries(readFileSync(file))
    .filter((e) => e.type === "0")
    .map((e) => `${e.path} ${e.sha256}`)
    .sort();
  assert.deepEqual(theirs, ours);
});
