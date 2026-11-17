/**
 * The folder page's address: `?folder=<path in the Archer folder>`, beside
 * `?view=`, `?note=` and `?overview=1` (`project-directory.ts`). A reload or a
 * shared link opens the same folder; back and forward walk the folders the
 * reader walked (`App.tsx`). It is written by `page-address.ts`.
 *
 * The page only lists what the inventory holds, so a path here never reaches
 * the disk. Still, a path that would leave the Archer folder -- a `..`
 * segment, an absolute or drive path, a backslash -- is not taken for a
 * folder: it reads as a folder that is not there (`{ path: null }`).
 */
export const FOLDER_PARAM = "folder";

/** No folder asked for (null), a folder, or one that names no folder (`path: null`). */
export type FolderLink = { readonly path: string | null } | null;

/** The folder-relative path `raw` names, `/`-separated, or null when it leaves the Archer folder. */
export function folderPath(raw: string): string | null {
  if (raw.startsWith("/") || /[\\\0]/.test(raw) || /^[a-z]:/i.test(raw)) return null;
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? null : segments.join("/");
}

export function readFolderLink(search: string): FolderLink {
  const raw = new URLSearchParams(search).get(FOLDER_PARAM);
  return raw === null ? null : { path: folderPath(raw) };
}
