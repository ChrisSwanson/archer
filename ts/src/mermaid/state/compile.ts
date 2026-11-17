// A state diagram: the profile's scan, Mermaid's parse, and the two
// reconciled.

import type { StateMachine } from "../../model/index.ts";
import type { FamilyResult } from "../family.ts";
import type { Preamble } from "../preamble.ts";
import { reconcile } from "../reconcile.ts";
import type { SourceLine } from "../source.ts";
import { adaptState } from "./adapt.ts";
import { readStateDb } from "./db.ts";
import { scanState } from "./scan.ts";

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
  }).then((result) => ({ ...result, declared }));
}
