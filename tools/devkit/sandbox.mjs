#!/usr/bin/env node
// Throwaway Archer services for smoke tests. Each sandbox is one `archer serve --foreground`
// from THIS worktree, with ARCHER_DEBUG=1, its own state directory, home and global config
// under a fresh temporary root, a free loopback port, plain HTTP (--force-http) or with --tls
// HTTPS from a throwaway CA under the root (--http2 adds ARCHER_HTTP2=1: h2 and HTTP/1.1 on the
// port), copies of the corpus projects (git-initialised), and one editing link for all of them.
// The user's own service (default state dir, and the ports in ARCHER_RESERVED_PORTS, comma-separated)
// and repos are never touched.
// --host <ip> binds that address instead of loopback, for a person on another machine (plain HTTP
// crosses the network unless --tls; the --tls leaf then also names that IP).
//
//   node tools/devkit/sandbox.mjs up   [--name <n>] [--corpus <dir>] [--page <file>] [--zero-projects] [--embedded] [--debug-ui] [--profiling] [--tls [--http2]] [--host <ip>]
//        [--comment-submission immediate|queued]   (writes [service] comment_submission into the sandbox's archer.toml)
//   node tools/devkit/sandbox.mjs restart --name <n>   stop and start the same service: same port, state, links and
//        projects (restored from its state directory); waits until every project answers again
//   node tools/devkit/sandbox.mjs stop|start --name <n> [--kill]   the two halves of restart (act while the service is
//        down); stop --kill sends SIGKILL (the service killed) instead of SIGTERM
//   node tools/devkit/sandbox.mjs down --name <n> | --all
//   node tools/devkit/sandbox.mjs list
//   node tools/devkit/sandbox.mjs info --name <n>      the whole record, with ownerToken (the service token)
//   node tools/devkit/sandbox.mjs link --name <n> [--reader]  one more link (--reader: an ordinary access link with no authoring roots; it still edits unless archer.toml says edit = false)
//   node tools/devkit/sandbox.mjs check --name <n>   compile every view and embedded diagram
//
// `up` prints one JSON line: {name, url, link, origin, stateDir, root, port, pid, page, projects:[…]}
// (with --tls also caPath: trust it, e.g. NODE_EXTRA_CA_CERTS, or ignore HTTPS errors in a browser).
// The record is kept in tools/devkit/.sandboxes/<name>.json (gitignored, mode 0600) for the harness;
// it holds the link's grant token and `ownerToken`, the sandbox service's own token, which alone reads
// /-/debug/log and /-/debug/events. `ARCHER_DEVKIT_REGISTRY` moves the registry (tests).
//
// Safety: names are validated in registryPath() for every command; `down` deletes only a record
// that names itself and carries its nonce, only a root that carries the matching marker, and
// signals only a process whose start time and command line match what `up` recorded. Corpus copies
// carry no `.git` and no symlinks, and every git call runs without inherited GIT_* variables.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
// The service's own spelling of a credential (32 hex today, 64 for older ones), not a second copy of it.
import { TOKEN_PATTERN } from "../../ts/src/service/token.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../..");
export const REGISTRY = resolve(process.env.ARCHER_DEVKIT_REGISTRY ?? join(HERE, ".sandboxes"));
const DEFAULT_CORPUS = join(HERE, "corpus");
const MARKER = ".archer-devkit-sandbox";
const ROOT_PREFIX = "archer-devkit-";
/**
 * Where sandbox roots are made: the OS temp dir, real. macOS's (/private/var/folders/…/T, 55 bytes) leaves too
 * little of the 103 bytes a Unix socket path holds there for `<root>/state/archer.sock`, and the service refused to
 * start; its /private/tmp is short and real. Linux's /tmp already is.
 */
const sandboxTmp = () =>
  process.platform === "darwin" && realpathSync(tmpdir()).length > 40 ? "/private/tmp" : realpathSync(tmpdir());
/** Ports never given to a sandbox: your own services' ports, from ARCHER_RESERVED_PORTS (e.g. "8080,8443"; default 40399, the dev server's default in ui/vite.config.ts). */
const RESERVED_PORTS = new Set(
  (process.env.ARCHER_RESERVED_PORTS ?? "40399")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0),
);
export const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const NONCE = /^[0-9a-f]{32}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(host = "127.0.0.1") {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => (RESERVED_PORTS.has(port) ? freePort(host).then(resolvePort, reject) : resolvePort(port)));
    });
  });
}

/** `env` without any GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CEILING_DIRECTORIES, …). */
export function withoutGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
}

/** Git confined to `cwd`: no inherited GIT_*, no discovery above its parent, no system/global config. */
function git(cwd, ...args) {
  const env = {
    ...withoutGitEnv(),
    GIT_CEILING_DIRECTORIES: dirname(cwd),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=archer-devkit",
      "-c",
      "user.email=devkit@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd, env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

/** The validated registry file of `name`; every command reaches the registry through this. */
export function registryPath(name) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`sandbox name must match ${NAME}`);
  const path = join(REGISTRY, `${name}.json`);
  if (dirname(path) !== REGISTRY) throw new Error(`sandbox name ${name} leaves the registry`);
  return path;
}

