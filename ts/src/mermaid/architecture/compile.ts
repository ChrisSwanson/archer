// An architecture-beta diagram: the profile's scan, Mermaid's parse, and the
// two reconciled.

import type { ServiceArchitecture } from "../../model/index.ts";
import type { FamilyResult } from "../family.ts";
import type { Preamble } from "../preamble.ts";
import { reconcile } from "../reconcile.ts";
import type { SourceLine } from "../source.ts";
import { adaptArchitecture, diagnoseArchitecture } from "./adapt.ts";
import { readArchitectureDb } from "./db.ts";
import { scanArchitecture } from "./scan.ts";

export function compileArchitecture(
  preamble: Preamble,
  header: SourceLine,
): Promise<FamilyResult<ServiceArchitecture>> {
  const scan = scanArchitecture(header, preamble.statements);
  const declared = {
    elements: new Map(scan.nodes.filter((n) => n.what !== "group").map((n) => [n.id, n.span] as const)),
    groups: new Map(scan.nodes.filter((n) => n.what === "group").map((n) => [n.id, n.span] as const)),
  };
  return reconcile(preamble, header, scan.report, scan.stopped, {
    mermaidType: "architecture",
    read: readArchitectureDb,
    adapt: (data) => adaptArchitecture(data, scan, header.statementSpan()),
    diagnose: (failure) => diagnoseArchitecture(failure, header, preamble.lines),
  }).then((result) => ({ ...result, declared }));
}
