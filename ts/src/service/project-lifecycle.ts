import type { ProjectVisibility } from "../state/project-lifecycle.ts";

export const MAX_PROJECT_LIFECYCLE_BODY_BYTES = 1024;
export type ProjectLifecycleAction = "show" | "archive" | "auto";
export interface ProjectLifecycleMutation {
  readonly slug: string;
  readonly action: ProjectLifecycleAction;
}

export class ProjectLifecycleRequestError extends Error {
  override readonly name = "ProjectLifecycleRequestError";
}

/** Strict parser for the browser mutation boundary. */
export function parseProjectLifecycleMutation(value: unknown): ProjectLifecycleMutation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProjectLifecycleRequestError("the project lifecycle request must be an object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "slug" && key !== "action"))
    throw new ProjectLifecycleRequestError("the project lifecycle request names unsupported fields");
  if (
    typeof object.slug !== "string" ||
    object.slug.length < 1 ||
    object.slug.length > 256 ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(object.slug)
  )
    throw new ProjectLifecycleRequestError("slug must be the bounded project slug from the catalog");
  if (object.action !== "show" && object.action !== "archive" && object.action !== "auto")
    throw new ProjectLifecycleRequestError("action must be show, archive, or auto");
  return { slug: object.slug, action: object.action };
}

export function visibilityFor(action: ProjectLifecycleAction): ProjectVisibility {
  return action === "show" ? "visible" : action === "archive" ? "hidden" : "auto";
}
