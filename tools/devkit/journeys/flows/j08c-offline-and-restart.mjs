// J8c (user-flows.md §6): see disconnect-lib.mjs. Runs in both submission modes (sandbox.mjs up --comment-submission).
import { DISCONNECT_INVARIANTS } from "./state-lib.mjs";
import { J8_MATRIX, disconnectJourney, j8Baseline } from "./disconnect-lib.mjs";

export const meta = {
  name: "flows-j08c-offline-and-restart",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J8c",
    baseline: j8Baseline("both", false),
    baselines: { immediate: j8Baseline("both", false), queued: j8Baseline("both", true) },
    matrix: J8_MATRIX,
  },
};
export default (args) => disconnectJourney(args, { mode: "both", id: meta.flow.id });
