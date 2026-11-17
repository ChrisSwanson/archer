/**
 * ELK's official worker dispatcher as an in-thread kernel. Shared by the page's nested
 * engine and source-layout analysis inside a browser worker; neither starts a second worker.
 */
import ELK from "elkjs/lib/elk-api.js";
import { cachedKernel } from "./elk-kernel-cache";
type Message = { readonly data: unknown };
export type WorkerScope = {
  onmessage: ((event: Message) => void) | null;
  postMessage(message: unknown, ...rest: never[]): void;
};
export function inThreadKernel(scope: WorkerScope) {
  const elk = scope.onmessage;
  if (elk === null) throw new Error("ELK's worker entry must be loaded before its in-thread adapter.");
  const post = scope.postMessage.bind(scope) as (message: unknown) => void;
  let local: ((message: unknown) => void) | undefined;
  scope.postMessage = ((message: unknown, ...rest: never[]) =>
    local !== undefined
      ? local(message)
      : (post as (m: unknown, ...r: never[]) => void)(message, ...rest)) as WorkerScope["postMessage"];
  const inThread = {
    onmessage: null as ((event: Message) => void) | null,
    postMessage(message: unknown): void {
      const outer = local;
      local = (reply) => inThread.onmessage?.({ data: reply });
      try {
        elk.call(scope, { data: message });
      } finally {
        local = outer;
      }
    },
    terminate(): void {},
  };
  return {
    kernel: cachedKernel(new ELK({ workerFactory: () => inThread as unknown as Worker })),
    post,
    dispatch: (event: Message) => elk.call(scope, event),
  };
}
