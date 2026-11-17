// A C4 diagram: the profile's scan, Mermaid's parse, and the two reconciled.

import type { C4Model } from "../../model/index.ts";
import type { FamilyResult } from "../family.ts";
import type { Preamble } from "../preamble.ts";
import { reconcile } from "../reconcile.ts";
import type { SourceLine } from "../source.ts";
import { adaptC4 } from "./adapt.ts";
import { readC4Db } from "./db.ts";
import { scanC4 } from "./scan.ts";

export function compileC4(preamble: Preamble, header: SourceLine): Promise<FamilyResult<C4Model>> {
  const scan = scanC4(header, preamble.statements);
  const declared = {
    elements: new Map(scan.elements.map((e) => [e.id, e.span] as const)),
    groups: new Map(scan.boundaries.map((b) => [b.id, b.span] as const)),
  };
  return reconcile(preamble, header, scan.report, scan.stopped, {
    mermaidType: "c4",
    read: readC4Db,
    adapt: (data) => adaptC4(data, scan, header.statementSpan()),
  }).then((result) => ({ ...result, declared }));
}
