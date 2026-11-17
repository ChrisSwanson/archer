/** The page build's stand-in for `frames-local.ts`: the page places frames in its layout worker only. */
import type { FrameEngine } from "./frame-engine";

export function localFrameEngine(): FrameEngine {
  throw new Error("Expand needs a browser with Web Workers.");
}
