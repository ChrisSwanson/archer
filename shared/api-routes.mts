// The data plane's API routes as data: names and patterns only, so the service (ts/src/service/routes.ts), its
// metrics keys (debug-http.ts) and the page may read one table. The service answers each at `/p/<name>/api/…`
// (project scope) or `/api/…` (service scope), behind its own authentication; a request no entry matches is the
// bare 404 (ADR 0014, ADR 0015: no 405s from the router). Order is precedence: the first entry that matches wins.

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRouteSpec {
  readonly id: string;
  /** The API name, the segment after `api/`; the metrics key spells it (debug-http.ts `API_NAMES`). */
  readonly name: string;
  /** `*`: any method no earlier entry for this path took (authoring answers a wrong method itself, 405). */
  readonly method: ApiMethod | "*";
  readonly scope: "project" | "service" | "both";
  /** Segments from `api` on; `:name` is a parameter, passed decoded. */
  readonly path: readonly string[];
  /** A raw segment each parameter must match, or the entry does not match. */
  readonly patterns?: Readonly<Record<string, RegExp>>;
  /** Literal segments are compared decoded, not as sent (the comments and notes routes decode every id first). */
  readonly decoded?: boolean;
  /** Every path under this name is its routes': a miss below it is the bare 404 alone (no event count). */
  readonly owned?: boolean;
  /** At project scope, answered with `x-archer-event-seq`: the publication count the read was taken at. */
  readonly eventSeq: boolean;
  /** Answered with an ETag the page revalidates (`If-None-Match`). */
  readonly etag: boolean;
  /** The handler checks the request's Origin before reading its body (ADR 0014 mutations). */
  readonly originChecked: boolean;
}

const route = (
  id: string,
  method: ApiRouteSpec["method"],
  path: readonly string[],
  flags: Partial<Omit<ApiRouteSpec, "id" | "name" | "method" | "path">> = {},
): ApiRouteSpec => ({
  id,
  name: path[1]!,
  method,
  scope: "project",
  path,
  eventSeq: false,
  etag: false,
  originChecked: false,
  ...flags,
});
/** A read of the project's state, answered at its event count. */
const read = (id: string, path: readonly string[], flags: Partial<ApiRouteSpec> = {}): ApiRouteSpec =>
  route(id, "GET", path, { eventSeq: true, ...flags });
const comments = { owned: true, decoded: true } as const;
const authoring = { owned: true } as const;

