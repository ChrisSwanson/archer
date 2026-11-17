/**
 * The nested view's fallback layout (ADR 0029, "option 1"): the whole view laid out again by ELK,
 * seeded from the boxes of the layout it is reached from, so ELK keeps most of their order. Used
 * only when grow in place refuses, throws or runs out of time (`nest-engine.ts`); the lab's
 * strategy comparison (`tests/support/nest-strategies.ts`) drives the same code.
 */
import type { ElkNode } from "elkjs/lib/elk-api";
import type { ProjectedView } from "../diagrams/projection";
import type { LayoutEngine, LayoutResult } from "../layout/elk-layout";

export type Box = { x: number; y: number; width: number; height: number };

/** Every drawn box by drawn id: nodes, and open frames under the id the nested view gives them. */
export function boxes(layout: LayoutResult, view: ProjectedView): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const node of layout.nodes) out.set(node.id, node);
  for (const group of layout.groups) {
    const element = view.groups.find((g) => g.id === group.id)?.element === true;
    out.set(element ? group.id : `group:${group.id}`, group);
  }
  return out;
}

/**
 * How ELK is seeded: `semi` (semi-interactive crossing minimisation), `semi-free` (the same with
 * model order off: the fallback), `interactive` (every phase interactive), `plain` (not seeded).
 */
export type SeedStrategy = "plain" | "semi" | "semi-free" | "interactive";

const GROUP_PREFIX = "__archer_group__";

/**
 * `kernel` with every ELK node starting where its drawn box was in `prior`, given both as `x/y`
 * (read by the INTERACTIVE strategies) and as `elk.position` (the only input semi-interactive
 * crossing minimisation reads). Children of the container just opened have no old box: they start
 * inside the container's old rect, spread evenly along the in-layer axis in model order.
 */
export function seededEngine(
  strategy: SeedStrategy,
  prior: ReadonlyMap<string, Box> | undefined,
  view: ProjectedView,
  kernel: LayoutEngine,
): LayoutEngine {
  if (strategy === "plain" || prior === undefined) return kernel;
  const options: Record<string, string> =
    strategy === "semi"
      ? { "elk.layered.crossingMinimization.semiInteractive": "true" }
      : strategy === "semi-free"
        ? {
            "elk.layered.crossingMinimization.semiInteractive": "true",
            "elk.layered.considerModelOrder.strategy": "NONE",
          }
        : {
            "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
            "elk.layered.layering.strategy": "INTERACTIVE",
            "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
          };
  const sideways = view.direction === "lr" || view.direction === "rl";
  const drawnIdOf = (elkId: string): string => {
    if (!elkId.startsWith(GROUP_PREFIX)) return elkId;
    const id = elkId.slice(GROUP_PREFIX.length);
    return view.groups.find((g) => g.id === id)?.element === true ? id : `group:${id}`;
  };
  const seed = (node: ElkNode, parent: Box): void => {
    node.layoutOptions = { ...node.layoutOptions, ...options };
    const children = node.children ?? [];
    const fresh = children.filter((child) => !prior.has(drawnIdOf(child.id)));
    const placed = new Map<ElkNode, Box>();
    for (const child of children) {
      const was = prior.get(drawnIdOf(child.id));
      let box: Box;
      if (was !== undefined) box = was;
      else {
        const share = (fresh.indexOf(child) + 0.5) / fresh.length;
        box = sideways
          ? { x: parent.x + parent.width / 2, y: parent.y + share * parent.height, width: 0, height: 0 }
          : { x: parent.x + share * parent.width, y: parent.y + parent.height / 2, width: 0, height: 0 };
      }
      child.x = box.x - parent.x;
      child.y = box.y - parent.y;
      child.layoutOptions = { ...child.layoutOptions, "elk.position": `(${child.x},${child.y})` };
      placed.set(child, box);
    }
    for (const child of children) seed(child, placed.get(child)!);
  };
  return { layout: (graph: ElkNode) => (seed(graph, { x: 0, y: 0, width: 0, height: 0 }), kernel.layout(graph)) };
}
