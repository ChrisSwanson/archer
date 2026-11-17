/** Types for `repeat-suite.mjs`, so its pure parts can be tested from TypeScript. */
export type RunResult = { readonly passed: boolean; readonly seconds: number; readonly failed: readonly string[] };
export function failedTests(log: string): string[];
export function boundAfterCleanRuns(runs: number): number;
export function summarise(results: readonly RunResult[], load: number): string[];
