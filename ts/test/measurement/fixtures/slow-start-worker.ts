// Add startup latency, then run the actual compiler/layout worker unchanged.
await new Promise((resolve) => setTimeout(resolve, 300));
await import("../../../src/measurement/worker.ts");
export {};
