import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
test("accuracy trust boundaries refuse or validate arbitrary, vocabulary and mutated-valid input on a small stack against a clock", async () => {
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./property-worker.mjs", import.meta.url), {
      resourceLimits: { stackSizeMb: 1 },
      execArgv: [],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("accuracy property clock exceeded"));
    }, 15000);
    worker.once("message", (value) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`accuracy property worker exited ${code}`));
    });
  });
  expect(result).toEqual({ cases: 4500, corpora: 3 });
}, 20000);
