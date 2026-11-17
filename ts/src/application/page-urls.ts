// The links the agent gives the person, built from the project page URL the service reports
// (`<origin>/projects/<name>/?follow&token=…`, ADR 0017). Each names its own page (decided 2026-11-02; user-flows
// round 1, claude-08): the presented diagram, or the project. The `?follow` address, which turns with whatever the
// agent presents next, is returned beside them as `followUrl`, for when the person asks to follow.
import { browserRoutePath } from "../../../shared/browser-routes.mts";
import type { ViewEntry } from "./diagrams.ts";

/** The project name and token of an agent-facing project page URL (`<origin>/projects/<name>/?follow&token=…`). */
function pageParts(pageUrl: string): { url: URL; slug: string; token: string | null } | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  const slug = /^\/projects\/([^/]+)\/$/.exec(url.pathname)?.[1];
  return slug === undefined ? undefined : { url, slug, token: url.searchParams.get("token") };
}

/** A clean path (perhaps with its own query, `?follow&view=…`, or `#<name>`) with the token, then `query`, before its fragment. */
function withQuery(origin: string, path: string, token: string | null, query: readonly string[]): string {
  const hash = path.indexOf("#");
  const [address, fragment] = hash < 0 ? [path, ""] : [path.slice(0, hash), path.slice(hash)];
  const mark = address.indexOf("?");
  const [bare, own] = mark < 0 ? [address, []] : [address.slice(0, mark), address.slice(mark + 1).split("&")];
  const parts = [...own, ...(token === null ? [] : [`token=${encodeURIComponent(token)}`]), ...query];
  return `${origin}${bare}${parts.length === 0 ? "" : `?${parts.join("&")}`}${fragment}`;
}

/**
 * A presented view's stable address, from the project page URL: its file (`/projects/<name>/<path>`), or for a
 * diagram in a note the note's address and `#<name>` (ADR 0017), keeping the token, then `query`. A file the clean
 * grammar cannot spell is named on the follow page by `?view=<id>`, which the page opens.
 */
export function viewPageUrl(
  pageUrl: string,
  view: Pick<ViewEntry, "id" | "registration" | "source">,
  query: readonly string[] = [],
): string | undefined {
  const parts = pageParts(pageUrl);
  if (parts === undefined) return undefined;
  const route = { kind: "view", projectSlug: parts.slug, viewId: view.id } as const;
  const path =
    (view.registration === "embedded"
      ? null
      : browserRoutePath({ ...route, sourcePath: view.source.replace(/^\.\//, "") })) ?? browserRoutePath(route);
  return path === null ? undefined : withQuery(parts.url.origin, path, parts.token, query);
}

/** The project's own page (`/projects/<name>/`, the project browser) with the token, not its `?follow` address. */
export function projectPageUrl(pageUrl: string): string | undefined {
  const parts = pageParts(pageUrl);
  return parts === undefined ? undefined : withQuery(parts.url.origin, `/projects/${parts.slug}/`, parts.token, []);
}
