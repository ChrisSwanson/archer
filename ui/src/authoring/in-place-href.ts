/**
 * The `?edit` address of an in-place session: the reading page's own path, plus its draft.
 * Its own module so the reading page can link to the editor without evaluating it (perf #3).
 */
export function inPlaceHref(draftId: string | null, checkpoint?: "document" | "draft"): string {
  const query = new URLSearchParams(location.search);
  // A walkthrough is Explore's (it is left on entering edit): the edit address carries none.
  for (const name of ["edit", "draftId", "checkpoint", "walkthrough", "step"]) query.delete(name);
  if (draftId) query.set("draftId", draftId);
  if (checkpoint) query.set("checkpoint", checkpoint);
  // Flags (`source`) stay bare: `?edit&source`, not `source=`.
  const rest = query.toString().replace(/(^|&)([a-z]+)=(?=&|$)/gu, "$1$2");
  return `${location.pathname}?edit${rest ? `&${rest}` : ""}${location.hash}`;
}

/**
 * Where keyboard focus goes when the editor opens (Edit, New → Diagram): the editor's drawing, a group named
 * "Drawing" inside region "Diagram editor". Here, not in the editor's module, so the page can focus it without
 * loading the editor.
 */
export const EDITOR_ENTRY_SELECTOR = "[data-archer-editor-entry]";
