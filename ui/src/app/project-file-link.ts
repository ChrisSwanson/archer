import { browserFetch } from "./browser-resource";
import { browserRoutePath, documentRoute, projectResourceBase } from "./browser-routes";
import { parseSourceDocuments } from "./source-documents";

/**
 * Where a note's link to another file of its project opens (`../../NOTICE.md` beside the README): that file's own
 * page, which shows it or says it is not available. A note's path is inside the Archer folder; the project's
 * document catalog says where the note is in the project, so the link resolves as written in any folder layout.
 * Null when the catalog cannot say.
 */
export async function projectFileAddress(
  slug: string,
  notePath: string,
  href: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const base = projectResourceBase(window.location.href, slug);
  if (base === null) return null;
  let catalog: unknown;
  try {
    const response = await browserFetch(new URL("api/documents", base).href, signal ? { signal } : undefined);
    if (!response.ok) return null;
    catalog = await response.json();
  } catch {
    return null;
  }
  const documents =
    catalog !== null && typeof catalog === "object"
      ? parseSourceDocuments((catalog as { documents?: unknown }).documents)
      : null;
  const own = documents?.find((document) => document.legacy?.notePath === notePath)?.source.path;
  if (own === undefined) return null;
  let target: string;
  try {
    const at = `https://archer.invalid/${own.split("/").map(encodeURIComponent).join("/")}`;
    target = decodeURIComponent(new URL(href, at).pathname.slice(1));
  } catch {
    return null;
  }
  const listed = documents?.find((document) => document.source.path === target);
  return listed === undefined ? null : browserRoutePath(documentRoute(slug, target, false));
}
