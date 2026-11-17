// The official ELK worker entry owns its kernel protocol. Archer's projection,
// metrics and caption passes stay in the shared pure layout core. The nested
// view's engine (`nesting/nest-worker.ts`) shares the thread: it takes the
// messages tagged `nest` and hands ELK's own to ELK's handler unchanged.
import "elkjs/lib/elk-worker.min.js";
import { installNestWorker, type WorkerScope } from "../nesting/nest-worker";

installNestWorker(self as unknown as WorkerScope);
