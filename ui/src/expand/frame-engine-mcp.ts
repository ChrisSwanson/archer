/**
 * The MCP App's stand-in for the frame engine (`frame-engine.ts`): the MCP App has no Expand menu, so its
 * inline layout worker carries no source-frame placement (grow in place for frames, the seeded fallback).
 * A frames request there is refused, which the page would read as "draw the base view".
 */
import type { FrameBase, FrameEngineDependencies, FramesAnswer } from "./frame-engine";
import type { Frame } from "./frame-view";

export type { FrameBase, FrameEngineDependencies, FramesAnswer, FrameHow, FrameStep } from "./frame-engine";

export class FrameEngine {
  constructor(_dependencies: FrameEngineDependencies) {}
  layout(_base: FrameBase, _frames: readonly Frame[]): Promise<FramesAnswer> {
    return Promise.reject(new Error("the MCP App does not place source frames"));
  }
}
