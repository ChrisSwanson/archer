#!/usr/bin/env node
// R7 release integrity (docs/quality/rubrics/security.md §3 R7): the shipped-bytes chain
// package .tgz → SHA256SUMS → tag → lockfile, and a comparison with the last released artifact.
//
//   node tools/devkit/security/artifact-chain.mjs run [--out <dir>] [--tag v0.8.0] [--no-candidate] [--no-ci]
//   node tools/devkit/security/artifact-chain.mjs verify --tgz <f> --sums <SHA256SUMS> --lock <package-lock.json>
//        [--reference <tgz>] [--json]
//
// `run` does all of it:
//   1. candidate: in this checkout, the release.yml commands (`npm ci --prefer-offline --no-audit
//      --fund=false`, `npm --workspace ts run package`), SHA256SUMS as release.yml writes it, then the
//      package step again: the two tarballs must be byte-identical (reproducible). --no-ci skips npm ci.
//   2. published: the tag's release assets from the forge at $ARCHER_FORGE_URL, repository
//      $ARCHER_FORGE_REPO (a Gitea-style release API; TLS pinned to $ARCHER_FORGE_CA when set;
//      anonymous first, then the git credential helper's basic auth, never printed), SHA256SUMS checked;
//      the tag rebuilt in a scratch `git worktree` (removed afterwards) with the same commands, and its
//      bytes compared with the published tarball.
//   3. each tarball's chain: its file list, install scripts, and every bundled package (esbuild's
//      `// node_modules/...` path comments and THIRD_PARTY_NOTICES.md's name@version) found in the
//      lockfile it was built from, with an npm registry `resolved` and a sha512 `integrity`.
// Writes report.json and report.md to --out (default: a new directory under the OS temp dir).
// `verify` is step 3 plus the SHA256SUMS check and an optional reference comparison, on given files.
// Exit 0 when every check holds, 1 otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FORGE = process.env.ARCHER_FORGE_URL ?? "https://forge.invalid";
const FORGE_REPO = process.env.ARCHER_FORGE_REPO ?? "owner/archer";
const FORGE_USER = process.env.ARCHER_FORGE_USER ?? "git";
const FORGE_CA = process.env.ARCHER_FORGE_CA;
const REGISTRY = "https://registry.npmjs.org/";
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Entries of a gzipped tar (ustar, with pax `path` overrides): path, type, mode, uid, gid, mtime, size, sha256, data. */
export function tarEntries(tgz) {
  const tar = gunzipSync(tgz);
  const entries = [];
  const str = (b, o, n) => {
    const s = b.subarray(o, o + n);
    const z = s.indexOf(0);
    return (z < 0 ? s : s.subarray(0, z)).toString("utf8");
  };
  const num = (b, o, n) => parseInt(str(b, o, n).trim() || "0", 8);
  let pax = {};
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = num(h, 124, 12),
      type = str(h, 156, 1) || "0";
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const line of data.toString("utf8").split("\n").filter(Boolean)) {
        const kv = line.slice(line.indexOf(" ") + 1),
          eq = kv.indexOf("=");
        pax[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h, 345, 155),
      name = str(h, 0, 100);
    const path = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = {};
    entries.push({
      path,
      type,
      mode: num(h, 100, 8),
      uid: num(h, 108, 8),
      gid: num(h, 116, 8),
      mtime: num(h, 136, 12),
      size,
      sha256: sha256(data),
      data,
    });
  }
  return entries;
}

/** SHA256SUMS text (`<hex>  <name>` per line) → Map name → hex. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS: unreadable line ${JSON.stringify(line)}`);
    sums.set(m[2], m[1]);
  }
  return sums;
}

/** Install-time code in the tarball: lifecycle hooks in any package.json, native build files, prebuilt addons. */
export function installScripts(entries) {
  const found = [];
  for (const e of entries) {
    if (/(^|\/)package\.json$/.test(e.path)) {
      let scripts = {};
      try {
        scripts = JSON.parse(e.data.toString("utf8")).scripts ?? {};
      } catch {
        found.push({ path: e.path, hook: "unparseable package.json" });
        continue;
      }
      for (const hook of INSTALL_HOOKS)
        if (scripts[hook] !== undefined) found.push({ path: e.path, hook, command: scripts[hook] });
    }
    if (/(^|\/)binding\.gyp$/.test(e.path) || /\.node$/.test(e.path))
      found.push({ path: e.path, hook: "native build or addon" });
  }
  return found;
}

