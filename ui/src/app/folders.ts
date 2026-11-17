/**
 * The Archer folder as folders, for the breadcrumb.
 *
 * A diagram's `sourcePath` and a note's `path` are relative to the Archer
 * folder (`.archer/` by default). The folder's root is the project itself, so
 * it has no segment of its own: an item at the root has an empty trail, never
 * a made-up "Files" folder. Pure, so the trail is tested without rendering.
 */

/** One folder segment of the breadcrumb: its name and its folder-relative path. */
export type FolderCrumb = { readonly name: string; readonly path: string };

const segments = (path: string): string[] => path.split("/").filter((segment) => segment !== "" && segment !== ".");

/**
 * The folder an item is in, `/`-separated, "" for the root. A view with no
 * source path is at the root.
 */
export function folderOf(path: string | undefined): string {
  return path === undefined ? "" : segments(path).slice(0, -1).join("/");
}

/** Every folder from the root down to `folder`, each with its own path. */
export function folderTrail(folder: string): FolderCrumb[] {
  const names = segments(folder);
  return names.map((name, index) => ({ name, path: names.slice(0, index + 1).join("/") }));
}
