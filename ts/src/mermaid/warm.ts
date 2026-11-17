// Loads Mermaid and each family's parser once, before the service takes requests.
//
// The first compile of a family evaluates Mermaid's modules (and that family's
// chunk) synchronously: ~0.8 s for the first flowchart, ~0.2 s for the first
// architecture diagram, on an unloaded host. Paid on the request path, that held
// the event loop for every request issued meanwhile (svc.event-loop-lag ~2 s
// right after start). Paid here, the service is not yet listening.
import { compile, type CompileOptions, type CompileResult } from "./compile.ts";

/** One small, valid source per supported family. */
export const WARM_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  flowchart: "flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n",
  sequence: "sequenceDiagram\n  participant a as A\n  participant b as B\n  a->>b: hi\n",
  c4: 'C4Context\n  Person(a, "A")\n',
  state: "stateDiagram-v2\n  state A\n  [*] --> A\n",
  er: "erDiagram\n  A {\n    string id\n  }\n",
  architecture: "architecture-beta\n  service a(server)[A]\n",
  journey: "journey\n  title T\n  section S\n    Do: 5: Me\n",
});

/**
 * Compiles each warm source once with `compileWith` (the installed backend by default); never throws.
 * Resolves with how long it took, in milliseconds.
 */
export async function warmCompilers(
  compileWith: (source: string, options?: CompileOptions) => Promise<CompileResult> = compile,
): Promise<number> {
  const started = performance.now();
  for (const source of Object.values(WARM_SOURCES)) {
    try {
      await compileWith(source);
    } catch {
      /* a family that cannot load fails its own requests, as before */
    }
  }
  return performance.now() - started;
}
