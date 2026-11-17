/**
 * The key of a nested view's session: its revision, content and text-measure settings. Apart from
 * `nest-engine.ts` so the page's side of the channel (`nest-protocol.ts`) names sessions without
 * carrying the engine, which runs in the layout worker.
 */
import type { ProjectedView } from "../diagrams/projection";
import { layoutKey } from "../layout/layout-key";
import type { TypefaceId } from "../layout/text-measure";

/** The diagram one nested view shows: the full view, the face its text is measured in, and its revision. */
export type NestSessionSpec = {
  readonly full: ProjectedView;
  readonly typeface: TypefaceId;
  readonly revision: string;
};

/** The session a spec names: its revision, content and text-measure settings. */
export function nestSessionKey(spec: NestSessionSpec): string {
  return `${spec.revision}\0${layoutKey(spec.full, spec.typeface)}`;
}
