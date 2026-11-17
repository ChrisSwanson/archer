/**
 * A grown canvas's layout for the page (ADR 0036 A12): in the page's layout worker, so placing and routing
 * never block the page; where there is no Worker (jsdom, Node) the same engine runs in process.
 */
import { backgroundTransport } from "../layout/elk-worker-transport";
import type { FrameBase, FramesAnswer } from "./frame-engine";
import type { Frame } from "./frame-view";
import { localFrameEngine } from "./frames-local";

export function layoutFrames(base: FrameBase, frames: readonly Frame[]): Promise<FramesAnswer> {
  if (typeof Worker === "undefined") return localFrameEngine().layout(base, frames);
  return backgroundTransport().frames.layout(base, frames);
}
