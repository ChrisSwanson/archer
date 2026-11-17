/**
 * What a comment target names, read in one place. A `TargetRef` is `view:<id>`, `note:<path>` or exactly
 * `project:` (ts/src/comments/contract.ts). Code that branches on the kind goes through `onTarget`, whose
 * cases are required by kind: a new kind of target is a compile error at every branch, not a silent
 * fall-through into "a note" (wave 2 review, findings 4, 5, 16 and 18).
 */
// Type-only, so the service's plain-Node runs of `comment-activity.ts` can load this module too.
import type { TargetRef } from "./contract";

const PROJECT_TARGET = "project:" satisfies TargetRef;

export type TargetParts =
  | { readonly kind: "view"; readonly viewId: string }
  | { readonly kind: "note"; readonly path: string }
  | { readonly kind: "project" };

export type TargetKind = TargetParts["kind"];

/** The kind and identity of a target the page already holds as a `TargetRef`. */
export function targetParts(target: TargetRef): TargetParts {
  if (target === PROJECT_TARGET) return { kind: "project" };
  if (target.startsWith("view:")) return { kind: "view", viewId: target.slice(5) };
  return { kind: "note", path: target.slice(5) };
}

/** A string that has a target's shape (`view:` or `note:` with something after it, or exactly `project:`); else null. */
export function readTargetRef(value: unknown, maxChars = Number.POSITIVE_INFINITY): TargetRef | null {
  if (typeof value !== "string" || value.length > maxChars) return null;
  if (value === PROJECT_TARGET) return value;
  return /^(view|note):./u.test(value) ? (value as TargetRef) : null;
}

type Cases<R> = { readonly [K in TargetKind]: (parts: Extract<TargetParts, { readonly kind: K }>) => R };

/** One answer per kind of target; every kind must be handled. */
export function onTarget<R>(target: TargetRef, cases: Cases<R>): R {
  const parts = targetParts(target);
  switch (parts.kind) {
    case "view":
      return cases.view(parts);
    case "note":
      return cases.note(parts);
    case "project":
      return cases.project(parts);
    default: {
      const never: never = parts;
      return never;
    }
  }
}

/** How an anchor on this target is worded: a note's ("Whole note"), else a diagram's; the project anchor reads the same in both. */
export function anchorScope(target: TargetRef): "view" | "note" {
  return onTarget<"view" | "note">(target, { view: () => "view", note: () => "note", project: () => "view" });
}
