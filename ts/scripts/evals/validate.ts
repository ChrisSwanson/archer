// Deterministic evaluation evidence from Archer's production authoring path.
// This module never acquires a service or presents a diagram.
import { createApplication, OperationError } from "../../src/application/index.ts";
import type { DiagramEnvelope } from "../../src/model/index.ts";
import { embeddedDiagrams, readNoteText } from "../../src/notes/embedded.ts";
import { findProject } from "../../src/project/index.ts";

export interface EvalValidationProblem {
  code: string;
  message: string;
  viewId?: string;
  source?: string;
  details?: unknown;
}

export interface EvalViewValidation {
  viewId: string;
  source: Record<string, unknown>;
  compileStatus: "compiled" | "failed";
  diagnostics: unknown[];
  envelope?: DiagramEnvelope | null;
  sourceRevision?: string | null;
  modelRevision?: string | null;
}

export interface EvalProjectValidation {
  status: "compiled" | "nonvisual" | "failed";
  views: EvalViewValidation[];
  problems: EvalValidationProblem[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function refusal(error: unknown): EvalValidationProblem {
  return {
    code: error instanceof OperationError ? String(error.data["code"]) : "validation_error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof OperationError ? { details: error.data } : {}),
  };
}

/** Validate every inventoried view's current source, retaining last-valid models as evidence only. */
export async function validateEvalProject(projectDir: string): Promise<EvalProjectValidation> {
  const app = createApplication({ cwd: projectDir });
  const views: EvalViewValidation[] = [];
  const problems: EvalValidationProblem[] = [];
  try {
    const listed = (await app.call("list_diagrams")).structured;
    for (const diagnostic of Array.isArray(listed["diagnostics"]) ? listed["diagnostics"] : []) {
      const d = record(diagnostic);
      problems.push({ code: String(d["code"]), message: String(d["message"]), details: diagnostic });
    }
    // list_diagrams exposes note metadata but not every embedded-fence refusal.
    // Reuse the production note reader/inventory rather than parsing Markdown here.
    const project = findProject(projectDir);
    for (const value of Array.isArray(listed["notes"]) ? listed["notes"] : []) {
      const note = record(value);
      const source = String(note["path"]);
      for (const message of Array.isArray(note["problems"]) ? note["problems"] : []) {
        problems.push({ code: "note_inventory_error", message: String(message), source });
      }
      if (readNoteText(project, source) === null) {
        problems.push({ code: "note_unreadable", message: "Note cannot be read as bounded UTF-8 text.", source });
      } else {
        for (const message of embeddedDiagrams(project, source).problems) {
          problems.push({ code: "embedded_inventory_error", message, source });
        }
      }
    }
    const ids = [
      ...(Array.isArray(listed["views"]) ? listed["views"] : []).map((v) => String(record(v)["id"])),
      ...(Array.isArray(listed["embedded"]) ? listed["embedded"] : []).map((v) => String(record(v)["address"])),
    ];
    for (const viewId of new Set(ids)) {
      try {
        const read = (await app.call("read_diagram", { viewId })).structured;
        const compile = record(read["compile"]);
        const diagnostics = Array.isArray(compile["diagnostics"]) ? compile["diagnostics"] : [];
        const compiled = compile["status"] === "compiled" && read["envelope"] != null;
        views.push({
          viewId,
          source: record(read["source"]),
          compileStatus: compiled ? "compiled" : "failed",
          diagnostics,
          ...(read["envelope"] === undefined ? {} : { envelope: read["envelope"] as DiagramEnvelope | null }),
          ...(read["sourceRevision"] === undefined ? {} : { sourceRevision: read["sourceRevision"] as string | null }),
          ...(read["modelRevision"] === undefined ? {} : { modelRevision: read["modelRevision"] as string | null }),
        });
        if (!compiled)
          problems.push({
            code: "compile_failed",
            message: "Current source did not compile.",
            viewId,
            details: diagnostics,
          });
      } catch (error) {
        const problem = { ...refusal(error), viewId };
        problems.push(problem);
        views.push({ viewId, source: {}, compileStatus: "failed", diagnostics: [problem] });
      }
    }
  } catch (error) {
    problems.push(refusal(error));
  } finally {
    app.close();
  }
  return { status: problems.length > 0 ? "failed" : views.length > 0 ? "compiled" : "nonvisual", views, problems };
}
