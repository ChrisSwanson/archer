import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { SMOKE_CASES, getEvalCase, buildSolverInput } from "./corpus.ts";
import { prepareEvalRun } from "./harness.ts";
import { validateEvalProject } from "./validate.ts";

/** Local evaluation commands; no implicit project, service access or model invocation. */
export async function evalMain(args: readonly string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "case",
        "track",
        "root",
        "bundle",
        "skill",
        "cohort",
        "variant",
        "source",
        "port",
        "project",
        "size",
        "parent",
      ].map((name) => [name, { type: "string" as const }]),
    ),
  });
  const required = (key: string): string => {
    const value = values[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`--${key} is required`);
    return value;
  };
  if (positionals.length !== 1)
    throw new Error("Choose one command: cases, prepare, validate, correction or retrieval");
  switch (positionals[0]) {
    case "cases":
      return { cases: SMOKE_CASES.map(({ id, title }) => ({ id, title })) };
    case "prepare": {
      const track = required("track");
      if (track !== "authoring" && track !== "activation") throw new Error("--track must be authoring or activation");
      const evalCase = getEvalCase(required("case"));
      return prepareEvalRun({
        root: required("root"),
        bundleDir: required("bundle"),
        skillDir: required("skill"),
        solver: buildSolverInput(evalCase, track),
        caseId: evalCase.id,
        track,
        cohort: required("cohort"),
        variant: required("variant"),
        sourceCommit: required("source"),
        port: Number(required("port")),
      });
    }
    case "validate":
      return validateEvalProject(required("project"));
    case "correction":
      return (await import("./correction.ts")).runCorrectionEval(
        values.parent ? { parentDirectory: values.parent } : {},
      );
    case "retrieval": {
      const size = Number(values.size ?? "20");
      if (size !== 20 && size !== 100) throw new Error("--size must be 20 or 100");
      const { buildRetrievalFixture, evaluateRetrieval } = await import("./retrieval.ts");
      const root = await mkdtemp(join(tmpdir(), "archer-retrieval-"));
      try {
        const roots: { name: "alpha" | "beta"; root: string; expectedNoteCount: 20 | 100 }[] = [];
        for (const name of ["alpha", "beta"] as const) {
          const project = join(root, name);
          for (const [file, text] of Object.entries(buildRetrievalFixture(name, size))) {
            const path = join(project, file);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, text);
          }
          roots.push({ name, root: project, expectedNoteCount: size });
        }
        const report = await evaluateRetrieval(roots);
        return { ...report, status: report.fixtureValidity.status };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    default:
      throw new Error("Unknown command; choose cases, prepare, validate, correction or retrieval");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await evalMain(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result !== null && typeof result === "object" && "status" in result && result.status === "failed")
      process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
