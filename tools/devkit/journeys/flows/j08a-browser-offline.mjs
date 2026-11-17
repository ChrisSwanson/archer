// J8a (user-flows.md §6): see disconnect-lib.mjs. Runs in both submission modes (sandbox.mjs up --comment-submission).
import { DISCONNECT_INVARIANTS } from "./state-lib.mjs";
import { J8_MATRIX, disconnectJourney, j8Baseline } from "./disconnect-lib.mjs";

export const meta = {
  name: "flows-j08a-browser-offline",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J8a",
    baseline: j8Baseline("offline", false),
    baselines: { immediate: j8Baseline("offline", false), queued: j8Baseline("offline", true) },
    matrix: J8_MATRIX,
  },
};
export default (args) => disconnectJourney(args, { mode: "offline", id: meta.flow.id });
