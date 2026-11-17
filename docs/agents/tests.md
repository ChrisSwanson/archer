# Tests must not stand in for the code

A passing suite is only evidence if each test exercises production code. These three failures all
shipped green and all cost real debugging time:

- **A test must never re-implement the logic it verifies.** `wave1_integration.rs` converted
  `FreeformGraph` to `ArchitectureGraph` inside the test body. That conversion was the missing
  production step, so the test proved a pipeline the product did not have and five of seven
  `DiagramKind` values were unreachable at runtime. If a test needs a transformation to pass, that
  transformation belongs in the product.
- **A fake must be held to the same contract as the real implementation.** `FileEventSource::recv`
  left the meaning of `None` unwritten. The fake meant "permanently exhausted", the `notify`-backed
  adapter meant "nothing right now", and the consumer believed the fake — so the watcher thread
  exited on its first poll and no file change was ever reported. Every seam with a fake needs one
  shared contract test run against both implementations, and a documented contract for the trait.
- **Assert on the outcome, not on `Ok`.** `compile(...).unwrap()` reads like a success assertion but
  `compile` returns `Ok` with diagnostics and no envelope when parsing fails. Assert the specific
  status or value the behavior claims.

Prefer table-driven tests that enumerate an entire enum over spot checks, so a new variant with no
implementation fails the suite instead of silently rotting.

- **A new trust boundary gets a never-panic property test**: arbitrary input, input built from the
  format's own vocabulary, and valid input with small edits, on a small stack against a clock, held
  to "refused, or valid" (`ts/test/mermaid/never-throws.test.ts` is the model).
- **A new recursion on untrusted input gets a bound**: the depth is refused by name, and a test
  compiles at exactly the limit.
- **Agent evals: tune on the main set only.** The visible tasks in `ts/scripts/evals/v1/tasks.mjs`
  are a development set by design. Never read, reconstruct or ask for the private hold-out
  (`~/.config/archer-evals/`, `$ARCHER_EVAL_HOLDOUT`), and never word guidance after an eval task:
  fix the general behaviour a miss shows.

A change is complete only after running the bundled `archer` (`node ts/dist/archer.js`, or the package
installed with `archer setup`) against a project corpus such as `ts/test/fixtures/pageturner` and
asserting the outcome. Every defect above survived a sign-off that skipped this.
