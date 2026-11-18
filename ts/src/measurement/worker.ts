import { parentPort } from "node:worker_threads";
import { loadAnalysis } from "./load.ts";
import type { CompilationInput } from "./pool.ts";
import type { AnalysisState } from "../../../shared/layout-analysis.mts";
const port = parentPort;
if (port === null) throw new Error("layout-worker runs in a worker thread");
// Load the compiler and the layout engine up front and say so: the pool starts a job's layout budget
// only then. A failed load still reports ready, so the job meets the failure itself and says why.
void Promise.all([loadAnalysis(), import("../application/diagrams.ts"), import("../project/envelope.ts")]).then(
  () => port.postMessage({ ready: true }),
  () => port.postMessage({ ready: true }),
);
port.on(
  "message",
  (job: {
    id: number;
    envelope: unknown;
    states?: readonly AnalysisState[];
    typeface?: "fira";
    compilation?: CompilationInput;
  }) => {
    void (async () => {
      let envelope = job.envelope;
      if (job.compilation) {
        const { source, view, embedded } = job.compilation;
        let compiled: import("./pool.ts").CompiledInput;
        if (embedded) {
          const { compileEmbedded } = await import("../notes/embedded.ts");
          compiled = await compileEmbedded(embedded, source);
        } else {
          const { compileText } = await import("../application/diagrams.ts");
          const { revisionOf } = await import("../project/envelope.ts");
          const checked = await compileText(view, source);
          compiled = {
            envelope:
              checked.model === undefined
                ? null
                : {
                    schemaVersion: 2,
                    view: { id: view.id, kind: view.kind, title: view.title },
                    revision: revisionOf(Buffer.from(source)),
                    model: checked.model,
                  },
            diagnostics: checked.diagnostics,
          };
        }
        port.postMessage({ id: job.id, compiled });
        envelope = compiled.envelope;
        if (!envelope) {
          port.postMessage({ id: job.id, unavailable: "does_not_compile" });
          return;
        }
      }
      const analysis = await loadAnalysis();
      const states = analysis.analysisStates(envelope, job.states);
      port.postMessage({ id: job.id, requested: states });
      for (const [stateIndex, state] of states.entries()) {
        const geometry = await analysis.computeDiagramGeometry(envelope, {
          states: [state],
          typeface: job.typeface ?? "fira",
          includeGroups: true,
        });
        port.postMessage({
          id: job.id,
          geometry: { ...geometry, states: geometry.states.map((s) => ({ ...s, stateIndex })) },
        });
      }
      port.postMessage({ id: job.id, done: true });
    })().catch((failure: unknown) => {
      const error = failure as { code?: string; message?: string };
      port.postMessage({ id: job.id, error: error.message ?? String(failure), code: error.code });
    });
  },
);