export const API_ROUTES: readonly ApiRouteSpec[] = [
  // Service and project scope alike.
  read("projects", ["api", "projects"], { scope: "both", etag: true }),
  read("browser-projects", ["api", "browser-projects"], { scope: "both", etag: true }),
  read("connection", ["api", "connection"], { scope: "both" }),
  route("project-lifecycle", "POST", ["api", "project-lifecycle"], { scope: "both", originChecked: true }),
  route("settings", "GET", ["api", "settings"], { scope: "both" }),
  // Refused for every credential (ADR 0028): the body is never read.
  route("settings-put", "PUT", ["api", "settings"], { scope: "both" }),
  // Per project.
  route("project-settings", "GET", ["api", "project-settings"]),
  route("project-settings-patch", "PATCH", ["api", "project-settings"]),
  route("note-emphases", "GET", ["api", "note-emphases"], { owned: true }),
  route("note-emphases-set", "POST", ["api", "note-emphases"], { owned: true, originChecked: true }),
  route("comment-activity", "GET", ["api", "comment-activity"], comments),
  route("notes", "GET", ["api", "notes"], comments),
  route("notes-content", "GET", ["api", "notes", "content"], comments),
  route("notes-diagram", "GET", ["api", "notes", "diagram"], comments),
  route("notes-all", "GET", ["api", "notes", "all"], comments),
  route("comments", "GET", ["api", "comments"], comments),
  route("comments-pending", "GET", ["api", "comments", "pending"], comments),
  route("comments-create", "POST", ["api", "comments"], { ...comments, originChecked: true }),
  route("comments-submit", "POST", ["api", "comments", "submit"], { ...comments, originChecked: true }),
  route("comments-reply", "POST", ["api", "comments", ":threadId", "replies"], { ...comments, originChecked: true }),
  route("comments-resolve", "POST", ["api", "comments", ":threadId", "resolve"], { ...comments, originChecked: true }),
  route("comments-dismiss", "POST", ["api", "comments", ":threadId", "dismiss"], { ...comments, originChecked: true }),
  route("comments-edit", "PATCH", ["api", "comments", ":threadId", ":commentId"], { ...comments, originChecked: true }),
  route("comments-delete", "DELETE", ["api", "comments", ":threadId", ":commentId"], {
    ...comments,
    originChecked: true,
  }),
  route("listeners", "GET", ["api", "listeners"], { owned: true }),
  route("listeners-pin", "POST", ["api", "listeners", "pin"], { owned: true, originChecked: true }),
  route("listeners-launch", "POST", ["api", "listeners", "launch"], { owned: true, originChecked: true }),
  route("operations", "POST", ["api", "operations"], { originChecked: true }),
  route("selection", "POST", ["api", "selection"], { originChecked: true }),
  route("walkthrough-position", "POST", ["api", "walkthrough-position"], { originChecked: true }),
  route("reader-exploration", "POST", ["api", "reader-exploration"], { originChecked: true }),
  read("documents", ["api", "documents"]),
  read("diagrams", ["api", "diagrams"]),
  read("compile", ["api", "compile"]),
  read("walkthroughs", ["api", "walkthroughs"]),
  read("expand-menu", ["api", "expand-menu"], { etag: true }),
  read("exploration", ["api", "exploration"], { etag: true }),
  read("bootstrap", ["api", "bootstrap"]),
  read("events", ["api", "events"]),
  read("search", ["api", "search"]),
  read("browser-search", ["api", "browser-search"]),
  read("walkthroughs-old", ["api", "walkthroughs", "old"]),
  read("documents-content", ["api", "documents", "content"]),
  read("diagram", ["api", "diagrams", ":viewId"], { etag: true }),
  read("diagram-source", ["api", "diagram-source", ":viewId"]),
  read("emphasis", ["api", "emphasis", ":viewId"]),
  read("thumbnail", ["api", "thumbnails", ":viewId"], { etag: true }),
  // Browser authoring (authoring-http.ts): a cookie grant only, admitted by the backend.
  route("authoring-status", "GET", ["api", "authoring"], authoring),
  route("authoring-mutate", "*", ["api", "authoring"], authoring),
  ...(["open", "snapshot", "preview", "edit", "presentation"] as const).map((action) =>
    route(`authoring-${action}`, "*", ["api", "authoring", action], authoring),
  ),
  route("authoring-operation", "*", ["api", "authoring", "operations", ":operationId"], {
    ...authoring,
    patterns: { operationId: /^[a-f0-9]{32}$/u },
  }),
];

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The first entry `admit` allows (every one, by default) that matches `method` at `scope` for `segments` (from
 * `api` on, as sent), with its parameters decoded; null when none does. A segment that does not decode matches no
 * parameter, nor a literal of a `decoded` entry.
 */
export function matchApiRoute(
  method: string,
  scope: "project" | "service",
  segments: readonly string[],
  admit: (spec: ApiRouteSpec) => boolean = () => true,
): { readonly spec: ApiRouteSpec; readonly params: Readonly<Record<string, string>> } | null {
  for (const spec of API_ROUTES) {
    if (spec.path.length !== segments.length || (spec.scope !== scope && spec.scope !== "both")) continue;
    if (spec.method !== method && spec.method !== "*") continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; matched && index < segments.length; index++) {
      const want = spec.path[index]!,
        raw = segments[index]!;
      if (want.startsWith(":")) {
        const name = want.slice(1),
          value = decodeSegment(raw);
        if (value === null || (spec.patterns?.[name] !== undefined && !spec.patterns[name].test(raw))) matched = false;
        else params[name] = value;
      } else matched = (spec.decoded === true && index > 1 ? decodeSegment(raw) : raw) === want;
    }
    if (matched && admit(spec)) return { spec, params };
  }
  return null;
}
