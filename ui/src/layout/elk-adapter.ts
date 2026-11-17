// Compatibility surface for direct Node/core callers. Browser callers choose
// the worker boundary; the pure core never imports a second ELK kernel.
import type { ProjectedView } from "../diagrams/projection";
import { DEFAULT_TYPEFACE, type TypefaceId } from "./text-measure";
import { computeLayout as computeCoreLayout, type LayoutEngine, type LayoutResult } from "./elk-layout";

export { NODE_HEIGHT, NODE_WIDTH, LAYER_GAP } from "./elk-layout";
export type {
  LayoutNode,
  LayoutNote,
  LayoutPoint,
  LayoutEdge,
  LayoutGroup,
  LayoutResult,
  LayoutEngine,
} from "./elk-layout";

export async function computeLayout(
  view: ProjectedView,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
  engine?: LayoutEngine,
): Promise<LayoutResult> {
  if (engine !== undefined) return computeCoreLayout(view, typeface, engine);
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  return computeCoreLayout(view, typeface, new ELK());
}
