// ELK's worker entry: in a worker it installs its dispatcher on `self`; in Node it exports the
// FakeWorker class elk.bundled uses. `nest-protocol.test.ts` builds a worker scope from it.
declare module "elkjs/lib/elk-worker.min.js" {
  const elkWorker: unknown;
  export default elkWorker;
}
