// The nesting profile's write ratchet (ADR 0029): an agent write may not ADD a structural nesting
// finding (`mermaid/nesting-profile.ts`). Findings already in the source, advisory notes, and a
// source on either side that does not compile are left to the compile report. With the reading
// rules (ADR 0030) it makes up `writeRefusals`: what write_diagram refuses and validate_diagram reports.

import { compile } from "../mermaid/index.ts";
import { addedNestingFindings, structuralCounts } from "../mermaid/nesting-profile.ts";
import type { Diagnostic } from "../mermaid/index.ts";
import { introducedBy, lintRefusal } from "../mermaid/lint.ts";
import { toolError } from "./errors.ts";

/** The structural nesting findings `next` adds to `base`, at lines of `next`; none without a base. */
export async function addedNesting(base: string | undefined, next: string): Promise<Diagnostic[]> {
  if (base === undefined) return [];
  // The new source first: most writes add nothing, and then the old one is never compiled.
  const after = await compile(next);
  if (after.model === null || structuralCounts(after.model).size === 0) return [];
  const before = await compile(base);
  if (before.model === null) return [];
  // The compile report places each finding at its declaration; match it by code and message.
  return addedNestingFindings(before.model, after.model).map(
    (finding) =>
      after.diagnostics.find((d) => d.code === finding.diagnostic.code && d.message === finding.diagnostic.message) ??
      finding.diagnostic,
  );
}

export function nestingRefusal(where: string, placed: readonly Diagnostic[]): string {
  return (
    `write_diagram did not write ${where}: the new source adds nesting the nested view cannot open one level at a time. ` +
    `${placed.map((d) => `Line ${d.span.start.line}: ${d.message}`).join(" ")} ` +
    "Nothing was written. Fix these and write again; findings already in the source are only reported."
  );
}

/**
 * Everything `write_diagram` refuses about a new source, given the one it replaces (`undefined`: none
 * can be read), at lines moved by `offset` (an embedded diagram's body line less one, so the lines are
 * the note's). `validate_diagram` reports the same as errors, so the two never disagree.
 */
export async function writeRefusals(
  base: string | undefined,
  next: string,
  offset = 0,
): Promise<{ nesting: Diagnostic[]; reading: Diagnostic[] }> {
  const move = (d: Diagnostic): Diagnostic =>
    offset === 0
      ? d
      : {
          ...d,
          span: {
            start: { ...d.span.start, line: d.span.start.line + offset },
            end: { ...d.span.end, line: d.span.end.line + offset },
          },
        };
  const nesting = (await addedNesting(base, next)).map(move);
  return { nesting, reading: (await introducedBy(base ?? null, next)).map(move) };
}

/** Throws the refusal `writeRefusals` found, if any. */
export async function refuseWrite(base: string | undefined, next: string, where: string, offset = 0): Promise<void> {
  const { nesting, reading } = await writeRefusals(base, next, offset);
  if (nesting.length > 0) throw toolError("invalid_source", nestingRefusal(where, nesting), { diagnostics: nesting });
  if (reading.length > 0)
    throw toolError("invalid_source", lintRefusal("write_diagram", reading), { diagnostics: reading });
}
