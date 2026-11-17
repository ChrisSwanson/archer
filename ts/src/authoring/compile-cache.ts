/** Compile reuse and invalid-source diagnostics shared by the structured editors. */
import { compile, type CompileResult } from "../mermaid/index.ts";
import { isError } from "../mermaid/diagnostics.ts";

const LIMIT = 4;
const recent = new Map<string, Promise<CompileResult>>();

/**
 * `compile(source)` reusing the last few results by source text. One edit's verifying compile is the next edit's
 * starting compile, so a chain of gestures on a large diagram compiles once per step instead of twice. Callers
 * clone the model before changing it.
 */
export function compileCached(source: string): Promise<CompileResult> {
  const hit = recent.get(source);
  if (hit) {
    recent.delete(source);
    recent.set(source, hit);
    return hit;
  }
  const pending = compile(source);
  recent.set(source, pending);
  pending.catch(() => recent.delete(source));
  if (recent.size > LIMIT) recent.delete(recent.keys().next().value!);
  return pending;
}

/** The compiler's first error, so a refusal can say why the source is not editable. */
export interface EditDiagnostic {
  message: string;
  line: number;
  code: string;
}
export function firstDiagnostic(compiled: CompileResult): EditDiagnostic | undefined {
  const found = compiled.diagnostics.find(isError);
  return found === undefined ? undefined : { message: found.message, line: found.span.start.line, code: found.code };
}
/** A refusal result with the compiler's first error attached, when there is one. */
export function withDiagnostic<R extends object>(
  refusal: R,
  compiled: CompileResult,
): R & { diagnostic?: EditDiagnostic } {
  const diagnostic = firstDiagnostic(compiled);
  return diagnostic === undefined ? refusal : { ...refusal, diagnostic };
}
