#!/usr/bin/env node
// R6 call-site review (docs/quality/rubrics/security.md §3 R6, §8): every site in ts/src that starts a
// process or a worker, makes an outbound request or connection, or builds a URL, each classified against
// the reviewed table below. A site the table does not cover, or covers twice, fails the run; so does a
// table entry that no longer matches any site (the code moved: review it again). That is the rubric's
// R6 level-3 "lint rule against new spawn or fetch sites".
//
//   node tools/devkit/security/callsites.mjs [--root <dir>] [--json] [--no-table]
//
// --root scans another tree (the tool's own tests plant sites there); --no-table lists sites with no
// classification. Exit 0 when every site is reviewed and no site is in a FINDING class, 1 otherwise.
//
// Classes (what the rubric asks of each site):
//   launch-recorded     Launch: runs only the argv the person recorded in their global archer.toml.
//   fixed-program       a constant program; arguments are constants or the owner's own configuration/CLI.
//   validated-argument  a request- or agent-supplied value becomes ONE argv element, after validation and
//                       an option terminator (`--end-of-options`, `--`); never the program or an option.
//   request-argv        FINDING: a request-supplied program, option or unvalidated argument.
//   internal-request    a request or connection to a fixed or self address (the service's socket, its page).
//   request-url         FINDING: fetches or connects to a URL or socket path taken from request input.
//   module-worker       a worker thread from a module-relative URL.
//   url-parse           parses or formats a URL; no request is made from it.
//   page-script         code inside a string served to the browser (its own same-origin request).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const FINDING_CLASSES = new Set(["request-argv", "request-url"]);
export const CLASSES = new Set([
  "launch-recorded",
  "fixed-program",
  "validated-argument",
  "request-argv",
  "internal-request",
  "request-url",
  "module-worker",
  "url-parse",
  "page-script",
]);

const PROCESS_NAMES = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"];
const REQUEST_MODULES = new Set(["node:http", "node:https", "node:http2", "http", "https", "http2"]);
const SOCKET_MODULES = new Set(["node:net", "net", "node:tls", "tls"]);
const PROCESS_MODULES = new Set(["node:child_process", "child_process"]);

/** Local names a file imports from `modules` for `wanted` exports (`import { request as httpRequest }`). */
function importedNames(text, modules, wanted) {
  const names = new Map();
  for (const match of text.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!modules.has(match[2])) continue;
    for (const part of match[1].split(",")) {
      const [name, alias] = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (name !== undefined && wanted.includes(name) && !/^type\s/.test(part.trim())) names.set(alias ?? name, name);
    }
  }
  // Namespace imports: `import * as cp from "node:child_process"`, `import http from "node:http"`.
  for (const match of text.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g))
    if (modules.has(match[2])) for (const name of wanted) names.set(`${match[1]}.${name}`, name);
  return names;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A use of an imported name: not a member, a private name, part of a longer name, or inside quotes (`once("spawn")`). */
const reference = (local) => new RegExp("(?<![\\w$.#\"'`])" + escapeRe(local) + "(?![\\w$\"'`])");

