/**
 * The page build's stand-in for `nest-local.ts` (`ui/vite.config.ts`, `pageBuildAliases`). The page
 * lays the nested view out in its layout worker, which carries the engine; there is no in-process
 * copy to fall back on.
 */
import type { NestEngine } from "./nest-engine";

export function localNestEngine(): NestEngine {
  throw new Error("The nested view needs a browser with Web Workers.");
}

export function currentLocalNestEngine(): NestEngine | undefined {
  return undefined;
}

export function resetLocalNestEngine(): void {}
