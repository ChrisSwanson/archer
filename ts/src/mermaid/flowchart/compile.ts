// A flowchart: the profile's scan, Mermaid's parse, and the two reconciled.

import type { FreeformGraph } from "../../model/index.ts";
import { isError } from "../diagnostics.ts";
import { parseWithMermaid } from "../engine.ts";
import type { FamilyResult } from "../family.ts";
import { diagnosticsOf } from "../findings.ts";
import { addMermaidFailure } from "../parse-error.ts";
import type { Preamble } from "../preamble.ts";
import type { SourceLine } from "../source.ts";
import { adaptFlowchart } from "./adapt.ts";
import { readFlowDb } from "./db.ts";
import { scanFlowchart } from "./scan.ts";

export async function compileFlowchart(preamble: Preamble, header: SourceLine): Promise<FamilyResult<FreeformGraph>> {
  const scan = scanFlowchart(header, preamble.statements);
  const definite = scan.findings.filter((finding) => !finding.legacy);
  // Stopped at a nesting bound: the scan's refusal is the answer, and Mermaid is not asked to parse the rest.
  if (scan.stopped) return { model: undefined, diagnostics: [...diagnosticsOf(definite), ...scan.notes] };
  const outcome = await parseWithMermaid(preamble.mermaidText, (diagram) => readFlowDb(diagram.db));

  if (!outcome.ok) {
    // Mermaid refused the source, so the old Archer forms the scan found are
    // among the reasons, each reported with its rewrite.
    const scanned = diagnosticsOf(scan.findings);
    const diagnostics = addMermaidFailure(scanned, outcome.failure, header, preamble.lines);
    return { model: undefined, diagnostics: [...diagnostics, ...scan.notes] };
  }

  const scanned = diagnosticsOf(definite);
  const refusedLines = new Set(scanned.filter(isError).map((diagnostic) => diagnostic.span.start.line));
  const adapted = adaptFlowchart(outcome.value, scan, header.statementSpan(), refusedLines);
  const diagnostics = [...scanned, ...adapted.diagnostics, ...scan.notes];
  const declared = {
    elements: new Map(
      [...scan.nodes].map(([id, mentions]) => [id, (mentions.find((m) => m.declared) ?? mentions[0]!).span] as const),
    ),
    groups: new Map([...scan.groups].map(([id, group]) => [id, group.span] as const)),
  };
  return {
    model: diagnostics.some(isError) ? undefined : adapted.model,
    diagnostics,
    declared,
    classDefs: scan.classDefs,
  };
}
