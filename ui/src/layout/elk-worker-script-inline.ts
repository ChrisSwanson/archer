// The MCP App's layout worker, inline in its one file (ADR 0003); replaces `elk-worker-script.ts`
// in `vite build --mode mcp` (`pageBuildAliases`).
import InlineLayoutWorker from "./elk-layout-worker?worker&inline";

export function createLayoutWorker(): Worker {
  return new InlineLayoutWorker();
}
