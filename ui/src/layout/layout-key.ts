// What a layout depends on, in a module of its own: the nested view's engine keys its sessions by
// it in the worker and in Node, where `elk-worker-transport.ts` (Worker, window) is not loaded.
import type { ProjectedView } from "../diagrams/projection";
import type { TypefaceId } from "./text-measure";

/**
 * What a layout depends on. A view's id, revision and title name it and do not
 * move a box, so the reading page's layout serves the editor's preview of the
 * same model (`authoring-preview`; perf #7: entering `?edit` laid it out twice).
 */
export function layoutKey(view: ProjectedView, typeface: TypefaceId): string {
  const { viewId: _viewId, revision: _revision, title: _title, ...drawn } = view;
  return `${typeface}\0${JSON.stringify(drawn)}`;
}
