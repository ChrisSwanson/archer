// A cold start on a loaded machine: loading the worker's modules takes longer than the layout budget.
await new Promise((resolve) => setTimeout(resolve, 1_500));
await import("../../../src/measurement/worker.ts");
export {};