/** Every call site in one file's text: {line, kind, callee, text}. Comment lines are skipped. */
export function sitesIn(text) {
  const patterns = [];
  const add = (kind, callee, re) => patterns.push({ kind, callee, re });
  // An imported name counts wherever it is used, not only where it is called: `const send = httpsRequest`.
  for (const [local, name] of importedNames(text, PROCESS_MODULES, PROCESS_NAMES))
    add("process", name, reference(local));
  // Unimported spellings still count (a `require`, a re-export): a bare call of a process name.
  for (const name of PROCESS_NAMES) add("process", name, new RegExp(`(?<![\\w$.#])${name}\\s*\\(`));
  for (const [local, name] of importedNames(text, REQUEST_MODULES, ["request", "get", "connect"]))
    add("request", name, reference(local));
  add("request", "http.request", /\bhttps?2?\.(?:request|get|connect)\s*\(/);
  add("request", "fetch", /(?<![\w$.#])fetch\s*\(/);
  for (const [local, name] of importedNames(text, SOCKET_MODULES, ["connect", "createConnection"]))
    add("socket", name, reference(local));
  add("worker", "Worker", /\bnew\s+Worker\s*\(/);
  add("url", "URL", /\bnew\s+URL\s*\(/);
  const sites = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || /^import\s/.test(trimmed))
      continue;
    // Drop a trailing `// comment` so prose after code is not a call.
    const code = line.replace(/\s\/\/\s.*$/, "");
    const seen = new Set();
    for (const { kind, callee, re } of patterns) {
      const global = new RegExp(re.source, "g");
      for (const match of code.matchAll(global)) {
        const key = `${kind}:${match.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // The call itself, across the lines a formatter may wrap it onto: what a table entry is matched against.
        const call = [code, ...lines.slice(index + 1, index + 6)].join("\n").slice(0, 800);
        sites.push({ line: index + 1, column: match.index + 1, kind, callee, text: trimmed.slice(0, 240), call });
      }
    }
  }
  return sites;
}

function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) yield path;
  }
}

/** Every site under `root`, with its path relative to `base`. */
export function scan(root, base = root) {
  const out = [];
  for (const path of files(root))
    for (const site of sitesIn(readFileSync(path, "utf8"))) out.push({ file: relative(base, path), ...site });
  return out;
}

/**
 * The reviewed table: {file, kind, match, class, why}. `match` is a substring of the site's line (stable
 * under line moves); one entry may cover several sites on lines that share it. Reviewed at v0.8.0.
 */
export const REVIEWED = [
  // ---- processes
  {
    file: "ts/src/service/launcher.ts",
    kind: "process",
    match: "spawn(command, args, { cwd: folder.cwd",
    class: "launch-recorded",
    why: "argv is launchPlan(): the person's [agents] launcher from their global archer.toml only; shell: false; the message goes to env and stdin, never argv; cwd is the root or a launcher_cwd inside it, held open by heldFolder() and passed as /proc/self/fd/<fd> (P11 test: ts/test/security/launch-injection.test.ts; X-01: ts/test/service/launcher.test.ts)",
  },
  {
    file: "ts/src/accuracy/git.ts",
    kind: "process",
    match: 'spawn("git", ["--no-pager"',
    class: "validated-argument",
    why: "constant program; refs pass gitRef() (no options, ranges or reflog) after --end-of-options; paths pass safeRelativePath()/projectPath() after `--`, with GIT_LITERAL_PATHSPECS=1, no system/global config, no lazy fetch",
  },
  {
    file: "ts/src/comments/lock.ts",
    kind: "process",
    match: 'execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)]',
    class: "fixed-program",
    why: "/bin/ps (absolute, not PATH's) with a numeric pid read from a lock file, claim or registry entry in the private state; String(number) cannot be an option; env adds only the constants LC_ALL=C and TZ=UTC0 (psStart, reviewed 2026-11-11 for O282)",
  },
  {
    file: "ts/src/bin/agent-id.ts",
    kind: "process",
    match: 'execFileSync("ps", [...args]',
    class: "fixed-program",
    why: "ps with arguments built from the CLI's own process ids",
  },
  {
    file: "ts/src/service/tls-setup.ts",
    kind: "process",
    match: 'execFile("openssl", [...args]',
    class: "validated-argument",
    why: "openssl with constant subcommands; host names from setup_network_access (management socket, owner) pass validHost() and go into a config file, file paths are under the private state dir",
  },
  {
    file: "ts/src/application/network-access.ts",
    kind: "process",
    match: 'spawnSync("openssl", ["version"]',
    class: "fixed-program",
    why: "constant argv",
  },
  {
    file: "ts/src/service/client.ts",
    kind: "process",
    match: "spawn(command, args, {",
    class: "fixed-program",
    why: "defaultServeCommand() (this executable) or the caller's options.command (CLI/tests only); no request reaches it",
  },
  {
    file: "ts/src/service/restart.ts",
    kind: "process",
    match: 'execFile(executable, [...targetArgs, "--version"]',
    class: "fixed-program",
    why: "restart preflight of this executable; from the CLI/management restart",
  },
  {
    file: "ts/src/service/restart.ts",
    kind: "process",
    match: 'execFile(executable, [...targetArgs, "--help"]',
    class: "fixed-program",
    why: "restart preflight of this executable",
  },
  {
    file: "ts/src/service/restart.ts",
    kind: "process",
    match: "spawn(executable!, args, { detached: true",
    class: "fixed-program",
    why: "the replacement service: this executable with --port/--service/--page from the running service's own configuration",
  },
  {
    file: "ts/src/service/browser.ts",
    kind: "process",
    match: "spawn(program, [...args, url]",
    class: "fixed-program",
    why: "the OS opener (or the owner's configured command) with the service's own page URL, checked http(s) by new URL above; the URL is one argv element",
  },
  // ---- requests and connections
  {
    file: "ts/src/bin/present.ts",
    kind: "request",
    match: "const send = https ? httpsRequest : httpRequest",
    class: "internal-request",
    why: "CLI page check of the URL the local service returned (its own page), pinned to the resolved address, same-origin redirects only; no HTTP request input",
  },
  {
    file: "ts/src/service/service-client.ts",
    kind: "socket",
    match: "connect(",
    class: "internal-request",
    why: "the management Unix socket path from the client's own environment (paths.ts), not a request",
  },
  {
    file: "ts/src/mcp/relay.ts",
    kind: "socket",
    match: "connect(",
    class: "internal-request",
    why: "the relay dials the service's own socket (serviceDial from env)",
  },
  {
    file: "ts/src/service/service.ts",
    kind: "socket",
    match: "connect(",
    class: "internal-request",
    why: "the service probing its own socket path (stale-socket check)",
  },
  // ---- workers
  {
    file: "ts/src/service/compile-pool.ts",
    kind: "worker",
    match: "new Worker(",
    class: "module-worker",
    why: "compile-worker from a module-relative URL",
  },
  {
    file: "ts/src/service/thumbnails.ts",
    kind: "worker",
    match: "new Worker(",
    class: "module-worker",
    why: "thumbnail-worker from a module-relative URL",
  },
  // ---- URL construction (parsing only unless noted)
  {
    file: "ts/src/guidance/skill-folder.ts",
    kind: "url",
    match: "new URL(relative, from)",
    class: "url-parse",
    why: "module-relative file path",
  },
  { file: "ts/src/assets.ts", kind: "url", match: "new URL(", class: "url-parse", why: "module-relative asset paths" },
  {
    file: "ts/src/application/index.ts",
    kind: "url",
    match: "new URL(",
    class: "url-parse",
    why: "module path, and parsing the service's own status/page URL",
  },
  {
    file: "ts/src/service/thumbnails.ts",
    kind: "url",
    match: "new URL(candidate, import.meta.url)",
    class: "url-parse",
    why: "worker module path",
  },
  {
    file: "ts/src/service/compile-pool.ts",
    kind: "url",
    match: "new URL(candidate, import.meta.url)",
    class: "url-parse",
    why: "worker module path",
  },
  {
    file: "ts/src/service/browser.ts",
    kind: "url",
    match: "new URL(url)",
    class: "url-parse",
    why: "scheme check before the opener",
  },
  {
    file: "ts/src/bin/present.ts",
    kind: "url",
    match: "new URL(",
    class: "url-parse",
    why: "the page check's URL and same-origin redirect resolution",
  },
  {
    file: "ts/src/service/instances-cli.ts",
    kind: "url",
    match: "new URL(",
    class: "url-parse",
    why: "host/origin of instance records",
  },
  {
    file: "ts/src/service/cli.ts",
    kind: "url",
    match: "new URL(url)",
    class: "url-parse",
    why: "protocol/hostname of the service URL",
  },
  {
    file: "ts/src/service/restart.ts",
    kind: "url",
    match: "new URL(expectedUrl)",
    class: "url-parse",
    why: "hostname of the running service's own URL",
  },
  {
    file: "ts/src/service/debug-http.ts",
    kind: "url",
    match: 'new URL(rawUrl, "http://archer.invalid")',
    class: "url-parse",
    why: "request query parsing against a fixed dummy base",
  },
  {
    file: "ts/src/export/index.ts",
    kind: "url",
    match: 'new URL("../../../ui/src/export/painter.ts", import.meta.url)',
    class: "url-parse",
    why: "module path",
  },
  {
    file: "ts/src/service/client.ts",
    kind: "url",
    match: "new URL(",
    class: "url-parse",
    why: "module paths of the serve entry",
  },
  {
    file: "ts/src/config/resolve.ts",
    kind: "url",
    match: "new URL(value)",
    class: "url-parse",
    why: "validates a configured public origin",
  },
  {
    file: "ts/src/config/index.ts",
    kind: "url",
    match: "new URL(value)",
    class: "url-parse",
    why: "validates public_url",
  },
  {
    file: "ts/src/service/http.ts",
    kind: "url",
    match: "new URL(",
    class: "url-parse",
    why: "request path parsing against a fixed dummy base, the exchange redirect, and formatting the service's own project URLs",
  },
  {
    file: "ts/src/service/service.ts",
    kind: "url",
    match: "new URL(",
    class: "url-parse",
    why: "module paths and the service's own origin",
  },
  {
    file: "ts/src/bin/doctor.ts",
    kind: "url",
    match: "new URL(hello.homeUrl)",
    class: "url-parse",
    why: "host of the service's own URL for a message",
  },
  {
    file: "ts/src/service/authoring-http.ts",
    kind: "url",
    match: "new URL(req.url??'/', 'http://archer.invalid')",
    class: "url-parse",
    why: "request path parsing against a fixed dummy base",
  },
  // 0.10.0 (security, 2026-11-03, O154)
  {
    file: "ts/src/application/page-urls.ts",
    kind: "url",
    match: "new URL(pageUrl)",
    class: "url-parse",
    why: "the project page URL the service itself reported (attach/listProjects/present over its socket); keeps its origin, builds the path with browserRoutePath (encoded, no dot segments) and re-encodes the token; no request",
  },
  {
    file: "ts/src/service/pairing-page.ts",
    kind: "url",
    match: "new URL(document.referrer)",
    class: "page-script",
    why: "the pairing form's script reads its own same-origin referrer (Referrer-Policy same-origin); kept only if same origin under /projects/, credential query dropped; /-/pair re-checks it server-side",
  },
  {
    file: "ts/src/service/return-path.ts",
    kind: "url",
    match: "new URL(raw, BASE)",
    class: "url-parse",
    why: "/-/pair's request-supplied return, against a fixed dummy base: kept only if ASCII path spelling, /projects/ prefix, unchanged by the parser, in the route grammar, no credential key; the Location is that path or /projects/, never a host (pairing-return.test.ts)",
  },
];

/**
 * Code as the table compares it: no whitespace, one quote style. A formatter's line breaks, spacing and
 * quotes never make an entry stale; a change to the call itself (another program, argument or URL) does.
 */
export const normalizeCall = (code) => code.replace(/\s+/g, "").replace(/['`]/g, '"');

/** Each site matched to its table entries; unreviewed, ambiguous and stale entries listed. */
export function classify(sites, table = REVIEWED) {
  const used = new Set();
  const results = sites.map((site) => {
    const entries = table.filter(
      (entry) =>
        entry.file === site.file &&
        entry.kind === site.kind &&
        normalizeCall(site.call ?? site.text).includes(normalizeCall(entry.match)),
    );
    entries.forEach((entry) => used.add(entry));
    return { ...site, classes: entries.map((entry) => entry.class), why: entries.map((entry) => entry.why) };
  });
  const unreviewed = results.filter((site) => site.classes.length === 0);
  const ambiguous = results.filter((site) => new Set(site.classes).size > 1);
  const findings = results.filter((site) => site.classes.some((name) => FINDING_CLASSES.has(name)));
  const stale = table.filter((entry) => !used.has(entry));
  const badClass = table.filter((entry) => !CLASSES.has(entry.class));
  const byClass = {};
  for (const site of results) for (const name of new Set(site.classes)) byClass[name] = (byClass[name] ?? 0) + 1;
  const byKind = {};
  for (const site of results) byKind[site.kind] = (byKind[site.kind] ?? 0) + 1;
  return {
    total: results.length,
    byKind,
    byClass,
    sites: results,
    unreviewed,
    ambiguous,
    findings,
    stale,
    badClass,
    ok:
      unreviewed.length === 0 &&
      ambiguous.length === 0 &&
      findings.length === 0 &&
      stale.length === 0 &&
      badClass.length === 0,
  };
}

function main() {
  const { values } = parseArgs({
    options: { root: { type: "string" }, json: { type: "boolean" }, "no-table": { type: "boolean" } },
  });
  const root = resolve(values.root ?? join(REPO, "ts/src"));
  // Paths are relative to the repository for the real tree, so the table's `file` names match.
  const base = values.root === undefined ? REPO : root;
  const report = classify(scan(root, base), values["no-table"] ? [] : REVIEWED);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `R6 call sites in ${relative(process.cwd(), root) || "."}: ${report.total} (${Object.entries(report.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")})`,
    );
    console.log(
      `by class: ${
        Object.entries(report.byClass)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ") || "none"
      }`,
    );
    const show = (label, list) => {
      if (list.length > 0) {
        console.log(`${label}: ${list.length}`);
        for (const s of list) console.log(`  ${s.file}:${s.line}:${s.column} [${s.kind}/${s.callee}] ${s.text}`);
      }
    };
    show("UNREVIEWED", report.unreviewed);
    show("AMBIGUOUS", report.ambiguous);
    show("FINDING", report.findings);
    if (report.stale.length > 0) {
      console.log(`STALE table entries: ${report.stale.length}`);
      for (const e of report.stale) console.log(`  ${e.file} [${e.kind}] ${e.match}`);
    }
    if (report.badClass.length > 0) console.log(`unknown classes: ${report.badClass.map((e) => e.class).join(", ")}`);
    console.log(report.ok ? "OK: every site reviewed, none in a finding class" : "FAIL");
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
