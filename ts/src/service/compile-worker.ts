// A compiler off the service's event loop (`CompilePool` in compile-pool.ts starts it). One
// message is one compile: `{ id, source, options }` in, `{ id, result }` or `{ id, error }` out.
// It loads Mermaid's parsers, then posts `{ ready: true }`, so the owner can tell a worker that
// cannot start from a compile that failed.
import { parentPort } from "node:worker_threads";
import { compileInThisThread, type CompileOptions } from "../mermaid/compile.ts";
import { warmCompilers } from "../mermaid/warm.ts";

interface Job {
  readonly id: number;
  readonly source: string;
  readonly options: CompileOptions;
}

const port = parentPort;
if (port === null) throw new Error("compile-worker runs as a worker thread");

port.on("message", (job: Job) => {
  void compileInThisThread(job.source, job.options).then(
    (result) => port.postMessage({ id: job.id, result }),
    (failure: unknown) =>
      port.postMessage({ id: job.id, error: failure instanceof Error ? failure.message : String(failure) }),
  );
});
await warmCompilers();
port.postMessage({ ready: true });
