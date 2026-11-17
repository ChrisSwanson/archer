import { parseAuthoringTarget, type AuthoringTarget } from "../../../shared/authoring-contract.mts";
import { browserRoutePath } from "../app/browser-routes";
export interface EditorAddress {
  target: AuthoringTarget | null;
  draftId: string | null;
  checkpoint?: "document" | "draft";
}
export function editorAddress(search: string): EditorAddress {
  const q = new URLSearchParams(search);
  for (const name of ["viewId", "address", "draftId", "checkpoint"])
    if (q.getAll(name).length > 1) throw new Error("This editor address repeats a target.");
  if (q.has("viewId") && q.has("address")) throw new Error("Choose one diagram target.");
  const target = q.has("viewId")
    ? parseAuthoringTarget({ kind: "view", viewId: q.get("viewId") })
    : q.has("address")
      ? parseAuthoringTarget({ kind: "embedded", address: q.get("address") })
      : null;
  const draftId = q.get("draftId");
  if (draftId !== null && !/^drf_[a-f0-9]{32}$/.test(draftId)) throw new Error("The draft address is invalid.");
  const checkpoint = q.get("checkpoint");
  if (checkpoint !== null && checkpoint !== "document" && checkpoint !== "draft")
    throw new Error("The editor checkpoint is invalid.");
  if (checkpoint === "document" && !target) throw new Error("A canonical checkpoint requires a diagram target.");
  return { target, draftId, ...(checkpoint ? { checkpoint } : {}) };
}
export function editorHref(
  projectSlug: string,
  target: AuthoringTarget | null = null,
  draftId?: string,
  checkpoint?: "document" | "draft",
): string | null {
  const route = browserRoutePath({ kind: "edit", projectSlug });
  if (route === null) return null;
  const query = new URLSearchParams();
  if (target)
    query.set(target.kind === "view" ? "viewId" : "address", target.kind === "view" ? target.viewId : target.address);
  if (draftId) query.set("draftId", draftId);
  if (checkpoint) query.set("checkpoint", checkpoint);
  return route + (query.size ? `?${query}` : "");
}
