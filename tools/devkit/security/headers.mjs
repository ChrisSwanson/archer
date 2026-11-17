#!/usr/bin/env node
// Response headers and credential exchanges (security rubric G4, G5, R2; probes P3 and P4).
//
//   node tools/devkit/security/headers.mjs --name <sandbox> [--out <dir>]
//
// Against a running sandbox (`sandbox.mjs up --name <n> --tls`): one response of each class (page,
// refusal and pairing pages, not-found and home pages, page asset, API JSON and errors, the event
// stream, a thumbnail, authoring and debug answers, a bare 404) and each exchange (grant `?token=`,
// owner path, pairing code) with its refusals; every predicate of G4, G5 and R2 per class. Writes
// headers.json and headers.md to --out (default: a new directory under the OS temp dir) and prints
// the summary. The same checks run in CI as ts/test/security/headers.test.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collect, evaluate, parseCsp, summarize } from "./headers-model.mjs";
import { redact, sandboxRecord, send } from "./lib/client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

export async function run({ name, out }) {
  const record = await sandboxRecord(name);
  if (!record.pid) throw new Error(`sandbox ${name} is not running`);
  const { sandboxEnv } = await import("../sandbox.mjs");
  const slug = record.projects[0].slug;
  // The owner's browser: the service token's `?token=` exchanged once for the session cookie.
  const cookie = (await send(`${record.origin}/projects/?token=${record.ownerToken}`, { ca: record.ca })).headers[
    "set-cookie"
  ]?.[0]?.split(";")[0];
  const views =
    JSON.parse((await send(`${record.origin}/p/${slug}/api/diagrams`, { ca: record.ca, headers: { cookie } })).body)
      .views ?? [];
  const view = views.find((v) => v.modelRevision) ?? views[0];
  const page = await send(`${record.origin}/projects/${slug}/`, { ca: record.ca, headers: { cookie } });
  const asset = page.body.match(/page-assets\/([A-Za-z0-9._-]+\.js)/)?.[1];
  const issued = spawnSync(process.execPath, ["--import", "tsx", join(HERE, "lib/pairing.mts")], {
    cwd: REPO,
    env: sandboxEnv(record),
    encoding: "utf8",
  });
  if (issued.status !== 0) throw new Error(`issuing a pairing code failed: ${issued.stderr}`);
  const pairingCode = JSON.parse(issued.stdout.trim().split("\n").pop()).code;
  const grantToken = new URL(record.link).searchParams.get("token");
  const snapshot = await collect({
    origin: record.origin,
    ca: record.ca,
    grantToken,
    ownerToken: record.ownerToken,
    pairingCode,
    slug,
    view: view?.id,
    revision: view?.modelRevision,
    asset,
  });
  const results = evaluate(snapshot);
  const summary = summarize(results);
  const secrets = new Map([
    [record.ownerToken, "service-token"],
    [grantToken, "grant"],
    [pairingCode, "pairing-code"],
  ]);
  const csp = parseCsp(snapshot.classes["page (clean address, cookie)"]?.headers["content-security-policy"]);
  const unsafeScriptSources = (csp["script-src"] ?? csp["default-src"] ?? []).filter((s) =>
    s.startsWith("'unsafe-"),
  ).length;
  const report = {
    meta: {
      at: new Date().toISOString(),
      sandbox: name,
      transport: record.tls ? "https (--tls)" : "http",
      commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim(),
    },
    metrics: { cspUnsafeScriptSources: unsafeScriptSources },
    summary,
    snapshot,
    results,
  };
  const dir = out ?? mkdtempSync(join(tmpdir(), "archer-security-headers-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "headers.json"), `${redact(JSON.stringify(report, null, 2), secrets)}\n`);
  const lines = [
    `# Security headers — ${report.meta.commit}`,
    "",
    `Sandbox \`${name}\` (${report.meta.transport}), ${report.meta.at}. ${summary.passing}/${summary.predicates} predicates pass; CSP unsafe script sources: ${unsafeScriptSources}.`,
    "",
  ];
  for (const [row, items] of Object.entries(summary.failingByRow)) {
    lines.push(`## ${row} failing`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push(
    "## Page CSP",
    "",
    "```",
    snapshot.classes["page (clean address, cookie)"]?.headers["content-security-policy"] ?? "(none)",
    "```",
    "",
  );
  writeFileSync(join(dir, "headers.md"), redact(`${lines.join("\n")}\n`, secrets));
  return { dir, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { name: { type: "string" }, out: { type: "string" } } });
  if (!values.name) {
    process.stderr.write("usage: headers.mjs --name <sandbox> [--out dir]\n");
    process.exitCode = 2;
  } else
    run({ name: values.name, out: values.out })
      .then(({ dir, report }) =>
        process.stdout.write(
          `${JSON.stringify({ out: dir, metrics: report.metrics, passing: report.summary.passing, predicates: report.summary.predicates })}\n`,
        ),
      )
      .catch((error) => {
        process.stderr.write(`headers: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
}
