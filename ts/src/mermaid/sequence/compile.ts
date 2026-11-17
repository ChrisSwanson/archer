// A sequence diagram: the profile's scan, Mermaid's parse, and the two
// reconciled.

import type { SequenceTrace } from "../../model/index.ts";
import { isError } from "../diagnostics.ts";
import { parseWithMermaid } from "../engine.ts";
import type { FamilyResult } from "../family.ts";
import { diagnosticsOf } from "../findings.ts";
import { addMermaidFailure } from "../parse-error.ts";
import type { Preamble } from "../preamble.ts";
import type { SourceLine } from "../source.ts";
import { adaptSequence } from "./adapt.ts";
import { readSequenceDb } from "./db.ts";
import { scanSequence } from "./scan.ts";

export async function compileSequence(preamble: Preamble, header: SourceLine): Promise<FamilyResult<SequenceTrace>> {
  const scan = scanSequence(header, preamble.statements);
  const scanned = diagnosticsOf(scan.findings);
  // Stopped at a nesting bound: the scan's refusal is the answer, and Mermaid is not asked to parse the rest.
  if (scan.stopped) return { model: undefined, diagnostics: scanned };
  const outcome = await parseWithMermaid(preamble.mermaidText, (diagram) => readSequenceDb(diagram.db));

  if (!outcome.ok) {
    const diagnostics = addMermaidFailure(scanned, outcome.failure, header, preamble.lines);
    return { model: undefined, diagnostics };
  }
  const adapted = adaptSequence(outcome.value, scan, header.statementSpan(), scanned.some(isError));
  const diagnostics = [...scanned, ...adapted.diagnostics];
  return { model: diagnostics.some(isError) ? undefined : adapted.model, diagnostics };
}
