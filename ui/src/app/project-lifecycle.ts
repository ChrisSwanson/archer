export type ProjectLifecycleState = "active" | "grace" | "inactive" | "unknown";
export type ProjectVisibility = "auto" | "visible" | "hidden";
export type ProjectLifecycleReason = "empty" | "manual";
export type ProjectLifecycleAction = "show" | "archive" | "auto";

export interface ProjectLifecycle {
  readonly state: ProjectLifecycleState;
  readonly visibility: ProjectVisibility;
  readonly reason?: ProjectLifecycleReason;
  readonly emptySince?: string;
}

export const DEFAULT_PROJECT_LIFECYCLE: ProjectLifecycle = { state: "active", visibility: "auto" };
export const PROJECT_CATALOG_CHANGED = "archer:project-catalog-changed";

const STATES = new Set<ProjectLifecycleState>(["active", "grace", "inactive", "unknown"]);
const VISIBILITIES = new Set<ProjectVisibility>(["auto", "visible", "hidden"]);
const REASONS = new Set<ProjectLifecycleReason>(["empty", "manual"]);
const isoDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export function parseProjectLifecycle(value: unknown): ProjectLifecycle | null {
  if (value === undefined) return DEFAULT_PROJECT_LIFECYCLE;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some((key) => !["state", "visibility", "reason", "emptySince"].includes(key)) ||
    typeof entry.state !== "string" ||
    !STATES.has(entry.state as ProjectLifecycleState) ||
    typeof entry.visibility !== "string" ||
    !VISIBILITIES.has(entry.visibility as ProjectVisibility) ||
    (entry.reason !== undefined &&
      (typeof entry.reason !== "string" || !REASONS.has(entry.reason as ProjectLifecycleReason))) ||
    (entry.emptySince !== undefined && !isoDate(entry.emptySince))
  )
    return null;
  return {
    state: entry.state as ProjectLifecycleState,
    visibility: entry.visibility as ProjectVisibility,
    ...(entry.reason === undefined ? {} : { reason: entry.reason as ProjectLifecycleReason }),
    ...(entry.emptySince === undefined ? {} : { emptySince: entry.emptySince }),
  };
}

/** Visible overrides always win; only explicit or automatic inactivity joins the inactive group. */
export function isInactiveProject(lifecycle: ProjectLifecycle): boolean {
  return lifecycle.visibility !== "visible" && (lifecycle.visibility === "hidden" || lifecycle.state === "inactive");
}

/** Resolve the service-level API without carrying a project route into the request. */
export function serviceApiUrl(href: string, endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !endpoint.startsWith("api/") ||
    endpoint.includes("..")
  )
    return null;
  // The service root of `href`'s own origin, whatever `href` is there (a page, or a project's API base `/p/<name>/`).
  return new URL(`/${endpoint}`, url.origin).href;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LifecycleMutationResult =
  | { readonly ok: true; readonly lifecycle: ProjectLifecycle }
  | { readonly ok: false; readonly uncertain: boolean };

/** One deliberate request. Callers decide whether the user explicitly tries again. */
export async function mutateProjectLifecycle(
  fetchImpl: FetchLike,
  href: string,
  slug: string,
  action: ProjectLifecycleAction,
): Promise<LifecycleMutationResult> {
  const url = serviceApiUrl(href, "api/project-lifecycle");
  if (url === null) return { ok: false, uncertain: false };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, action }),
    });
  } catch {
    return { ok: false, uncertain: true };
  }
  if (!response.ok) return { ok: false, uncertain: response.status >= 500 || response.status === 408 };
  try {
    const body = (await response.json()) as { lifecycle?: unknown };
    const lifecycle = parseProjectLifecycle(body.lifecycle);
    return body.lifecycle === undefined || lifecycle === null
      ? { ok: false, uncertain: true }
      : { ok: true, lifecycle };
  } catch {
    return { ok: false, uncertain: true };
  }
}

export function announceProjectCatalogChanged(): void {
  window.dispatchEvent(new CustomEvent(PROJECT_CATALOG_CHANGED));
}