function writeRecord(record) {
  const path = registryPath(record.name);
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Copies one corpus project: no `.git` (at any depth), and a symlink or special file is refused. */
export function copyCorpusProject(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const st = lstatSync(from);
      if (st.isSymbolicLink())
        throw new Error(`corpus ${src} contains a symlink (${from}); corpus projects must be plain files`);
      if (!st.isFile() && !st.isDirectory()) throw new Error(`corpus ${src} contains a special file (${from})`);
      return from === src || basename(from) !== ".git";
    },
  });
}

/** A fresh repository at `dest` holding one commit of its files; its `.git` must resolve inside `root`. */
export function snapshotRepo(dest, root) {
  git(dest, "init", "-q", "-b", "main");
  const gitDir = realpathSync(git(dest, "rev-parse", "--absolute-git-dir").trim());
  const top = realpathSync(git(dest, "rev-parse", "--show-toplevel").trim());
  if (
    gitDir !== join(realpathSync(dest), ".git") ||
    top !== realpathSync(dest) ||
    !gitDir.startsWith(realpathSync(root) + sep)
  )
    throw new Error(`git metadata for ${dest} resolved to ${gitDir} (top ${top}), outside the sandbox; refusing`);
  git(dest, "add", "-A");
  git(dest, "commit", "-q", "-m", "devkit corpus snapshot");
  settleCorpusTimes(dest);
  // A stale fixture needs a real diagram baseline followed by changed covered code.
  // Overlay plain corpus files only after the baseline; never copy Git metadata.
  const changes = join(dest, ".devkit", "after-snapshot");
  if (existsSync(changes)) copyCorpusProject(changes, dest);
}

/**
 * Gives every file in the copy's Archer folder (`.archer/`) the snapshot commit's time as its modification time.
 * The project page lists files most recently edited first (file mtime, `ts/src/project/file-dates.ts`), so the
 * milliseconds between files as the copy wrote them, or a reset (`ui.resetProject`: `git checkout`) rewriting
 * the files a journey changed, gave each sandbox its own row order and moved rows above or below the fold (O72).
 * With one time, ties fall back to the title order on every sandbox and after every reset.
 */
export function settleCorpusTimes(dest) {
  const folder = join(dest, ".archer");
  if (!existsSync(folder)) return;
  const at = Number(git(dest, "log", "-1", "--format=%ct").trim());
  if (!Number.isInteger(at) || at <= 0) throw new Error(`no snapshot commit time in ${dest}`);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) utimesSync(path, at, at);
    }
  };
  walk(folder);
}

/** Emphasis is service state, so publish a corpus request through the product CLI after attach. */
function seedEmphasis(root, env) {
  const file = join(root, ".devkit", "emphasis.json");
  if (!existsSync(file)) return;
  const seeded = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      join(REPO, "ts/src/bin/archer.ts"),
      "emphasis",
      "set",
      "--file",
      file,
      "--json",
    ],
    { cwd: root, env, encoding: "utf8", timeout: 30_000 },
  );
  if (seeded.status !== 0) throw new Error(`corpus emphasis seed failed in ${root}: ${seeded.stderr || seeded.stdout}`);
}

/** Corpus projects: each immediate subdirectory holding an archer.toml (or the dir itself). */
export function corpusProjects(corpus) {
  const dir = resolve(corpus);
  if (existsSync(join(dir, "archer.toml"))) return [dir];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "archer.toml")))
    .map((e) => join(dir, e.name))
    .sort();
}

/**
 * The record of `name`, or null. A record from before `ownerToken` was kept gets it from the
 * sandbox's own state directory (not written back).
 */
export function readRecord(name) {
  const path = registryPath(name);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record?.name !== name)
    throw new Error(`registry entry ${name}.json names ${JSON.stringify(record?.name)}; refusing it`);
  if (record.ownerToken === undefined && typeof record.stateDir === "string") {
    const token = serviceToken(record.stateDir);
    if (token !== null) record.ownerToken = token;
  }
  return record;
}

/** The service token a sandbox service wrote to `<stateDir>/service.json` (0600, ours), or null. */
export function serviceToken(stateDir) {
  try {
    const path = join(stateDir, "service.json");
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) return null;
    const { token } = JSON.parse(readFileSync(path, "utf8"));
    return typeof token === "string" && TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** A process's start time and command line: from /proc on Linux, else `ps`; null when it is gone. */
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised command: the 22nd field (starttime, clock ticks since boot) is index 19.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return { start, cmdline };
  } catch {
    /* no /proc: ask ps */
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const line = r.status === 0 ? r.stdout.trim() : "";
  if (line === "") return null;
  return { start: line.slice(0, 24).trim(), cmdline: line.slice(24).trim() };
}

