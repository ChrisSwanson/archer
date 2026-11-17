/**
 * The frame engine in this realm, for where there is no Worker (jsdom, Node), with `elk.bundled`. The page
 * build swaps this module for `frames-local-page.ts` (`ui/vite.config.ts`, `pageBuildAliases`): a browser
 * always has a Worker, so the page does not ship a second copy of the engine beside the worker's.
 */
import { FrameEngine } from "./frame-engine";

let local: FrameEngine | undefined;

export function localFrameEngine(): FrameEngine {
  if (local !== undefined) return local;
  let elk:
    | Promise<{ layout(graph: import("elkjs/lib/elk-api").ElkNode): Promise<import("elkjs/lib/elk-api").ElkNode> }>
    | undefined;
  local = new FrameEngine({
    kernel: {
      async layout(graph) {
        elk ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
        return (await elk).layout(graph);
      },
    },
  });
  return local;
}
