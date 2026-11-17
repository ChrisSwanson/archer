// The page build's stand-in for `elkjs/lib/elk.bundled.js` (`ui/vite.config.ts`, `resolve.alias`).
//
// The page already ships ELK once, as its layout worker. `elk-adapter.ts` keeps
// `elk.bundled` for Node (export, thumbnails) and for tests; in the page every
// `new ELK()` from that path -- the export painter that draws note figures --
// lays out through the worker instead, so the kernel is not bundled twice.
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { backgroundTransport, MAX_PENDING_LAYOUTS } from "./elk-worker-transport";

/**
 * At most this many graphs from here wait on the worker at once; the rest
 * queue. A note may hold up to 256 figures, and the transport refuses past
 * `MAX_PENDING_LAYOUTS`, which the open canvas shares.
 */
export const PAGE_KERNEL_CONCURRENCY = Math.max(1, Math.floor(MAX_PENDING_LAYOUTS / 4));

let running = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<void> {
  if (running < PAGE_KERNEL_CONCURRENCY) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next !== undefined) next();
  else running--;
}

/** ELK's `layout(graph)`, answered by the page's layout worker. */
export default class PageElk {
  async layout(graph: ElkNode): Promise<ElkNode> {
    await slot();
    try {
      return await backgroundTransport().layoutGraph(graph);
    } finally {
      release();
    }
  }
}
