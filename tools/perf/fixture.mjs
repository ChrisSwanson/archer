#!/usr/bin/env node
// The performance rubric's fixture state (§1 test target) on a devkit sandbox: an agent presentation of a view,
// as baseline B had (`seq-awkward` presented by an agent but not shown). Runs `archer call present_diagram` as an
// agent does, in the sandbox's copy of the project with the sandbox's own environment.
//
//   node tools/perf/fixture.mjs present --sandbox <name> [--project awkward] [--view seq-awkward]
//
// Prints one JSON line {project, view, presented: true|false, code?}; never the link or a token.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readRecord, sandboxEnv } from "../devkit/sandbox.mjs";
import { cliCall } from "../devkit/security/lib/agent-clients.mjs";

export async function present({ sandbox, project = "awkward", view = "seq-awkward" }) {
  const record = readRecord(sandbox);
  const root = record.projects.find((p) => (p.slug ?? p.name) === project)?.root;
  if (!root) throw new Error(`sandbox ${sandbox} has no project ${project}`);
  const answer = await cliCall("present_diagram", { viewId: view }, { cwd: root, env: sandboxEnv(record) });
  return { project, view, presented: answer.admitted, ...(answer.admitted ? {} : { code: answer.code }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { sandbox: { type: "string" }, project: { type: "string" }, view: { type: "string" } },
  });
  if (cmd !== "present" || !values.sandbox) {
    process.stderr.write("usage: fixture.mjs present --sandbox <name> [--project awkward] [--view seq-awkward]\n");
    process.exit(2);
  }
  present(values).then(
    (r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exitCode = r.presented ? 0 : 1;
    },
    (e) => {
      process.stderr.write(`${e?.message ?? e}\n`);
      process.exit(2);
    },
  );
}
