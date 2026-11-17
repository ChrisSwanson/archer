// A user journey: the profile's scan, Mermaid's parse, and the two reconciled.

import type { UserJourney } from "../../model/index.ts";
import type { FamilyResult } from "../family.ts";
import type { Preamble } from "../preamble.ts";
import { reconcile } from "../reconcile.ts";
import type { SourceLine } from "../source.ts";
import { adaptJourney } from "./adapt.ts";
import { readJourneyDb } from "./db.ts";
import { scanJourney } from "./scan.ts";

export function compileJourney(preamble: Preamble, header: SourceLine): Promise<FamilyResult<UserJourney>> {
  const scan = scanJourney(header, preamble.statements);
  return reconcile(preamble, header, scan.report, scan.stopped, {
    mermaidType: "journey",
    read: readJourneyDb,
    adapt: (data) => adaptJourney(data, scan, header.statementSpan()),
  });
}
