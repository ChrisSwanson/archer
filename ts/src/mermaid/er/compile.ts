// An ER diagram: the profile's scan, Mermaid's parse, and the two reconciled.

import type { EntityRelationship } from "../../model/index.ts";
import type { FamilyResult } from "../family.ts";
import type { Preamble } from "../preamble.ts";
import { reconcile } from "../reconcile.ts";
import type { SourceLine } from "../source.ts";
import { adaptEr } from "./adapt.ts";
import { readErDb } from "./db.ts";
import { scanEr } from "./scan.ts";

export function compileEr(preamble: Preamble, header: SourceLine): Promise<FamilyResult<EntityRelationship>> {
  const scan = scanEr(header, preamble.statements);
  return reconcile(preamble, header, scan.report, scan.stopped, {
    mermaidType: "er",
    read: readErDb,
    adapt: (data) => adaptEr(data, scan, header.statementSpan()),
  });
}
