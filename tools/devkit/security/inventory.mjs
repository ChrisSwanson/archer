#!/usr/bin/env node
// The route inventory and authority matrix (security rubric G2, G3, §5; probes P1 and P2).
//
//   node tools/devkit/security/inventory.mjs [--name <sandbox>] [--out <dir>] [--no-edit-off]
//
// Without --name: the static inventory only (rows, code facts, unclassified and stale routes, metrics).
// With --name: also probes every HTTP row of a running sandbox (`sandbox.mjs up --name <n> --tls`)
// with each §1 credential column — none, grant cookie, grant Bearer, service token (path, cookie,
// Bearer), revoked grant (cookie, Bearer) — with `edit` on and then off (archer.toml `edit = false`
// in each sandbox project, restored afterwards); sends the five G2 cross-site variants to every
// state-changing row on each cookie, hashing the sandbox's projects and state directory before and
// after; and sends one byte over each body cap, declared and chunked. Writes inventory.json and
// inventory.md to --out (default: a new directory under the OS temp dir) and prints the §5 metrics.
// Secrets never reach the output: every value written goes through `redact`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  classify,
  COLUMNS,
  crossSiteVariants,
  expected,
  metrics,
  staticInventory,
  stateHash,
  verdict,
} from "./inventory-model.mjs";
import { cookiePair, openStream, redact, send } from "./lib/client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

