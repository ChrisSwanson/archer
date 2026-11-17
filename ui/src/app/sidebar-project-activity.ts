import type { RecentItem } from "./recents";
import type { PageAddress } from "./page-address";
import type { NavigationPlace } from "./WorkspaceNavigation";

/** The project the reader is actually in, independent of the serving project. */
export function activeProjectForNavigation(place: NavigationPlace, recents: readonly RecentItem[]): string | null {
  return place?.slug ?? recents[0]?.slug ?? null;
}

export function projectNavigationPlace(
  address: PageAddress | null,
  servedSlug: string,
  focusedSlug?: string | null,
): NavigationPlace {
  if (address?.kind === "view") return { slug: servedSlug, kind: "view", id: address.viewId };
  if (address?.kind === "note") return { slug: servedSlug, kind: "note", id: address.path };
  if (address?.kind === "folder") return { slug: servedSlug, kind: "project", id: "" };
  if (address?.kind === "overview" && focusedSlug != null) return { slug: focusedSlug, kind: "project", id: "" };
  return null;
}
