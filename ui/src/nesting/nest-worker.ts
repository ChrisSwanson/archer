/**
 * The nested view's engine inside the page's layout worker (`elk-layout-worker.ts`). ELK's worker
 * entry has set the scope's `onmessage` to its dispatcher, which answers by calling the scope's
 * `postMessage` synchronously. This keeps that handler for ELK's messages, sends `nest` messages
 * to a `NestEngine`, and gives the engine ELK in the same thread: an `elk-api` ELK whose worker
 * dispatches locally into ELK's handler, its synchronous reply caught on the way out.
 */
import { inThreadKernel, type WorkerScope } from "../layout/elk-in-thread";
export type { WorkerScope } from "../layout/elk-in-thread";
import { NestEngine } from "./nest-engine";
import { isNestMessage, serveNest, type NestRequest } from "./nest-protocol";
import { FrameEngine } from "../expand/frame-engine";
import { isFramesMessage, serveFrames, type FramesRequest } from "../expand/frames-protocol";

export function installNestWorker(scope: WorkerScope): NestEngine {
  const { kernel, post, dispatch } = inThreadKernel(scope);
  const engine = new NestEngine({ kernel });
  const serve = serveNest(engine, post);
  // Source frames (Expand, ADR 0036 A12) share the kernel; their engine is made on the first request.
  let frames: ((request: FramesRequest) => void) | undefined;
  scope.onmessage = (event) => {
    if (isNestMessage(event.data)) serve(event.data.nest as NestRequest);
    else if (isFramesMessage(event.data))
      (frames ??= serveFrames(new FrameEngine({ kernel }), post))(event.data.frames as FramesRequest);
    else dispatch(event);
  };
  return engine;
}
