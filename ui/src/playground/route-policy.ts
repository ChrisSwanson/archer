import { matchApiRoute } from "../../../shared/api-routes.mts";
import type { PlaygroundProject } from "../../../shared/playground-snapshot.mts";
import { parseWalkthroughPosition } from "../../../shared/walkthrough-position.mts";
import { acceptSelection, type SelectionOutcome } from "../../../ts/src/service/selection-check.ts";
import type { DiagramEnvelope } from "../../../ts/src/model/envelope.ts";
import { validateEnvelope } from "../protocol/validate";

/** `example`: answered with the runtime's own example data (`examples.ts`), read-only. */
export type StaticRouteDisposition = "snapshot" | "local" | "example" | "unavailable";
/** Deliberate inventory: a production route addition must be classified before it enters the playground. */
export const STATIC_ROUTE_POLICY: Readonly<Record<string, StaticRouteDisposition>> = {
  projects: "snapshot",
  "browser-projects": "snapshot",
  connection: "unavailable",
  "project-lifecycle": "unavailable",
  settings: "example",
  "settings-put": "unavailable",
  "project-settings": "unavailable",
  "project-settings-patch": "unavailable",
  "note-emphases": "unavailable",
  "note-emphases-set": "unavailable",
  "comment-activity": "local",
  notes: "snapshot",
  "notes-content": "snapshot",
  "notes-diagram": "snapshot",
  "notes-all": "snapshot",
  comments: "local",
  "comments-pending": "local",
  "comments-create": "local",
  "comments-submit": "unavailable",
  "comments-reply": "local",
  "comments-resolve": "local",
  "comments-dismiss": "local",
  "comments-edit": "local",
  "comments-delete": "local",
  listeners: "unavailable",
  "listeners-pin": "unavailable",
  "listeners-launch": "unavailable",
  operations: "unavailable",
  selection: "local",
  "walkthrough-position": "local",
  "reader-exploration": "unavailable",
  documents: "snapshot",
  diagrams: "snapshot",
  compile: "snapshot",
  walkthroughs: "snapshot",
  "expand-menu": "unavailable",
  exploration: "unavailable",
  bootstrap: "snapshot",
  events: "unavailable",
  search: "unavailable",
  "browser-search": "unavailable",
  "walkthroughs-old": "unavailable",
  "documents-content": "snapshot",
  diagram: "snapshot",
  "diagram-source": "snapshot",
  emphasis: "snapshot",
  thumbnail: "snapshot",
  "authoring-status": "local",
  "authoring-mutate": "unavailable",
  "authoring-open": "unavailable",
  "authoring-snapshot": "unavailable",
  "authoring-preview": "unavailable",
  "authoring-edit": "unavailable",
  "authoring-presentation": "unavailable",
  "authoring-operation": "unavailable",
};

/** Shared production routing owns method, scope, precedence and parameter decoding. A miss cannot reach fetch. */
export function classifyStaticRequest(
  method: string,
  segments: readonly string[],
  scope: "project" | "service" = "project",
): {
  readonly id: string;
  readonly policy: StaticRouteDisposition;
  readonly params: Readonly<Record<string, string>>;
} | null {
  const matched = matchApiRoute(method, scope, segments);
  return matched === null
    ? null
    : { id: matched.spec.id, policy: STATIC_ROUTE_POLICY[matched.spec.id] ?? "unavailable", params: matched.params };
}

function served(project: PlaygroundProject, viewId: string): DiagramEnvelope | null {
  const raw = project.responses[`api/diagrams/${encodeURIComponent(viewId)}`];
  return validateEnvelope(raw).ok ? (raw as DiagramEnvelope) : null;
}

/** Resolve ids, labels and revision stamps with exactly the live service's production selection validator. */
export function validateStaticSelection(body: unknown, project: PlaygroundProject): SelectionOutcome {
  return acceptSelection(body, { presentation: null, served: (viewId) => served(project, viewId) });
}

/** Reader position is memory-only state, accepted by the service's shared production parser. */
export function validateStaticPosition(body: unknown, project: PlaygroundProject) {
  const parsed = parseWalkthroughPosition(body, (viewId) => served(project, viewId) !== null);
  return parsed.ok ? parsed : { ...parsed, status: 422 as const, code: "invalid_walkthrough_position" };
}