/** The code's own tables, imported under tsx (lib/registries.mts). */
export function loadRegistries() {
  const out = spawnSync(process.execPath, ["--import", "tsx", join(HERE, "lib/registries.mts")], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`registries failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

/** Fills a row's path template from the discovered parameters. */
function fill(path, params) {
  return path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key] ?? key)).replace(/%23/g, "%23");
}

/** One request as a credential column sends it. `target` = {origin, ca, ownerToken, credentials}. */
export async function request(target, row, column, path, extraHeaders = {}, options = {}) {
  const credential = target.credentials[column];
  if (credential === undefined) return null;
  const prefix = column === "owner-path" ? `/${target.ownerToken}` : "";
  const headers = {
    ...(row.method === "GET" ? {} : { origin: target.origin, "content-type": "application/json" }),
    ...credential.headers,
    ...extraHeaders,
  };
  for (const [key, value] of Object.entries(headers)) if (value === undefined) delete headers[key];
  const url = `${target.origin}${prefix}${path}`;
  if (row.stream) {
    const stream = await openStream(url, { headers, ca: target.ca });
    stream.close();
    return {
      status: stream.status,
      headers: stream.headers,
      body: stream.status === 200 ? "<stream>" : "",
      error: stream.error,
    };
  }
  return send(url, {
    method: row.method,
    headers,
    ca: target.ca,
    ...(row.method === "GET" ? {} : { body: options.body ?? row.body ?? "" }),
    ...options,
  });
}

/** Probes every HTTP row × column at one `edit` setting. */
export async function probeMatrix(target, rows, { edit, profiling = false, columns = COLUMNS } = {}) {
  const cells = {};
  for (const row of rows) {
    const path = fill(row.path, target.params);
    cells[row.id] = {};
    for (const column of row.columns ?? columns) {
      if (!columns.includes(column)) continue;
      if (column === "owner-path" && (row.surface === "debug" || row.path === "/-/pair")) continue;
      const response = await request(target, row, column, path);
      if (response === null) continue;
      const seen = classify(response);
      const expectation = expected(row, column, { edit, profiling });
      cells[row.id][column] = {
        status: response.status,
        code: seen.code,
        observed: seen.class,
        expected: expectation,
        verdict: verdict(expectation, seen.class),
      };
    }
  }
  return cells;
}

/** The G2 variants on each state-changing row, with each cookie column. */
export async function probeCrossSite(target, rows, hashDirs) {
  const results = {};
  for (const row of rows.filter((r) => r.state && r.method !== "GET")) {
    results[row.id] = [];
    for (const column of ["grant-cookie", "owner-cookie"]) {
      if (target.credentials[column] === undefined) continue;
      for (const variant of crossSiteVariants(target.origin)) {
        const before = hashDirs.length ? stateHash(hashDirs) : null;
        const response = await request(target, row, column, fill(row.path, target.params), {
          origin: undefined,
          "content-type": undefined,
          ...variant.headers,
        });
        const after = hashDirs.length ? stateHash(hashDirs) : null;
        const seen = classify(response);
        results[row.id].push({
          column,
          variant: variant.name,
          status: response.status,
          class: seen.class,
          code: seen.code,
          stateChanged: before !== after,
        });
      }
    }
  }
  return results;
}

/** The column a row's body-cap probe is sent with: one the row admits. */
function capColumn(row) {
  if (row.access === "public") return "none";
  if (row.access === "owner-local" || row.access === "debug-owner") return "owner-cookie";
  return "grant-cookie";
}

/** One byte over each numeric cap, declared (Content-Length) and chunked: each must be a 413 before parsing. */
export async function probeBodyCaps(target, rows, caps) {
  const results = {};
  for (const row of rows) {
    const limit = caps[row.cap];
    if (typeof limit !== "number") continue;
    const column = capColumn(row);
    const body = `{"x":"${"a".repeat(limit - 6)}"}`; // limit + 1 bytes
    const path = fill(row.path, target.params);
    const declared = await request(target, row, column, path, {}, { body });
    const chunked = await request(
      target,
      row,
      column,
      path,
      { "transfer-encoding": "chunked" },
      { body, chunked: true },
    );
    results[row.id] = [
      {
        form: "declared",
        column,
        limit,
        sent: Buffer.byteLength(body),
        status: declared.status,
        refused: declared.status === 413,
      },
      {
        form: "chunked",
        column,
        limit,
        sent: Buffer.byteLength(body),
        status: chunked.status,
        refused: chunked.status === 413,
      },
    ];
  }
  return results;
}

/** The credentials of each column, minted on the sandbox (the revoked pair is revoked here). */
export async function credentialsFor(record) {
  const { issueLink, sandboxEnv } = await import("../sandbox.mjs");
  const exchange = async (url) => {
    const answer = await send(url, { ca: record.ca });
    const pair = cookiePair(answer);
    if (answer.status !== 303 || pair === null) throw new Error(`the exchange of a link answered ${answer.status}`);
    return pair;
  };
  const grantToken = new URL(record.link).searchParams.get("token");
  const grantCookie = await exchange(record.link);
  const ownerCookie = await exchange(`${record.origin}/projects/?token=${record.ownerToken}`);
  const reader = issueLink({ name: record.name, reader: true, label: "security inventory revoked" });
  const revokedCookie = await exchange(reader.url);
  const revoked = spawnSync(
    process.execPath,
    ["--import", "tsx", join(HERE, "lib/revoke.mts"), JSON.stringify({ grantId: reader.id })],
    { cwd: REPO, env: sandboxEnv(record), encoding: "utf8" },
  );
  if (revoked.status !== 0) throw new Error(`revoking failed: ${revoked.stderr}`);
  const secrets = new Map([
    [record.ownerToken, "service-token"],
    [grantToken, "grant"],
    [reader.token, "revoked-grant"],
    [grantCookie.split("=")[1], "grant"],
    [ownerCookie.split("=")[1], "service-token"],
  ]);
  return {
    secrets,
    cookieName: grantCookie.split("=")[0],
    credentials: {
      none: { headers: {} },
      "grant-cookie": { headers: { cookie: grantCookie } },
      "grant-bearer": { headers: { authorization: `Bearer ${grantToken}` } },
      // Retired in 0.15.0: the service token in the path (`request` prefixes it) is no credential, a regression probe.
      "owner-path": { headers: {} },
      "owner-cookie": { headers: { cookie: ownerCookie } },
      "owner-bearer": { headers: { authorization: `Bearer ${record.ownerToken}` } },
      "revoked-cookie": { headers: { cookie: revokedCookie } },
      "revoked-bearer": { headers: { authorization: `Bearer ${reader.token}` } },
    },
  };
}

/** View, note, document and page-asset names to fill the templates, read as the owner's browser. */
async function discover(record) {
  const slug = record.projects[0].slug;
  const base = `${record.origin}/p/${slug}/api`;
  // The service token's `?token=` exchanged once for the owner's session cookie.
  const cookie =
    (await send(`${record.origin}/projects/?token=${record.ownerToken}`, { ca: record.ca })).headers[
      "set-cookie"
    ]?.[0]?.split(";")[0] ?? "";
  const get = async (path) => {
    const answer = await send(`${base}/${path}`, { ca: record.ca, headers: { cookie } });
    try {
      return JSON.parse(answer.body);
    } catch {
      return null;
    }
  };
  const views = (await get("diagrams"))?.views ?? [];
  const notes = (await get("notes/all"))?.notes ?? [];
  const documents = await get("documents");
  const documentPath = JSON.stringify(documents ?? {}).match(/"path":"([^"]+)"/)?.[1];
  const page = await send(`${record.origin}/projects/${slug}/`, {
    ca: record.ca,
    headers: { cookie },
  });
  const asset = page.body.match(/page-assets\/([A-Za-z0-9._-]+\.js)/)?.[1];
  return {
    slug,
    view: (views.find((v) => v.kind === "flowchart") ?? views[0])?.id,
    note: notes[0]?.path,
    document: documentPath,
    asset,
    token: "<token>",
  };
}

/** Sets or clears `edit = false` in each project's archer.toml; returns a restore function. */
function editOff(roots) {
  const saved = roots.map((root) => [join(root, "archer.toml"), readFileSync(join(root, "archer.toml"), "utf8")]);
  for (const [file, text] of saved) writeFileSync(file, text.replace(/^version = 1$/m, "version = 1\nedit = false"));
  return () => {
    for (const [file, text] of saved) writeFileSync(file, text);
  };
}

function markdown(report) {
  const lines = [
    `# Security inventory — ${report.meta.commit}`,
    "",
    `Generated ${report.meta.at}${report.meta.sandbox ? ` against sandbox \`${report.meta.sandbox}\` (${report.meta.transport})` : " (static only)"}.`,
    "",
    "## §5 metrics",
    "",
    "```json",
    JSON.stringify(report.metrics, null, 2),
    "```",
    "",
  ];
  if (report.unclassified.length || report.stale.length) {
    lines.push("## Unclassified and stale", "", "| surface | file:line | literal | why |", "|---|---|---|---|");
    for (const u of report.unclassified)
      lines.push(`| ${u.surface} | ${u.file}:${u.line ?? ""} | \`${u.literal}\` | ${u.why} |`);
    for (const s of report.stale) lines.push(`| stale | ${s.id} | \`${s.anchor}\` | ${s.why} |`);
    lines.push("");
  }
  lines.push(
    "## HTTP rows",
    "",
    "| id | method | path | access | state | origin check (handler) | body cap | edit on | edit off | cross-site | cap probe |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  const summary = (cells) => {
    if (cells === undefined) return "—";
    const bad = Object.entries(cells).filter(([, c]) => c.verdict !== "pass" && c.verdict !== "observed");
    const observed = Object.entries(cells)
      .filter(([, c]) => c.verdict === "observed")
      .map(([col, c]) => `${col}:${c.observed === "admitted" ? "A" : "R"}${c.status}`);
    return bad.length === 0
      ? `✓ ${Object.keys(cells).length}${observed.length ? ` (${observed.join(" ")})` : ""}`
      : bad.map(([col, c]) => `**${c.verdict}** ${col} ${c.status}${c.code ? ` ${c.code}` : ""}`).join("; ");
  };
  for (const row of report.rows) {
    const cross =
      row.crossSite === undefined
        ? "—"
        : row.crossSite.every((v) => v.class === "refused" && !v.stateChanged)
          ? `✓ ${row.crossSite.length}`
          : row.crossSite
              .filter((v) => v.class !== "refused" || v.stateChanged)
              .map((v) => `**${v.column} ${v.variant}: ${v.status}${v.stateChanged ? " state changed" : ""}**`)
              .join("; ");
    const cap =
      row.bodyCap === undefined
        ? "—"
        : row.bodyCap.map((p) => `${p.form} ${p.status}${p.refused ? "" : " **not refused**"}`).join(", ");
    lines.push(
      `| ${row.id} | ${row.method} | \`${row.path}\` | ${row.access} | ${row.state ? "yes" : ""} | ${row.originCheck} | ${row.cap ?? ""}${row.cap && row.cap !== "drain" && !row.capInCode ? " **missing**" : ""} | ${summary(row.cells?.edit_on)} | ${summary(row.cells?.edit_off)} | ${cross} | ${cap} |`,
    );
  }
  lines.push("", "## Management rows", "", "| id | surface | access | state | note |", "|---|---|---|---|---|");
  for (const row of report.management)
    lines.push(
      `| ${row.id} | ${row.surface} | ${row.access} | ${row.state ? "yes" : ""} | ${[row.grants ? "grants" : "", row.capability ? "grants a capability" : "", row.secretBearing ? "secret-bearing answer" : "", row.note ?? ""].filter(Boolean).join("; ")} |`,
    );
  return `${lines.join("\n")}\n`;
}

