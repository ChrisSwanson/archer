// A state diagram: the profile's scan, Mermaid's parse, and the two
// reconciled.

import type { StateMachine } from "../../model/index.ts";
import { error, type Diagnostic } from "../diagnostics.ts";
import type { MermaidFailure } from "../engine.ts";
import type { FamilyResult } from "../family.ts";
import type { Preamble } from "../preamble.ts";
import { reconcile } from "../reconcile.ts";
import type { SourceLine } from "../source.ts";
import { adaptState } from "./adapt.ts";
import { readStateDb } from "./db.ts";
import { scanState, type StateScan } from "./scan.ts";

export function compileState(preamble: Preamble, header: SourceLine): Promise<FamilyResult<StateMachine>> {
  const scan = scanState(header, preamble.statements);
  const declared = {
    elements: new Map(scan.states.filter((s) => !s.composite).map((s) => [s.id, s.declaredAt ?? s.span] as const)),
    groups: new Map(scan.states.filter((s) => s.composite).map((s) => [s.id, s.declaredAt ?? s.span] as const)),
  };
  return reconcile(preamble, header, scan.report, scan.stopped, {
    mermaidType: "stateDiagram",
    read: readStateDb,
    adapt: (data) => adaptState(data, scan, header.statementSpan()),
    explain: (failure) => explainStateFailure(failure, scan, preamble.lines),
  }).then((result) => ({ ...result, declared }));
}

/**
 * Mermaid's "State name must be a single word" for a state declared as a bare `state B`: Mermaid misreads
 * that declaration when the state also has transitions to and from a composite state. Declaring it with a
 * quoted name, or giving it a label instead, avoids the misreading.
 */
function explainStateFailure(
  failure: MermaidFailure,
  scan: StateScan,
  lines: readonly SourceLine[],
): Diagnostic | undefined {
  const name = /State name must be a single word\. Found: "?([^"\s]+)/.exec(failure.message)?.[1];
  if (name === undefined) return undefined;
  const state = scan.states.find((s) => s.id === name && s.declaredAt !== undefined);
  const line = state?.declaredAt === undefined ? undefined : lines[state.declaredAt.start.line - 1];
  if (state === undefined || line === undefined || line.text.trim().split(/\s+/).join(" ") !== `state ${name}`)
    return undefined;
  return {
    ...error(
      "unexpected_token",
      `Mermaid cannot read \`state ${name}\` here, beside a composite state it has transitions to and from: ` +
        `declare it as \`state "${name}" as ${name}\`, or give it a label with \`${name} : Label\``,
      line.statementSpan(),
    ),
    hint: `${line.indent}state "${name}" as ${name}`,
  };
}
