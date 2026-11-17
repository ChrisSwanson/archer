/**
 * The project the page belongs to, read from the page's own address.
 *
 * The TypeScript service serves each attached project at `/projects/<name>/`,
 * where the name is the project folder's name, lowercased with every run of
 * other characters made a hyphen, suffixed `-2`, `-3` when two roots share it
 * (`ts/src/state/project-names.ts`). Nothing else the page receives names the
 * project: the inventory, the bootstrap and the events carry no project field,
 * so the name in the address is the one fact on hand. It is the folder's name
 * as the address spells it ("web-shop" for "Web Shop"), not a title, which is
 * why the bar shows it in the voice of a path. It is shown whole: a name that
 * happens to end in `-<8 hex digits>` is still the name.
 *
 * Any other address -- an embedded view -- names no project, and the bar then
 * shows none.
 */
import { readBrowserRoute } from "./browser-routes";

export function projectNameFromPath(pathname: string): string | undefined {
  const route = readBrowserRoute(pathname);
  return route === null || route.kind === "projects" ? undefined : route.projectSlug;
}
