import {
  compareDiagramCommits,
  listStaleDiagrams,
  readDiagramAtCommit,
  type HistoricalDiagram,
} from "../accuracy/index.ts";
import type { Project } from "../project/index.ts";
import type { OperationResult } from "./index.ts";
import { staleWalkthroughs } from "./walkthroughs.ts";

// Exact source bytes are internal recovery/compiler material. The operation
// carries source.text and the full normalized model, without numeric-byte duplication.
function historyPayload(history: HistoricalDiagram): Record<string, unknown> {
  if (history.status === "unavailable") return { ...history };
  const { sourceBytes: _bytes, ...result } = history.result;
  return { ...history, result };
}

export async function runAccuracyOperation(
  name: string,
  project: Project,
  args: Readonly<Record<string, unknown>>,
): Promise<OperationResult> {
  if (name === "list_stale_diagrams") {
    const payload = await listStaleDiagrams(
      project,
      typeof args["viewId"] === "string" ? { viewId: args["viewId"] } : {},
    );
    // Walkthroughs need no Git and no coverage: any diagram's, as ADR 0034 §3 says.
    const walkthroughs = await staleWalkthroughs(
      project,
      typeof args["viewId"] === "string" ? args["viewId"] : undefined,
    );
    const said =
      walkthroughs.length === 0
        ? ""
        : ` ${walkthroughs.length} walkthrough(s) need attention (structuredContent.walkthroughs): offer to repair them with write_walkthrough, never unasked.`;
    return {
      text:
        (payload.status === "unavailable"
          ? `Git accuracy unavailable: ${payload.reason}.`
          : `${payload.views.filter((view) => view.status === "stale").length} stale diagram(s); ${payload.views.length} registered view(s) inspected.`) +
        said,
      structured: { ...payload, walkthroughs },
    };
  }
  const viewId = String(args["viewId"]);
  if (name === "read_diagram_at_commit") {
    const history = await readDiagramAtCommit(project, viewId, String(args["commit"]));
    return {
      text: `Historical diagram '${viewId}': ${history.status}${history.status === "unavailable" ? ` (${history.reason})` : ` at ${history.commit}.`}`,
      structured: historyPayload(history),
    };
  }
  const comparison = await compareDiagramCommits(project, viewId, String(args["from"]), String(args["to"]));
  return {
    text:
      comparison.semantic === null
        ? `Diagram comparison unavailable: ${comparison.before.status} → ${comparison.after.status}.`
        : `${comparison.semantic.changes.length} semantic change(s) between diagram commits.`,
    structured: { ...comparison, before: historyPayload(comparison.before), after: historyPayload(comparison.after) },
  };
}
