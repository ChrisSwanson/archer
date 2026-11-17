// compile(source): Mermaid source to Archer's model, or the diagnostics that
// say why not.
//
// Mermaid parses; Archer's profile decides what is accepted and where each
// problem is. A source over the size bound is not read at all. Otherwise
// every problem found is reported, in source order, up to the report's bound,
// and no model is produced while any error stands.

import type { DiagramModel } from "../model/index.ts";
import { error, finishReport, isError, span, type Diagnostic } from "./diagnostics.ts";
import type { FamilyResult } from "./family.ts";
import { compileFlowchart } from "./flowchart/compile.ts";
import { MAX_SOURCE_BYTES, sourceTooLargeMessage } from "./limits.ts";
import { readPreamble } from "./preamble.ts";
import { precheck } from "./precheck.ts";
import { compileArchitecture } from "./architecture/compile.ts";
import { compileC4 } from "./c4/compile.ts";
import { compileEr } from "./er/compile.ts";
import { compileJourney } from "./journey/compile.ts";
import { compileSequence } from "./sequence/compile.ts";
import { compileState } from "./state/compile.ts";
import { validateModel } from "./validate.ts";
import { nestingFindings } from "./nesting-profile.ts";
import { applyLineDirectives, readLineDirectives } from "./line-key.ts";
import { activeTelemetry, currentRequest, phaseEnd, phaseStart } from "../telemetry/index.ts";

export interface CompileOptions {
  /** Lift the source-size bound; for measuring the compiler, never for serving. */
  maxSourceBytes?: number;
}

export interface CompileResult {
  /** `null` while any error stands. */
  model: DiagramModel | null;
  diagnostics: Diagnostic[];
}

function refuseOversized(source: string, limit: number): CompileResult | undefined {
  // A UTF-8 byte is at most one UTF-16 unit, and a unit is at most three bytes.
  if (source.length * 3 <= limit) return undefined;
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes <= limit) return undefined;
  return { model: null, diagnostics: [error("source_too_large", sourceTooLargeMessage(bytes, limit), span(1, 1))] };
}

/** Where `compile` runs: in this thread unless the service installed its worker pool (service/compile-pool.ts). */
export type CompileBackend = (source: string, options: CompileOptions) => Promise<CompileResult>;
let backend: CompileBackend | null = null;

/** Routes every `compile` through `next` (null: back in this thread). The service's compile pool installs itself here. */
export function setCompileBackend(next: CompileBackend | null): void {
  backend = next;
}

export async function compile(source: string, options: CompileOptions = {}): Promise<CompileResult> {
  const run = backend ?? compileInThisThread;
  const telemetry = activeTelemetry();
  if (telemetry === null) return run(source, options);
  // Development telemetry: duration by family, attributed to the request it ran for.
  const started = phaseStart();
  const result = await run(source, options);
  const ms = phaseEnd("compile", started);
  telemetry.compiled(readPreamble(source).family ?? "unknown", ms, result.model !== null, currentRequest()?.id);
  return result;
}

/** The compile itself, in this thread whatever backend is installed; the compile worker runs this. */
export function compileInThisThread(source: string, options: CompileOptions = {}): Promise<CompileResult> {
  return compileSource(source, options);
}

async function compileSource(source: string, options: CompileOptions): Promise<CompileResult> {
  const oversized = refuseOversized(source, options.maxSourceBytes ?? MAX_SOURCE_BYTES);
  if (oversized) return oversized;

  const preamble = readPreamble(source);
  const unread = precheck(preamble);
  if (unread) return { model: null, diagnostics: [unread] };
  const { header, family } = preamble;
  let result: FamilyResult<DiagramModel> = { model: undefined, diagnostics: [] };
  if (header && family === "flowchart") result = await compileFlowchart(preamble, header);
  else if (header && family === "sequence") result = await compileSequence(preamble, header);
  else if (header && family === "state") result = await compileState(preamble, header);
  else if (header && family === "er") result = await compileEr(preamble, header);
  else if (header && family === "c4") result = await compileC4(preamble, header);
  else if (header && family === "architecture") result = await compileArchitecture(preamble, header);
  else if (header && family === "journey") result = await compileJourney(preamble, header);

  // Line patterns and their meanings (ADR 0030): read from comments Mermaid ignores.
  const directives = readLineDirectives(preamble.lines, family);
  const found = [...preamble.diagnostics, ...result.diagnostics, ...directives.diagnostics];
  if (!found.some(isError) && result.model)
    found.push(...applyLineDirectives(result.model, directives, result.classDefs));
  const model = found.some(isError) ? undefined : result.model;
  // Validated on the way out: nothing copied from Mermaid is trusted for that.
  const problems = model ? validateModel(model) : [];
  if (problems.length > 0) {
    found.push(
      error(
        "invalid_model",
        `Archer refused its own reading of this diagram (${problems.slice(0, 3).join("; ")}). ` +
          "Rewrite the statements involved plainly, one per line, and report the source if it is valid.",
        header?.statementSpan() ?? span(1, 1),
      ),
    );
  }
  // The nesting profile: findings, never refusals, on a model that stands.
  if (model && problems.length === 0) {
    for (const finding of nestingFindings(model, result.declared, header?.statementSpan()))
      found.push(finding.diagnostic);
  }
  const diagnostics = finishReport(found);
  const failed = diagnostics.some(isError);
  return { model: failed ? null : (model ?? null), diagnostics };
}
