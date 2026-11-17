// J8b (user-flows.md §6): see disconnect-lib.mjs. Runs in both submission modes (sandbox.mjs up --comment-submission).
import { DISCONNECT_INVARIANTS } from "./state-lib.mjs";
import { J8_MATRIX, disconnectJourney, j8Baseline } from "./disconnect-lib.mjs";

export const meta = {
  name: "flows-j08b-service-restart",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J8b",
    baseline: j8Baseline("restart", false),
    baselines: { immediate: j8Baseline("restart", false), queued: j8Baseline("restart", true) },
    matrix: J8_MATRIX,
  },
};
export default (args) => disconnectJourney(args, { mode: "restart", id: meta.flow.id });