export async function run({ name, out, editOffRun = true }) {
  const registries = loadRegistries();
  const inventory = staticInventory(REPO, registries);
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  const meta = { at: new Date().toISOString(), commit, rubric: "docs/quality/rubrics/security.md v1" };
  let secrets = new Map();
  if (name !== undefined) {
    const { sandboxRecord } = await import("./lib/client.mjs");
    const record = await sandboxRecord(name);
    if (!record.pid) throw new Error(`sandbox ${name} is not running`);
    const minted = await credentialsFor(record);
    secrets = minted.secrets;
    const target = {
      origin: record.origin,
      ca: record.ca,
      ownerToken: record.ownerToken,
      credentials: minted.credentials,
      params: await discover(record),
    };
    Object.assign(meta, {
      sandbox: name,
      transport: record.tls ? "https (--tls)" : "http",
      profiling: record.profiling === true,
      debug: "ARCHER_DEBUG=1 (sandbox default)",
      writeRules: "default (allow): the write-rule deny dimension is not probed",
      params: target.params,
    });
    const roots = record.projects.map((p) => p.root);
    const on = await probeMatrix(target, inventory.rows, { edit: true, profiling: record.profiling === true });
    let off = {};
    if (editOffRun) {
      const restore = editOff(roots);
      try {
        off = await probeMatrix(target, inventory.rows, { edit: false, profiling: record.profiling === true });
      } finally {
        restore();
      }
    }
    const cross = await probeCrossSite(target, inventory.rows, [...roots, record.stateDir]);
    const caps = await probeBodyCaps(target, inventory.rows, registries.caps);
    for (const row of inventory.rows) {
      row.cells = { edit_on: on[row.id], ...(editOffRun ? { edit_off: off[row.id] } : {}) };
      if (cross[row.id]) row.crossSite = cross[row.id];
      if (caps[row.id]) row.bodyCap = caps[row.id];
    }
  }
  const report = { meta, metrics: metrics(inventory), ...inventory };
  const dir = out ?? mkdtempSync(join(tmpdir(), "archer-security-inventory-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), `${redact(JSON.stringify(report, null, 2), secrets)}\n`);
  writeFileSync(join(dir, "inventory.md"), redact(markdown(report), secrets));
  return { dir, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { name: { type: "string" }, out: { type: "string" }, "no-edit-off": { type: "boolean" } },
  });
  run({ name: values.name, out: values.out, editOffRun: values["no-edit-off"] !== true })
    .then(({ dir, report }) => {
      process.stdout.write(`${JSON.stringify({ out: dir, metrics: report.metrics })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`inventory: ${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
