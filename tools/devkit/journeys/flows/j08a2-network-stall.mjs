// J8a, real network loss (user-flows.md v1.1 amendment): see disconnect-lib.mjs. The page's open event stream is
// held open and silent and every request fails, with no `offline` event (Chromium's offline mode keeps an open
// stream alive, so j08a alone does not show this). With no traffic the notice is bounded by ADR 0015's 45 s
// silent-stall watchdog; the measured time is in flowState.j8.noticeMs. A second part then stalls the network again just
// before a second Add comment: the notice must come from that failed write ("by the first failed read or write"),
// before any read failed (G4 "network stalled, first failed write: …"; writeNoticeMs). Runs in both submission
// modes. Its flow id is J8a-stall, so the report keeps its cells apart from j08a's.
import { DISCONNECT_INVARIANTS } from "./state-lib.mjs";
import { J8_MATRIX, disconnectJourney, j8Baseline } from "./disconnect-lib.mjs";

export const meta = {
  name: "flows-j08a2-network-stall",
  invariants: DISCONNECT_INVARIANTS,
  flow: {
    id: "J8a-stall",
    baseline: j8Baseline("stall", false),
    baselines: { immediate: j8Baseline("stall", false), queued: j8Baseline("stall", true) },
    matrix: J8_MATRIX,
  },
};
export default (args) => disconnectJourney(args, { mode: "stall", id: meta.flow.id });
