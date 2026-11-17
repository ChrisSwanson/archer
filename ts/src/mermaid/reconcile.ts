// The common shape of compiling a state, ER, C4, architecture or journey
// diagram: the profile's line scan and Mermaid's parse, reconciled.
//
// Mermaid stops at its first problem; the scan names each one it finds, with
// its fix. When Mermaid refuses the source, its complaint is added only where
// the scan has nothing to say. When Mermaid accepts it, the adapter builds the
// model from Mermaid's database and refuses wherever Mermaid's reading and the
// scan's differ. While the scan has refused something, the adapter still runs
// for the problems it alone finds (unsafe labels), but its disagreements are
// left out: they follow from what the scan refused.

import { isError, type Diagnostic } from "./diagnostics.ts";
import { drift } from "./db-fields.ts";
import { parseWithMermaid, type MermaidFailure } from "./engine.ts";
import type { FamilyResult } from "./family.ts";
import { diagnosticsOf } from "./findings.ts";
import { addMermaidFailure } from "./parse-error.ts";
import type { Preamble } from "./preamble.ts";
import type { SourceLine } from "./source.ts";
import type { Report } from "./statements.ts";

export interface Reconciled<M> {
  model: M | undefined;
  diagnostics: Diagnostic[];
}

export interface Family<D, M> {
  /** The diagram type Mermaid reports for this family. */
  mermaidType: string;
  read: (db: unknown) => D;
  adapt: (data: D) => Reconciled<M>;
  /** Mermaid's complaint as a diagnostic, when the family's parser is not jison's. */
  diagnose?: (failure: MermaidFailure) => Diagnostic;
}

export async function reconcile<D, M>(
  preamble: Preamble,
  header: SourceLine,
  report: Report,
  stopped: boolean,
  family: Family<D, M>,
): Promise<FamilyResult<M>> {
  const scanned = diagnosticsOf(report.findings);
  const notes = report.finishNotes();
  // Stopped at a nesting bound: the scan's refusal is the answer, and Mermaid is not asked to parse the rest.
  if (stopped) return { model: undefined, diagnostics: [...scanned, ...notes] };
  const outcome = await parseWithMermaid(preamble.mermaidText, (diagram) => {
    if (diagram.type !== family.mermaidType) throw drift(family.mermaidType, `parsed as ${diagram.type}`);
    return family.read(diagram.db);
  });
  if (!outcome.ok) {
    const diagnostics = family.diagnose
      ? addComplaint(scanned, family.diagnose(outcome.failure))
      : addMermaidFailure(scanned, outcome.failure, header, preamble.lines);
    return { model: undefined, diagnostics: [...diagnostics, ...notes] };
  }
  const refused = scanned.some(isError);
  const adapted = family.adapt(outcome.value);
  const found = refused ? adapted.diagnostics.filter((d) => d.code !== "parser_disagreement") : adapted.diagnostics;
  const diagnostics = [...scanned, ...found, ...notes];
  return { model: diagnostics.some(isError) ? undefined : adapted.model, diagnostics };
}

/** Mermaid's complaint, unless the scan already refused something on its line. */
function addComplaint(scanned: readonly Diagnostic[], complaint: Diagnostic): Diagnostic[] {
  const explained = scanned.some((d) => isError(d) && d.span.start.line === complaint.span.start.line);
  return explained || (complaint.code === "invalid_diagram" && scanned.some(isError))
    ? [...scanned]
    : [...scanned, complaint];
}