/** Lockfile keys (`node_modules/a/node_modules/b`) of the packages esbuild bundled, from its path comments. */
export function bundledPackages(entries) {
  const keys = new Set();
  const re = /^\/\/ (?:\.\.\/)*((?:node_modules\/(?:@[^/\s]+\/)?[^/\s]+\/?)+)/gm;
  for (const e of entries) {
    if (!/\.(m?js|cjs)$/.test(e.path)) continue;
    for (const m of e.data.toString("utf8").matchAll(re)) keys.add(m[1].replace(/\/$/, ""));
  }
  return [...keys].sort();
}

/** name@version of each package THIRD_PARTY_NOTICES.md names. */
export function noticePackages(entries) {
  const notices = entries.find((e) => e.path === "package/THIRD_PARTY_NOTICES.md");
  if (!notices) return null;
  return [...notices.data.toString("utf8").matchAll(/^## (.+)@([^@\s]+)$/gm)].map((m) => ({
    name: m[1],
    version: m[2],
  }));
}

/** Lockfile entries with an install hook (`hasInstallScript`), the root's own scripts included. */
export function lockInstallScripts(lock, rootScripts = {}) {
  return Object.entries(lock.packages)
    .filter(([, v]) => v.hasInstallScript)
    .map(([key, v]) => ({
      key: key || "(root)",
      version: v.version,
      dev: v.dev === true,
      optional: v.optional === true,
      ...(key === ""
        ? { scripts: Object.fromEntries(Object.entries(rootScripts).filter(([k]) => INSTALL_HOOKS.includes(k))) }
        : {}),
    }));
}

/** The root package.json's scripts beside a lockfile (the lockfile records only that the root has one). */
function rootScripts(lock) {
  const manifest = join(dirname(lock), "package.json");
  return existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {}) : {};
}

