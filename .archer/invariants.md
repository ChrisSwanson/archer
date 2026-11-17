---
author: agent
description: What must never happen in Archer, each rule with the test or guard that holds it.
type: invariants
status: built
checked: 0.4.0 2026-10-22
refs: [ts/src/project/project.ts#writeConfined, ts/test/project/project.test.ts, ts/test/project/source-writer.test.ts, ts/test/application/authoring-source-guards.test.ts, ts/test/mermaid/edge-ids.test.ts, ts/test/mermaid/never-throws.test.ts, ts/test/mermaid/diagnostics.test.ts, ts/test/mermaid/model-schema.test.ts, ts/test/service/access-http.test.ts, ts/test/application/docs-cap.test.ts, ts/test/docs/pack.test.ts, AGENTS.md]
---
# Invariants

A rule that matters has a test; the list points at it. Rules without a test say so.

| Never | Guard |
|---|---|
| A diagram, note or comment is written outside the Archer folder, or through a link that leads out | `ts/src/project/project.ts#writeConfined`; `ts/test/project/project.test.ts`, `ts/test/project/source-writer.test.ts` |
| An Archer write replaces a change it did not read | `expectedRevision`, rechecked under the writers' lock; `ts/test/application/authoring-source-guards.test.ts`. An outside editor can still race the last check |
| A flowchart edge without an explicit id compiles | `ts/test/mermaid/edge-ids.test.ts` |
| Any input crashes the compiler | `ts/test/mermaid/never-throws.test.ts` (refused, or schema-valid) |
| An unsupported family compiles | `ts/test/mermaid/diagnostics.test.ts` (`classDiagram` is refused); other unsupported forms: per-family tests |
| Diagram kinds, model types or the stable-id grammar drift from the wire schema | `ts/test/mermaid/model-schema.test.ts` |
| A browser write is accepted from another origin | `ts/test/service/access-http.test.ts` |
| A docs-mode write crosses its file's cap, or a doc is cut to fit | `doc_over_cap`; `ts/test/application/docs-cap.test.ts` |
| A dead code reference or a stale router passes the pack check | `archer docs index --check`; `ts/test/docs/pack.test.ts` |
| The person's selection changes the Mermaid source | No dedicated test: a frozen boundary in `AGENTS.md` |
| Coordinates, viewport or selection enter the semantic model | No dedicated test: a frozen boundary in `AGENTS.md` |
| An agent writes `confirmed` without the person's explicit yes | Guidance only (`references/docs-mode.md`); no check yet |
