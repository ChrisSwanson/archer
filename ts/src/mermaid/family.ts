// What compiling one diagram family yields, before the report is finished.

import type { Diagnostic } from "./diagnostics.ts";
import type { Declarations } from "./nesting-profile.ts";

export interface FamilyResult<M> {
  /** Absent when the family's own checks refused the source. */
  model: M | undefined;
  diagnostics: Diagnostic[];
  /** Where each element and container is declared, for findings over the model (`nesting-profile.ts`). */
  declared?: Declarations;
  /** The `classDef` names the source declares, for `%% archer-key <category>` (`line-key.ts`). */
  classDefs?: ReadonlySet<string>;
}