/**
 * Whether `record.pid` is still this sandbox's service. A record from `up` keeps the service's start
 * time and command line; an older record is matched by its command line (this worktree's
 * `archer.ts serve` on the recorded port) and, where readable, its ARCHER_STATE_DIR.
 */
export function ownsProcess(record) {
  const now = processIdentity(record?.pid);
  if (now === null) return false;
  if (record.process !== undefined) return now.start === record.process.start && now.cmdline === record.process.cmdline;
  const entry = join(REPO, "ts/src/bin/archer.ts");
  const words = now.cmdline.split(" ");
  if (
    !words.includes(entry) ||
    !words.includes("serve") ||
    !Number.isInteger(record.port) ||
    !now.cmdline.includes(`--port ${record.port} `)
  )
    return false;
  try {
    const env = readFileSync(`/proc/${record.pid}/environ`, "utf8").split("\0");
    return env.includes(`ARCHER_STATE_DIR=${record.stateDir}`);
  } catch {
    return true; /* no /proc: the command line is all there is */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitListening(origin, child, logPath, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`service exited (${child.exitCode}); log:\n${tail(logPath)}`);
    try {
      await fetch(`${origin}/`, { redirect: "manual", signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error(`service did not listen within ${timeoutMs} ms; log:\n${tail(logPath)}`);
}

const tail = (path) => {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-30).join("\n");
  } catch {
    return "(no log)";
  }
};

/** Build the page with browser telemetry on (ARCHER_DEBUG_UI=1) into the sandbox, not into ui/dist. */
export function buildDebugPage(root) {
  const outDir = join(root, "ui-debug");
  const r = spawnSync(
    process.execPath,
    [join(REPO, "node_modules/vite/bin/vite.js"), "build", "--outDir", outDir, "--emptyOutDir"],
    {
      cwd: join(REPO, "ui"),
      env: { ...process.env, ARCHER_DEBUG_UI: "1" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (r.status !== 0) throw new Error(`debug page build failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
  // Drop a local dev-helper injection (Impeccable live, from an uncommitted ui/index.html) from the
  // sandbox copy: the service's CSP blocks it and every page view would log a console error.
  const page = join(outDir, "index.html");
  const html = readFileSync(page, "utf8");
  const cleaned = html
    .replace(/<!-- impeccable-live-start -->[\s\S]*?<!-- impeccable-live-end -->/g, "")
    .replace(/<script[^>]*src="http:\/\/localhost:\d+\/live\.js[^"]*"[^>]*><\/script>/g, "");
  if (cleaned !== html) writeFileSync(page, cleaned);
  return page;
}

/** ui/src files newer than the built page: the page under test would not include them. */
function stalePageWarning(pagePath) {
  const built = statSync(pagePath).mtimeMs,
    newer = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).mtimeMs > built) newer.push(p.slice(REPO.length + 1));
    }
  };
  walk(join(REPO, "ui/src"));
  return newer.length
    ? `ui/dist/index.html is older than ${newer.length} ui/src file(s) (e.g. ${newer.slice(0, 3).join(", ")}); run \`npm --workspace ui run build\` or use --debug-ui`
    : undefined;
}

/** Seed saved layouts from <project>/.devkit/positions.json: {viewId: {nodeId: {x, y}}}. */
async function seedPositions(origin, slug, link, root) {
  const file = join(root, ".devkit", "positions.json");
  if (!existsSync(file)) return [];
  const all = JSON.parse(readFileSync(file, "utf8"));
  // Authoring accepts only the browser path: the access cookie plus the service's own Origin.
  const login = await fetch(link, { redirect: "manual" });
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";", 1)[0])
    .find((c) => /archer-\d+=/.test(c));
  if (cookie === undefined) return [{ ok: false, error: `no access cookie from the link (HTTP ${login.status})` }];
  const base = `${origin}/p/${slug}/api/authoring`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const seeded = [];
  for (const [viewId, positions] of Object.entries(all)) {
    try {
      const target = { kind: "view", viewId };
      const opened = await post("/open", { target });
      await post("/presentation", {
        op: "save",
        target,
        expectedTargetRevision: opened.targetRevision,
        sourceRevision: opened.sourceRevision,
        expectedRevision: null,
        positions,
      });
      seeded.push({ viewId, ok: true });
    } catch (error) {
      seeded.push({ viewId, ok: false, error: String(error.message ?? error) });
    }
  }
  return seeded;
}

/**
 * --tls: a throwaway CA and a 7-day leaf for 127.0.0.1/localhost it signed, under `<root>/tls`
 * (0700). The CA's key is deleted once the leaf is signed, so the CA can vouch for nothing else.
 */
export function sandboxTls(root, host = "127.0.0.1") {
  const dir = join(root, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caKey = join(dir, "ca.key"),
    caPath = join(dir, "ca.pem"),
    keyPath = join(dir, "key.pem"),
    csr = join(dir, "leaf.csr"),
    certPath = join(dir, "cert.pem"),
    ext = join(dir, "leaf.ext");
  const openssl = (...args) => {
    const r = spawnSync("openssl", args, {
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
  };
  try {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caPath,
      "-days",
      "7",
      "-subj",
      "/CN=Archer devkit sandbox CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    );
    openssl(
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csr,
      "-subj",
      "/CN=127.0.0.1",
    );
    writeFileSync(
      ext,
      `subjectAltName=IP:127.0.0.1,DNS:localhost${host === "127.0.0.1" ? "" : `,IP:${host}`}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    openssl(
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caPath,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      certPath,
      "-days",
      "7",
      "-extfile",
      ext,
    );
  } finally {
    for (const leftover of [caKey, csr, ext, join(dir, "ca.srl")]) rmSync(leftover, { force: true });
  }
  for (const path of [caPath, keyPath, certPath]) chmodSync(path, 0o600);
  return { caPath, certPath, keyPath };
}

export const COMMENT_SUBMISSION = ["immediate", "queued"];

export async function up({
  name,
  corpus = DEFAULT_CORPUS,
  page,
  zeroProjects = false,
  embedded = false,
  debugUi = false,
  profiling = false,
  tls = false,
  http2 = false,
  host = "127.0.0.1",
  commentSubmission,
} = {}) {
  if (commentSubmission !== undefined && !COMMENT_SUBMISSION.includes(commentSubmission))
    throw new Error(`--comment-submission must be one of ${COMMENT_SUBMISSION.join(", ")} (got ${commentSubmission})`);
  if (isIP(host) !== 4) throw new Error(`--host must be an IPv4 address this machine has (got ${host})`);
  if (http2 && !tls) throw new Error("--http2 needs --tls (HTTP/2 is offered on TLS only)");
  name ??= `sb-${randomBytes(3).toString("hex")}`;
  registryPath(name);
  const existing = readRecord(name);
  if (existing !== null && alive(existing.pid))
    throw new Error(`sandbox ${name} is already running (pid ${existing.pid}); use down first`);
  if (existing !== null) await down({ name }); // stale record: clean it
  const sources = zeroProjects ? [] : corpusProjects(corpus);
  if (!zeroProjects && sources.length === 0) throw new Error(`no projects (dirs with archer.toml) in ${corpus}`);
  if (sources.length > 16)
    throw new Error("at most 16 projects per sandbox (one link carries at most 16 authoring roots)");

  // Short root: the service's Unix socket path must stay under 104 bytes.
  const root = realpathSync(mkdtempSync(join(sandboxTmp(), `${ROOT_PREFIX}${name}-`)));
  const nonce = randomBytes(16).toString("hex");
  writeFileSync(
    join(root, MARKER),
    JSON.stringify({
      name,
      nonce,
      createdBy: "tools/devkit/sandbox.mjs",
      pidOfCreator: process.pid,
      at: new Date().toISOString(),
    }) + "\n",
  );
  mkdirSync(REGISTRY, { recursive: true });
  const record = { name, nonce, root, createdAt: new Date().toISOString(), pid: null };
  writeRecord(record);
  try {
    const stateDir = join(root, "state"),
      home = join(root, "home"),
      projectsDir = join(root, "projects");
    for (const d of [stateDir, home, join(home, ".config", "archer"), projectsDir])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    const configPath = join(root, "archer.toml");
    // The instance config (ARCHER_CONFIG); ts/src/config/resolve.ts reads [service] comment_submission from it.
    writeFileSync(
      configPath,
      `version = 1\n${commentSubmission === undefined ? "" : `[service]\ncomment_submission = "${commentSubmission}"\n`}`,
      { mode: 0o600 },
    );
    const roots = sources.map((src) => {
      const dest = join(projectsDir, basename(src));
      copyCorpusProject(src, dest);
      snapshotRepo(dest, root);
      return realpathSync(dest);
    });
    // Default: this checkout's built page (ui/dist, what the browser e2e suite serves); the
    // service's bundled copy in ts/assets can lag behind ui/src.
    const builtPage = join(REPO, embedded ? "ui/dist/mcp/index.html" : "ui/dist/index.html");
    if (embedded && debugUi && page === undefined)
      throw new Error("--embedded needs an existing MCP build; use --page for a custom MCP build");
    if (embedded && page === undefined && !existsSync(builtPage))
      throw new Error(`MCP page is not built: ${builtPage}`);
    const pagePath =
      page !== undefined
        ? resolve(page)
        : debugUi
          ? buildDebugPage(root)
          : existsSync(builtPage)
            ? builtPage
            : undefined;
    const pageWarning = pagePath === builtPage ? stalePageWarning(builtPage) : undefined;
    const port = await freePort(host);
    const material = tls ? sandboxTls(root, host) : null;
    if (material !== null) {
      // This process's own requests (waitListening, seeding) trust the sandbox CA from here on.
      setDefaultCACertificates([...getCACertificates("default"), readFileSync(material.caPath, "utf8")]);
      Object.assign(record, { caPath: material.caPath });
    }
    // --profiling: CPU profiles and heap snapshots (owner token, loopback) — off by default.
    const env = serviceEnv({ root, caPath: material?.caPath, host, profiling, http2 });
    const logPath = join(root, "service.log");
    const logFd = openSync(logPath, "a");
    const args = [
      "--import",
      "tsx",
      join(REPO, "ts/src/bin/archer.ts"),
      "serve",
      "--foreground",
      "--port",
      String(port),
      ...(material === null ? ["--force-http"] : ["--tls-cert", material.certPath, "--tls-key", material.keyPath]),
      ...(pagePath ? ["--page", pagePath] : []),
    ];
    const child = spawn(process.execPath, args, { cwd: REPO, env, detached: true, stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    child.unref();
    // serveArgs: what `restart` starts again (the same port, page and TLS material).
    Object.assign(record, {
      pid: child.pid,
      port,
      stateDir,
      serveArgs: args,
      host,
      commentSubmission: commentSubmission ?? "immediate",
    });
    writeRecord(record);
    const origin = `${material === null ? "http" : "https"}://${host}:${port}`;
    await waitListening(origin, child, logPath);
    // Listening means the service has exec'd: its identity is now its own, not the spawning node's.
    const identity = processIdentity(child.pid);
    if (identity !== null) record.process = identity;
    // Without it the service log is unreadable and every svc.* warning is lost (O5): say so, not later as silence.
    const ownerToken = serviceToken(stateDir);
    if (ownerToken === null)
      throw new Error(`the sandbox service wrote no readable token to ${join(stateDir, "service.json")}`);
    record.ownerToken = ownerToken;
    writeRecord(record);

    const prov = spawnSync(
      process.execPath,
      ["--import", "tsx", join(HERE, "lib/provision.mts"), JSON.stringify({ roots, label: `devkit ${name}` })],
      { cwd: REPO, env, encoding: "utf8" },
    );
    if (prov.status !== 0) throw new Error(`provisioning failed: ${prov.stderr || prov.stdout}`);
    const provisioned = JSON.parse(prov.stdout.trim().split("\n").pop());
    const token = provisioned.link.token ?? new URL(provisioned.link.url).searchParams.get("token");
    const projects = [];
    for (const p of provisioned.projects) {
      const slug = /\/(?:p|projects)\/([^/?#]+)/.exec(new URL(p.url).pathname)?.[1] ?? p.name;
      seedEmphasis(p.root, env);
      const positions = await seedPositions(origin, slug, provisioned.link.url, p.root);
      projects.push({
        name: p.name,
        slug,
        root: p.root,
        corpus: basename(p.root),
        url: `${origin}/projects/${slug}/`,
        ...(positions.length ? { positions } : {}),
      });
    }
    Object.assign(record, {
      url: `${origin}/`,
      origin,
      link: provisioned.link.url,
      grantId: provisioned.link.id,
      token,
      stateDir,
      home,
      configPath,
      logPath,
      port,
      pid: child.pid,
      page: pagePath ?? "(service default: the web build, ui/dist/index.html)",
      zeroProjects: Boolean(zeroProjects),
      embedded: Boolean(embedded),
      debugUi: Boolean(debugUi),
      profiling: Boolean(profiling),
      tls: Boolean(tls),
      http2: Boolean(http2),
      ...(pageWarning ? { pageWarning } : {}),
      projects,
      corpus: resolve(corpus),
    });
    writeRecord(record);
    return record;
  } catch (error) {
    await down({ name }).catch(() => {});
    throw error;
  }
}

/**
 * The service's own environment: sandboxEnv plus the bind address and the --profiling/--http2 switches, and no idle
 * stop. A sandbox's service is an isolated instance (its own state directory), which stops itself after 30 min
 * with no client (service.ts DEFAULT_IDLE_TIMEOUT_MS); a long flows-prove run leaves its queued sandbox unused for
 * longer than that (O123). `ARCHER_IDLE_TIMEOUT_MS=0` never stops it (O126), whatever the caller's shell says; `down`
 * stops it. Only the sandbox's service gets it: the product default is unchanged.
 */
export function serviceEnv({ root, caPath, host = "127.0.0.1", profiling = false, http2 = false }) {
  return {
    ...sandboxEnv({ root, caPath }),
    ARCHER_HOST: host,
    ARCHER_IDLE_TIMEOUT_MS: "0",
    ...(profiling ? { ARCHER_DEBUG_PROFILING: "1" } : {}),
    ...(http2 ? { ARCHER_HTTP2: "1" } : {}),
  };
}

/**
 * Stop the sandbox's service and start it again on the same port, state directory, links and projects (a person's
 * service restarting under an open page). The new process restores its attached projects from the state directory
 * (ARCHER_RESTORE_STATE=true for this start only), and this waits until it listens and every project answers its
 * diagram list through the editing link again (a restarted service opens saved projects after it answers). Only a
 * process `ownsProcess` recognises is stopped. Returns the updated record.
 */
export async function restart({ name, timeoutMs = 60_000 } = {}) {
  await stopService({ name });
  return startService({ name, timeoutMs });
}

/**
 * The first half of `restart`: stop the service and keep everything else (record, root, state, links). `kill: true`
 * sends SIGKILL at once (the service killed, no shutdown of its own) instead of SIGTERM.
 */
export async function stopService({ name, kill = false } = {}) {
  const record = name ? readRecord(name) : null;
  if (record === null || !record.link) throw new Error("stop needs --name of a sandbox that finished starting");
  if (!Array.isArray(record.serveArgs))
    throw new Error(
      `sandbox ${name} was started before restart was supported (no serveArgs in its record); down and up again`,
    );
  const stopped = await stopProcessGroup(record, kill ? "SIGKILL" : "SIGTERM");
  if (stopped === "refused")
    throw new Error(`pid ${record.pid} is alive but is not this sandbox's service; nothing stopped`);
  return { name, stopped };
}

/** The second half of `restart`: start a stopped sandbox's service again as `up` did, and wait until it is ready. */
export async function startService({ name, timeoutMs = 60_000 } = {}) {
  const record = name ? readRecord(name) : null;
  if (record === null || !record.link) throw new Error("start needs --name of a sandbox that finished starting");
  if (!Array.isArray(record.serveArgs))
    throw new Error(
      `sandbox ${name} was started before restart was supported (no serveArgs in its record); down and up again`,
    );
  if (record.pid && alive(record.pid) && ownsProcess(record))
    throw new Error(`sandbox ${name} is running (pid ${record.pid}); use restart`);
  const started = Date.now();
  const env = {
    ...serviceEnv({
      root: record.root,
      caPath: record.caPath,
      host: record.host ?? "127.0.0.1",
      profiling: record.profiling,
      http2: record.http2,
    }),
    ARCHER_RESTORE_STATE: "true",
  };
  const logFd = openSync(record.logPath, "a");
  const child = spawn(process.execPath, record.serveArgs, {
    cwd: REPO,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  Object.assign(record, {
    pid: child.pid,
    restarts: (record.restarts ?? 0) + 1,
    restartedAt: new Date().toISOString(),
  });
  delete record.process;
  writeRecord(record);
  if (record.caPath) setDefaultCACertificates([...getCACertificates("default"), readFileSync(record.caPath, "utf8")]);
  await waitListening(record.origin, child, record.logPath, timeoutMs);
  const identity = processIdentity(child.pid);
  if (identity !== null) record.process = identity;
  const ownerToken = serviceToken(record.stateDir);
  if (ownerToken === null)
    throw new Error(`the restarted service wrote no readable token to ${join(record.stateDir, "service.json")}`);
  record.ownerToken = ownerToken;
  writeRecord(record);
  // Ready = every project's diagram list answers through the editing link (project_loading until it has reopened).
  const until = started + timeoutMs;
  let cookie = null;
  for (const p of record.projects ?? []) {
    let last = "";
    for (;;) {
      try {
        cookie ??= await linkCookie(record.link);
        const res = await fetch(`${record.origin}/p/${p.slug}/api/diagrams`, {
          headers: { cookie },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) break;
        if (res.status === 401 || res.status === 403) cookie = null; // log in again next time
        last = `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
      } catch (error) {
        last = String(error.message ?? error);
      }
      if (Date.now() > until)
        throw new Error(
          `started sandbox ${name}: project ${p.slug} did not answer within ${timeoutMs} ms (${last}); log:\n${tail(record.logPath)}`,
        );
      await sleep(200);
    }
  }
  record.lastRestartMs = Date.now() - started;
  writeRecord(record);
  return record;
}

/** The environment every sandbox process gets: all Archer state, home and config inside the root (and with --tls, trust in its CA). */
export function sandboxEnv({ root, caPath }) {
  const home = join(root, "home"),
    stateDir = join(root, "state");
  const env = {
    ...withoutGitEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    ARCHER_CONFIG: join(root, "archer.toml"),
    ARCHER_STATE_DIR: stateDir,
    ARCHER_SOCKET: join(stateDir, "archer.sock"),
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
    ARCHER_RESTORE_STATE: "false",
    ARCHER_AUTO_START: "false",
    ARCHER_DEBUG: "1",
  };
  delete env.ARCHER_TLS_CERT;
  delete env.ARCHER_TLS_KEY;
  delete env.ARCHER_FORCE_HTTP;
  delete env.ARCHER_DEBUG_PROFILING;
  delete env.ARCHER_HTTP2;
  delete env.NODE_EXTRA_CA_CERTS;
  if (typeof caPath === "string") env.NODE_EXTRA_CA_CERTS = caPath;
  return env;
}

/** Everything `down` may delete: under the OS temp dir, our prefix, our uid, and carrying our marker+nonce. */
function ownedRoot(record) {
  const root = record?.root;
  if (typeof root !== "string") return null;
  const tmp = sandboxTmp();
  if (
    !root.startsWith(tmp + sep) ||
    dirname(root) !== tmp ||
    !basename(root).startsWith(`${ROOT_PREFIX}${record.name}-`)
  )
    return null;
  try {
    const st = lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) return null;
    const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8"));
    if (marker.nonce !== record.nonce || marker.name !== record.name) return null;
  } catch {
    return null;
  }
  return root;
}

/** Stops the recorded service, only after verifying that the PID is still that service. */
async function stopProcessGroup(record, first = "SIGTERM") {
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return "not-running";
  if (!ownsProcess(record)) return "refused";
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  signal(first);
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  if (alive(pid)) {
    signal("SIGKILL");
    await sleep(200);
    return "killed";
  }
  return "stopped";
}

export async function down({ name }) {
  const path = registryPath(name);
  const record = readRecord(name);
  if (record === null) throw new Error(`no sandbox named ${name}`);
  if (typeof record.nonce !== "string" || !NONCE.test(record.nonce))
    throw new Error(`registry entry ${name}.json carries no sandbox nonce; not a sandbox record, nothing deleted`);
  const stopped = await stopProcessGroup(record);
  if (stopped === "refused")
    return {
      name,
      stopped,
      removed: false,
      root: record.root,
      note: `pid ${record.pid} is alive but is not this sandbox's service (start time or command line differ); nothing signalled or deleted`,
    };
  const root = ownedRoot(record);
  let removed = false;
  if (root !== null) {
    rmSync(root, { recursive: true, force: true });
    removed = true;
  }
  rmSync(path, { force: true });
  return {
    name,
    stopped,
    removed,
    root: record.root,
    ...(root === null && record.root ? { note: "root not deleted: ownership marker did not verify" } : {}),
  };
}

export function list() {
  if (!existsSync(REGISTRY)) return [];
  return readdirSync(REGISTRY)
    .filter((f) => f.endsWith(".json") && NAME.test(f.slice(0, -5)))
    .flatMap((f) => {
      let r;
      try {
        r = readRecord(f.slice(0, -5));
      } catch {
        return [];
      }
      if (r === null) return [];
      return [
        {
          name: r.name,
          url: r.url,
          port: r.port,
          pid: r.pid,
          running: r.pid ? alive(r.pid) && ownsProcess(r) : false,
          root: r.root,
          projects: (r.projects ?? []).map((p) => p.slug),
        },
      ];
    });
}

/**
 * Issue another access link on a running sandbox. `reader: true` (default false) carries NO authoring
 * roots: an ordinary access link, as an agent hands a reader. Any admitted link may edit (decided 2026-10-28),
 * so it differs from the editing link only where archer.toml sets `edit = false`. Returns {id, url, token}.
 */
export function issueLink({ name, reader = false, label } = {}) {
  const r = name ? readRecord(name) : null;
  if (r === null || !r.pid) throw new Error("link needs --name of a running sandbox");
  const roots = reader ? [] : (r.projects ?? []).map((p) => p.root);
  const out = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(HERE, "lib/link.mts"),
      JSON.stringify({
        label: label ?? `devkit ${name} ${reader ? "reader" : "editor"}`,
        authoringProjectRoots: roots,
      }),
    ],
    { cwd: REPO, env: sandboxEnv(r), encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`issuing the link failed: ${out.stderr || out.stdout}`);
  return JSON.parse(out.stdout.trim().split("\n").pop());
}

/**
 * Put a project's saved layouts (the service's presentation store) back to the corpus state: every
 * view's saved positions become what <project>/.devkit/positions.json says (empty when it says nothing).
 * Goes through the browser authoring path (a fresh editing link), never the state directory.
 */
// One access cookie per link: a reset that logged in by the link each time looked to the service like the page
// asking for its document three times in 2 s (the journey's own login and two resets: svc.duplicate-request).
const resetCookies = new Map();
async function linkCookie(link) {
  const login = await fetch(link, { redirect: "manual" });
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";", 1)[0])
    .find((c) => /archer-\d+=/.test(c));
  if (cookie === undefined) throw new Error(`no access cookie from the link (HTTP ${login.status})`);
  resetCookies.set(link, cookie);
  return cookie;
}

export async function resetPresentations({ origin, slug, link, root }) {
  const kept = resetCookies.get(link);
  let cookie = kept ?? (await linkCookie(link));
  let listing = await fetch(`${origin}/p/${slug}/api/diagrams`, { headers: { cookie } });
  // A kept cookie the service no longer takes (a sandbox restarted on the same link): log in again, once.
  if (!listing.ok && kept !== undefined) {
    cookie = await linkCookie(link);
    listing = await fetch(`${origin}/p/${slug}/api/diagrams`, { headers: { cookie } });
  }
  const headers = { cookie, origin, "content-type": "application/json" };
  const post = async (path, body) => {
    const res = await fetch(`${origin}/p/${slug}/api/authoring${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const desired = existsSync(join(root, ".devkit", "positions.json"))
    ? JSON.parse(readFileSync(join(root, ".devkit", "positions.json"), "utf8"))
    : {};
  const views = (await listing.json()).views ?? [];
  const changed = [],
    skipped = [];
  for (const v of views) {
    if (v.id.includes("#")) {
      skipped.push(v.id);
      continue;
    } // diagrams embedded in notes have no whole-view layout
    try {
      const target = { kind: "view", viewId: v.id };
      const opened = await post("/open", { target });
      const read = await post("/presentation", { op: "read", target, expectedTargetRevision: opened.targetRevision });
      const current = read.presentation ?? null,
        want = desired[v.id] ?? {};
      if (JSON.stringify(current?.positions ?? {}) === JSON.stringify(want)) continue;
      await post("/presentation", {
        op: "save",
        target,
        expectedTargetRevision: opened.targetRevision,
        sourceRevision: opened.sourceRevision,
        expectedRevision: current?.revision ?? null,
        positions: want,
      });
      changed.push(v.id);
    } catch (error) {
      changed.push(`${v.id}: ${String(error.message ?? error).slice(0, 120)}`);
    }
  }
  return { changed, skipped: skipped.length };
}

async function cli(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      kill: { type: "boolean" },
      name: { type: "string" },
      corpus: { type: "string" },
      page: { type: "string" },
      "zero-projects": { type: "boolean" },
      embedded: { type: "boolean" },
      "debug-ui": { type: "boolean" },
      profiling: { type: "boolean" },
      tls: { type: "boolean" },
      http2: { type: "boolean" },
      host: { type: "string" },
      all: { type: "boolean" },
      reader: { type: "boolean" },
      label: { type: "string" },
      "comment-submission": { type: "string" },
    },
  });
  if (command === "up") {
    const r = await up({
      name: values.name,
      corpus: values.corpus,
      page: values.page,
      zeroProjects: values["zero-projects"],
      embedded: values.embedded,
      debugUi: values["debug-ui"],
      profiling: values.profiling,
      tls: values.tls,
      http2: values.http2,
      ...(values.host ? { host: values.host } : {}),
      ...(values["comment-submission"] ? { commentSubmission: values["comment-submission"] } : {}),
    });
    const { nonce: _n, token: _t, ownerToken: _o, ...shown } = r;
    process.stdout.write(JSON.stringify(shown) + "\n");
  } else if (command === "stop" || command === "start") {
    if (!values.name) throw new Error(`${command} needs --name <n>`);
    const r =
      command === "stop"
        ? await stopService({ name: values.name, kill: values.kill })
        : await startService({ name: values.name });
    process.stdout.write(
      JSON.stringify(
        command === "stop"
          ? r
          : {
              name: r.name,
              url: r.url,
              port: r.port,
              pid: r.pid,
              restarts: r.restarts,
              lastRestartMs: r.lastRestartMs,
            },
      ) + "\n",
    );
  } else if (command === "restart") {
    if (!values.name) throw new Error("restart needs --name <n>");
    const r = await restart({ name: values.name });
    process.stdout.write(
      JSON.stringify({
        name: r.name,
        url: r.url,
        port: r.port,
        pid: r.pid,
        restarts: r.restarts,
        lastRestartMs: r.lastRestartMs,
      }) + "\n",
    );
  } else if (command === "down") {
    const names = values.all ? list().map((s) => s.name) : values.name ? [values.name] : [];
    if (names.length === 0) throw new Error("down needs --name <n> or --all");
    for (const n of names) process.stdout.write(JSON.stringify(await down({ name: n })) + "\n");
  } else if (command === "list") {
    process.stdout.write(JSON.stringify(list()) + "\n");
  } else if (command === "check") {
    const r = values.name ? readRecord(values.name) : null;
    if (r === null) throw new Error("check needs --name of a running sandbox");
    const out = spawnSync(
      process.execPath,
      ["--import", "tsx", join(HERE, "lib/check.mts"), JSON.stringify(r.projects.map((p) => p.root))],
      { cwd: REPO, env: sandboxEnv(r), encoding: "utf8" },
    );
    if (out.status !== 0) throw new Error(out.stderr || out.stdout);
    process.stdout.write(out.stdout);
  } else if (command === "link") {
    // The secret is the point of this command: it is printed once, to the caller's terminal.
    process.stdout.write(
      JSON.stringify(issueLink({ name: values.name, reader: values.reader, label: values.label })) + "\n",
    );
  } else if (command === "info") {
    const r = values.name ? readRecord(values.name) : null;
    if (r === null) throw new Error("info needs --name of an existing sandbox");
    const { nonce: _n, ...shown } = r;
    process.stdout.write(JSON.stringify(shown, null, 2) + "\n");
  } else {
    process.stderr.write(
      "usage: sandbox.mjs up [--name n] [--corpus dir] [--page file] [--zero-projects] [--embedded] [--debug-ui] [--profiling] [--tls [--http2]] [--host ip] [--comment-submission immediate|queued] | restart --name n | stop --name n | start --name n | down --name n | down --all | list | info --name n | check --name n | link --name n [--reader] [--label l]\n",
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sandbox: ${error.message ?? error}\n`);
    process.exitCode = 1;
  });
}
