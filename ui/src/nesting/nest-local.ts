/**
 * The nested view's engine in this realm, for where there is no Worker (jsdom, Node): the same
 * engine the layout worker runs, with `elk.bundled`. The page build swaps this module for
 * `nest-local-page.ts` (`ui/vite.config.ts`, `pageBuildAliases`): a browser always has a Worker,
 * so the page does not ship a second copy of the engine beside the worker's.
 */
import { NestEngine } from "./nest-engine";

let local: NestEngine | undefined;

/** The in-process engine, made on first use. */
export function localNestEngine(): NestEngine {
  if (local !== undefined) return local;
  let elk:
    | Promise<{ layout(graph: import("elkjs/lib/elk-api").ElkNode): Promise<import("elkjs/lib/elk-api").ElkNode> }>
    | undefined;
  local = new NestEngine({
    kernel: {
      async layout(graph) {
        elk ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
        return (await elk).layout(graph);
      },
    },
  });
  return local;
}

/** The in-process engine if one was made; never makes one. */
export function currentLocalNestEngine(): NestEngine | undefined {
  return local;
}

/** Tests only: forget the in-process engine. */
export function resetLocalNestEngine(): void {
  local = undefined;
}