/** Each bundled key and each notice name@version, checked against the lockfile. */
export function lockCheck(lock, bundled, notices) {
  const failures = [],
    rows = [];
  const pinned = (key, v) => {
    if (v.link) return null;
    if (typeof v.resolved !== "string" || !v.resolved.startsWith(REGISTRY))
      return `${key}: resolved ${v.resolved ?? "missing"} is not the npm registry`;
    if (typeof v.integrity !== "string" || !v.integrity.startsWith("sha512-")) return `${key}: no sha512 integrity`;
    return null;
  };
  for (const key of bundled) {
    const v = lock.packages[key];
    if (!v) {
      failures.push(`bundled ${key} is not in the lockfile`);
      continue;
    }
    if (v.dev) failures.push(`bundled ${key} is a dev-only lockfile entry`);
    const bad = pinned(key, v);
    if (bad) failures.push(`bundled ${bad}`);
    rows.push({ key, version: v.version, integrity: v.integrity, resolved: v.resolved });
  }
  const byNameVersion = new Map();
  for (const [key, v] of Object.entries(lock.packages)) {
    const name = v.name ?? key.replace(/^.*node_modules\//, "");
    if (key && !v.link) byNameVersion.set(`${name}@${v.version}`, [key, v]);
  }
  for (const { name, version } of notices ?? []) {
    const hit = byNameVersion.get(`${name}@${version}`);
    if (!hit) {
      failures.push(`notice ${name}@${version} is not in the lockfile`);
      continue;
    }
    // A workspace member (`ts`, `ui`) is this repository's own source, not a registry package.
    const bad = hit[0].includes("node_modules/") ? pinned(...hit) : null;
    if (bad) failures.push(`notice ${bad}`);
  }
  if (notices === null) failures.push("THIRD_PARTY_NOTICES.md is missing from the tarball");
  return { failures, bundled: rows };
}

/** Byte comparison of two tarballs; when they differ, which entries differ and how. */
export function compareTarballs(a, b) {
  if (a.equals(b)) return { identical: true, sha256: sha256(a) };
  let ea, eb;
  try {
    ea = new Map(tarEntries(a).map((e) => [e.path, e]));
    eb = new Map(tarEntries(b).map((e) => [e.path, e]));
  } catch (error) {
    return {
      identical: false,
      sha256: [sha256(a), sha256(b)],
      unreadable: error.message,
      differences: [],
      differenceCount: 1,
    };
  }
  const meta = (e) => `${e.type} ${e.mode.toString(8)} ${e.uid}:${e.gid} ${e.mtime}`;
  const differences = [];
  for (const [p, x] of ea) {
    const y = eb.get(p);
    if (!y) differences.push({ path: p, change: "only in first" });
    else if (x.sha256 !== y.sha256) differences.push({ path: p, change: "content" });
    else if (meta(x) !== meta(y)) differences.push({ path: p, change: `metadata ${meta(x)} → ${meta(y)}` });
  }
  for (const p of eb.keys()) if (!ea.has(p)) differences.push({ path: p, change: "only in second" });
  const order = [...ea.keys()].join("\n") === [...eb.keys()].filter((p) => ea.has(p)).join("\n");
  return {
    identical: false,
    sha256: [sha256(a), sha256(b)],
    sameEntriesAndOrder: order && ea.size === eb.size,
    differences: differences.slice(0, 200),
    differenceCount: differences.length,
  };
}

/** The chain checks for one tarball: SHA256SUMS, install scripts, bundled set vs lockfile, optional reference. */
export function verifyArtifact({ tgz, sums, lock, reference }) {
  const failures = [];
  const name = basename(tgz);
  const bytes = readFileSync(tgz);
  const digest = sha256(bytes);
  let listed;
  try {
    listed = parseSums(readFileSync(sums, "utf8")).get(name);
  } catch (error) {
    failures.push(String(error.message));
  }
  if (listed === undefined) failures.push(`SHA256SUMS lists no ${name}`);
  else if (listed !== digest) failures.push(`SHA256SUMS says ${listed} for ${name}, the file is ${digest}`);
  let entries = [];
  try {
    entries = tarEntries(bytes);
  } catch (error) {
    failures.push(`unreadable tarball: ${error.message}`);
  }
  const scripts = installScripts(entries);
  for (const s of scripts) failures.push(`install-time code in the tarball: ${s.path} ${s.hook}`);
  const lockfile = JSON.parse(readFileSync(lock, "utf8"));
  const bundled = bundledPackages(entries);
  const check = lockCheck(lockfile, bundled, noticePackages(entries));
  failures.push(...check.failures);
  let comparison;
  if (reference) {
    comparison = compareTarballs(bytes, readFileSync(reference));
    if (!comparison.identical)
      failures.push(`${name} differs from ${reference} (${comparison.differenceCount} entries)`);
  }
  const manifest = entries.find((e) => e.path === "package/package.json");
  return {
    ok: failures.length === 0,
    failures,
    tgz,
    sha256: digest,
    size: bytes.length,
    manifest: manifest ? JSON.parse(manifest.data.toString("utf8")) : null,
    files: entries.map((e) => ({
      path: e.path,
      size: e.size,
      mode: e.mode.toString(8),
      mtime: e.mtime,
      sha256: e.sha256,
    })),
    installScripts: scripts,
    lockInstallScripts: lockInstallScripts(lockfile, rootScripts(lock)),
    bundled: check.bundled,
    notices: noticePackages(entries)?.length ?? 0,
    comparison,
  };
}

// ---- run: builds, downloads and the scratch worktree -------------------------------------------

function sh(cmd, args, cwd, log) {
  const out = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(log, `$ ${cmd} ${args.join(" ")}\n${out.stdout}${out.stderr}`, { flag: "a" });
  if (out.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd} (exit ${out.status}); see ${log}`);
  return out.stdout;
}

/** release.yml's npm ci and package steps in `tree`; the tarball copied to `into`, with SHA256SUMS beside it. */
export function releaseBuild(tree, into, { ci = true, log } = {}) {
  mkdirSync(into, { recursive: true });
  const version = JSON.parse(readFileSync(join(tree, "ts/package.json"), "utf8")).version;
  if (ci) sh("npm", ["ci", "--prefer-offline", "--no-audit", "--fund=false"], tree, log);
  rmSync(join(tree, "dist"), { recursive: true, force: true });
  sh("npm", ["--workspace", "ts", "run", "package"], tree, log);
  const name = `archer-${version}.tgz`;
  const built = join(tree, "dist", name);
  if (!existsSync(built)) throw new Error(`no dist/${name}`);
  copyFileSync(built, join(into, name));
  writeFileSync(join(into, "SHA256SUMS"), `${sha256(readFileSync(built))}  ${name}\n`);
  return { version, tgz: join(into, name), sums: join(into, "SHA256SUMS") };
}

function credentialAuth() {
  const out = spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${new URL(FORGE).host}\nusername=${FORGE_USER}\n\n`,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const pass = /^password=(.*)$/m.exec(out.stdout ?? "")?.[1];
  return pass ? `Basic ${Buffer.from(`${FORGE_USER}:${pass}`).toString("base64")}` : null;
}

function get(url, ca, auth, hops = 5) {
  return new Promise((resolveGet, reject) => {
    const req = request(url, { ca, headers: auth ? { authorization: auth } : {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        resolveGet(get(next.href, ca, next.host === new URL(url).host ? auth : null, hops - 1));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveGet({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchForge(url, ca) {
  let res = await get(url, ca, null);
  if (res.status === 401 || res.status === 404) {
    const auth = credentialAuth();
    if (auth) res = await get(url, ca, auth);
  }
  if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.body;
}

/** The tag's release and its assets, downloaded into `into`. */
export async function downloadRelease(tag, into) {
  mkdirSync(into, { recursive: true });
  const ca = FORGE_CA ? readFileSync(resolve(REPO, FORGE_CA)) : undefined;
  const release = JSON.parse(
    (await fetchForge(`${FORGE}/api/v1/repos/${FORGE_REPO}/releases/tags/${tag}`, ca)).toString("utf8"),
  );
  writeFileSync(join(into, "release.json"), JSON.stringify(release, null, 2));
  const assets = [];
  for (const asset of release.assets) {
    const body = await fetchForge(asset.browser_download_url, ca);
    if (body.length !== asset.size)
      throw new Error(`${asset.name}: ${body.length} bytes, the release says ${asset.size}`);
    writeFileSync(join(into, asset.name), body);
    assets.push({ name: asset.name, size: asset.size, sha256: sha256(body), created_at: asset.created_at });
  }
  return { tag: release.tag_name, draft: release.draft, published_at: release.published_at, assets };
}

/** The tag object: commit, annotated or not, signed or not. */
function tagFacts(tag) {
  const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  const type = git("cat-file", "-t", tag);
  const body = type === "tag" ? git("cat-file", "-p", tag) : "";
  return {
    tag,
    type,
    commit: git("rev-parse", `${tag}^{commit}`),
    signed: /-----BEGIN (PGP|SSH) SIGNATURE-----/.test(body),
  };
}

function worktreesDir() {
  const common = resolve(
    REPO,
    execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: REPO, encoding: "utf8" }).trim(),
  );
  return join(dirname(common), ".claude", "worktrees");
}

async function run(options) {
  const out = resolve(options.out ?? mkdtempSync(join(tmpdir(), "artifact-chain-")));
  mkdirSync(out, { recursive: true });
  const log = join(out, "commands.log");
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    failures: [],
  };
  const fail = (where, list) => report.failures.push(...list.map((f) => `${where}: ${f}`));

  if (options.candidate) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    const one = releaseBuild(REPO, join(out, "candidate", "build-1"), { ci: options.ci, log });
    const two = releaseBuild(REPO, join(out, "candidate", "build-2"), { ci: false, log });
    const verified = verifyArtifact({
      tgz: one.tgz,
      sums: one.sums,
      lock: join(REPO, "package-lock.json"),
      reference: two.tgz,
    });
    report.candidate = {
      commit: head,
      trackedChanges: dirty !== "",
      version: one.version,
      ...verified,
      reproducible: verified.comparison.identical,
    };
    fail("candidate", verified.failures);
    if (dirty) fail("candidate", ["tracked files differ from HEAD: the build is not of a commit"]);
  }

  const tag = tagFacts(options.tag);
  report.tag = tag;
  const published = join(out, "published");
  report.published = await downloadRelease(options.tag, published);
  const sums = parseSums(readFileSync(join(published, "SHA256SUMS"), "utf8"));
  const tgzName = [...sums.keys()].find((n) => n.endsWith(".tgz"));
  if (!tgzName) fail("published", ["SHA256SUMS lists no .tgz"]);
  const tree = join(worktreesDir(), `artifact-chain-${options.tag}-${process.pid}`);
  try {
    sh("git", ["worktree", "add", "--detach", tree, tag.commit], REPO, log);
    const rebuilt = releaseBuild(tree, join(out, "rebuilt-tag"), { ci: true, log });
    for (const file of ["package-lock.json", "package.json"])
      copyFileSync(join(tree, file), join(out, "rebuilt-tag", file));
    if (tgzName) {
      const verified = verifyArtifact({
        tgz: join(published, tgzName),
        sums: join(published, "SHA256SUMS"),
        lock: join(out, "rebuilt-tag", "package-lock.json"),
        reference: rebuilt.tgz,
      });
      report.published = { ...report.published, ...verified, reproducedFromTag: verified.comparison.identical };
      fail("published", verified.failures);
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: REPO });
  }

  if (report.candidate && report.published?.files) {
    const c = new Map(report.candidate.files.map((f) => [f.path, f.sha256])),
      p = new Map(report.published.files.map((f) => [f.path, f.sha256]));
    report.candidateVsPublished = {
      sameVersion: report.candidate.version === report.published.manifest?.version,
      added: [...c.keys()].filter((k) => !p.has(k)),
      removed: [...p.keys()].filter((k) => !c.has(k)),
      changed: [...c.keys()].filter((k) => p.has(k) && p.get(k) !== c.get(k)),
      bundledVersions: versionDelta(
        report.published.bundled.map((b) => [b.key, b.version]),
        report.candidate.bundled.map((b) => [b.key, b.version]),
      ),
      noticeVersions: versionDelta(noticeList(join(published, tgzName)), noticeList(report.candidate.tgz)),
    };
  }
  report.ok = report.failures.length === 0;
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), markdown(report));
  return { out, report };
}

const noticeList = (tgz) => (noticePackages(tarEntries(readFileSync(tgz))) ?? []).map((n) => [n.name, n.version]);

/** name → version pairs: what was added, removed or changed between `before` and `after`. */
export function versionDelta(before, after) {
  const group = (pairs) => {
    const m = new Map();
    for (const [k, v] of pairs) m.set(k, [...(m.get(k) ?? []), v].sort());
    return m;
  };
  const a = group(before),
    b = group(after),
    out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = (a.get(k) ?? []).join(","),
      y = (b.get(k) ?? []).join(",");
    if (x !== y) out.push(`${k} ${x || "—"} → ${y || "—"}`);
  }
  return out.sort();
}

function markdown(r) {
  const lines = [
    `# R7 artifact chain (${r.date})`,
    "",
    `Node ${r.node}, npm ${r.npm}. Verdict: **${r.ok ? "chain holds" : "FAILURES"}**`,
    "",
  ];
  if (r.failures.length) lines.push("## Failures", "", ...r.failures.map((f) => `- ${f}`), "");
  const block = (title, a, extra) => {
    lines.push(
      `## ${title}`,
      "",
      `- tarball \`${basename(a.tgz)}\` ${a.size} bytes, sha256 \`${a.sha256}\``,
      ...extra,
      `- ${a.files.length} files; install-time code in the tarball: ${a.installScripts.length ? a.installScripts.map((s) => `${s.path} ${s.hook}`).join(", ") : "none"}`,
      `- manifest scripts: ${JSON.stringify(a.manifest?.scripts ?? {})}; dependencies: ${JSON.stringify(a.manifest?.dependencies ?? {})}`,
      `- lockfile install hooks: ${a.lockInstallScripts.map((s) => `${s.key}@${s.version ?? ""}${s.dev ? " (dev)" : ""}${s.optional ? " (optional)" : ""}${s.scripts ? ` ${JSON.stringify(s.scripts)}` : ""}`).join("; ")}`,
      `- bundled packages (esbuild path comments): ${a.bundled.length}, each in the lockfile with registry \`resolved\` and sha512 \`integrity\` unless listed under failures; THIRD_PARTY_NOTICES entries: ${a.notices}`,
      "",
      "| lockfile key | version | integrity |",
      "|---|---|---|",
      ...a.bundled.map((b) => `| ${b.key} | ${b.version} | \`${(b.integrity ?? "").slice(0, 27)}…\` |`),
      "",
    );
  };
  if (r.candidate)
    block(`Candidate ${r.candidate.commit.slice(0, 7)} (version ${r.candidate.version})`, r.candidate, [
      `- reproducible (second package run byte-identical): **${r.candidate.reproducible}**`,
    ]);
  if (r.published?.files)
    block(
      `Published ${r.tag.tag} (${r.tag.type}, commit ${r.tag.commit.slice(0, 7)}, signed: ${r.tag.signed})`,
      r.published,
      [
        `- assets: ${r.published.assets.map((a) => `${a.name} ${a.sha256}`).join("; ")}`,
        `- rebuilt from the tag in a scratch worktree, byte-identical to the published tarball: **${r.published.reproducedFromTag}**`,
      ],
    );
  if (r.candidateVsPublished) {
    const d = r.candidateVsPublished;
    lines.push(
      "## Candidate vs last release",
      "",
      `- same version string: ${d.sameVersion}${d.sameVersion ? " (the candidate's bytes differ from the release of that version: bump before tagging)" : ""}`,
      `- files added ${d.added.length}, removed ${d.removed.length}, changed ${d.changed.length} (esbuild chunk names carry a content hash, so a changed chunk shows as one added and one removed; lists in report.json)`,
      `- changed in place: ${d.changed.join(", ") || "none"}`,
      `- bundled package versions (esbuild path comments): ${d.bundledVersions.join("; ") || "unchanged"}`,
      `- THIRD_PARTY_NOTICES versions: ${d.noticeVersions.join("; ") || "unchanged"}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      tag: { type: "string", default: "v0.8.0" },
      "no-candidate": { type: "boolean" },
      "no-ci": { type: "boolean" },
      tgz: { type: "string" },
      sums: { type: "string" },
      lock: { type: "string" },
      reference: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "run";
  if (command === "verify") {
    if (!values.tgz || !values.sums || !values.lock) {
      console.error("verify needs --tgz, --sums and --lock");
      process.exit(2);
    }
    const result = verifyArtifact({
      tgz: values.tgz,
      sums: values.sums,
      lock: values.lock,
      reference: values.reference,
    });
    if (values.json) console.log(JSON.stringify({ ...result, files: result.files.length }, null, 2));
    else
      console.log(
        `${result.ok ? "ok" : "FAIL"} ${result.tgz} sha256 ${result.sha256}, ${result.files.length} files, ${result.bundled.length} bundled packages${result.comparison ? `, identical to reference: ${result.comparison.identical}` : ""}${result.failures.map((f) => `\n  - ${f}`).join("")}`,
      );
    process.exit(result.ok ? 0 : 1);
  } else if (command === "run") {
    const { out, report } = await run({
      out: values.out,
      tag: values.tag,
      candidate: !values["no-candidate"],
      ci: !values["no-ci"],
    });
    console.log(readFileSync(join(out, "report.md"), "utf8").split("\n| lockfile key")[0]);
    console.log(`report: ${join(out, "report.md")}`);
    process.exit(report.ok ? 0 : 1);
  } else {
    console.error(`unknown command ${command}: run or verify`);
    process.exit(2);
  }
}
