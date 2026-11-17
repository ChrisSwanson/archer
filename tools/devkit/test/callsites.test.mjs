// node --test tools/devkit/test/callsites.test.mjs
// The R6 call-site review tool (tools/devkit/security/callsites.mjs), shown on a known-passing tree
// (ts/src at the reviewed commit) and on seeded failures planted in a scratch tree: a request-supplied
// spawn, an aliased request, a fetch of a request URL, and a table entry whose site has gone.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { classify, REVIEWED, scan, sitesIn } from "../security/callsites.mjs";

const TOOL = fileURLToPath(new URL("../security/callsites.mjs", import.meta.url));
const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "devkit-callsites-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("known passing: every site in ts/src is reviewed, none in a finding class, no stale entry", () => {
  const report = classify(scan(join(REPO, "ts/src"), REPO));
  assert.deepEqual(
    report.unreviewed.map((s) => `${s.file}:${s.line}`),
    [],
  );
  assert.deepEqual(
    report.stale.map((e) => `${e.file} ${e.match}`),
    [],
  );
  assert.deepEqual(
    report.findings.map((s) => `${s.file}:${s.line}`),
    [],
  );
  assert.equal(report.ok, true);
  // Launch is the one launch-recorded site; the process count is the review's denominator.
  assert.equal(report.byClass["launch-recorded"], 1);
  assert.ok(report.byKind.process >= 10, JSON.stringify(report.byKind));
  const cli = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("the scanner sees aliases and ignores regex .exec, private #spawn, comments and quoted event names", () => {
  const text = [
    'import { spawn as run } from "node:child_process";',
    'import { request as httpsRequest } from "node:https";',
    "const m = /x/.exec(s);",
    "this.#spawn(url);",
    "// spawn(evil)",
    'child.once("spawn", () => {});',
    "const send = httpsRequest;",
    "run(cmd, args);",
    "await fetch(target);",
    "const u = new URL(input);",
  ].join("\n");
  const found = sitesIn(text).map((s) => `${s.line}:${s.kind}:${s.callee}`);
  assert.deepEqual(found.sort(), ["10:url:URL", "7:request:request", "8:process:spawn", "9:request:fetch"]);
});

test("seeded failures: request-supplied argv and a fetched request URL are unreviewed and fail the run", () => {
  const root = join(scratch, "planted");
  mkdirSync(join(root, "service"), { recursive: true });
  writeFileSync(
    join(root, "service", "planted.ts"),
    [
      'import { spawn } from "node:child_process";',
      'import { get as fetchUrl } from "node:http";',
      "export function handle(body: { cmd: string; args: string[]; url: string }) {",
      "  spawn(body.cmd, body.args, { shell: true });",
      "  fetchUrl(body.url);",
      "  return fetch(body.url);",
      "}",
    ].join("\n"),
  );
  const report = classify(scan(root, root));
  assert.equal(report.ok, false);
  assert.deepEqual(report.unreviewed.map((s) => `${s.line}:${s.kind}`).sort(), ["4:process", "5:request", "6:request"]);
  // Reviewing them into a finding class still fails: a finding is not a pass.
  const table = [
    { file: "service/planted.ts", kind: "process", match: "spawn(body.cmd", class: "request-argv", why: "seeded" },
    { file: "service/planted.ts", kind: "request", match: "body.url", class: "request-url", why: "seeded" },
  ];
  const reviewed = classify(scan(root, root), table);
  assert.equal(reviewed.unreviewed.length, 0);
  assert.equal(reviewed.findings.length, 3);
  assert.equal(reviewed.ok, false);
  const cli = spawnSync(process.execPath, [TOOL, "--root", root], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /UNREVIEWED: 3/);
});

test("seeded failure: a table entry whose site is gone is stale and fails the run", () => {
  const root = join(scratch, "empty");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
  const report = classify(scan(root, root), [REVIEWED[0]]);
  assert.equal(report.stale.length, 1);
  assert.equal(report.ok, false);
});

test("an entry matches its call however a formatter lays it out, and not another call", () => {
  const entry = {
    file: "ts/src/x.ts",
    kind: "process",
    match: "execFile(executable, [...targetArgs, '--help']",
    class: "fixed-program",
    why: "test",
  };
  const wrapped = {
    file: "ts/src/x.ts",
    kind: "process",
    line: 1,
    column: 1,
    callee: "execFile",
    text: "execFile(",
    call: 'execFile(\n  executable,\n  [...targetArgs, "--help"],\n  { timeout: 5_000 },\n)',
  };
  const other = { ...wrapped, call: 'execFile(\n  "sh",\n  [...targetArgs, "--help"],\n)' };
  const report = classify([wrapped, other], [entry]);
  assert.deepEqual(
    report.unreviewed.map((s) => s.call),
    [other.call],
  );
  assert.deepEqual(report.stale, []);
});
