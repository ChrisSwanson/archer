# Archer agent instructions

These instructions apply to the entire repository.

The product is the TypeScript implementation: `ts/` (compile, MCP server, CLI, service, export,
plugin) and the page in `ui/`. An earlier Rust implementation (release 0.3.0) preceded it. Where the
examples in `docs/agents/` cite Rust files (`crates/...`), they are history: the lesson
holds, the file is not in this repository.

## Writing style

Write concise speech and notes: relevant decisions, important facts and short bullets, with no
padded prose. Use headings and existing passage highlights to point to the relevant topic.
Keep detailed engineering evidence in supporting references when needed rather than expanding the
person-facing explanation. Do not claim that emphasis scrolls the page; heading navigation currently
belongs to the note's table of contents.

## Start here

Before changing code:

1. Find the work: the GitHub issue you are working on (or open one for a change nobody has asked
   for yet), and the newest entry of [`CHANGELOG.md`](CHANGELOG.md) for what shipped last. Status,
   plans and open questions live in issues, not in files.
2. Read the contracts that bind the area: [frozen boundaries](docs/agents/frozen-boundaries.md),
   and for Mermaid [`ts/docs/supported-mermaid.md`](ts/docs/supported-mermaid.md) (accepted and
   rejected syntax; `docs/supported-mermaid.md` is the older Rust 0.3 profile).
3. Read the Archer folder's diagrams and notes for the part you change (below).
4. Check [`docs/known-failures.md`](docs/known-failures.md) for open failures in what you will run.

Confirm the Git branch and current commit before editing; do not redo work that is already on `main`.

## Non-negotiables

Each links to the file that states the rule in full.

- Every behavioural change is red-green-refactor, and the red is the intended failure
  ([working method](docs/agents/working-method.md)).
- A test exercises production code; it never re-implements what it verifies ([tests](docs/agents/tests.md)).
- Contracts are frozen: schemas, stable IDs, supported Mermaid, recorded decisions
  ([frozen boundaries](docs/agents/frozen-boundaries.md)).
- No `git stash`, and no `git worktree remove --force` ([working method](docs/agents/working-method.md)).
- Work is complete only when the aggregate gates pass ([quality gates](docs/agents/quality-gates.md)); UI or
  service work also passes `release-check` ([UI testing](docs/agents/ui-testing.md)).
- UI work follows the behaviour contract in [`UI_UX.md`](UI_UX.md) and the visual system in
  [`DESIGN.md`](DESIGN.md).
- A red CI job is diagnosed from its log, never its status line; every failure, the change's own or
  not, is root-caused and recorded in [`docs/known-failures.md`](docs/known-failures.md).

## Read this when…

| When you are… | Read |
|---|---|
| changing any code | [`docs/agents/working-method.md`](docs/agents/working-method.md) |
| writing or changing tests, fakes or evals | [`docs/agents/tests.md`](docs/agents/tests.md) |
| touching schemas, Mermaid support, models or MCP text | [`docs/agents/frozen-boundaries.md`](docs/agents/frozen-boundaries.md) |
| finishing a change or preparing a PR | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/agents/quality-gates.md`](docs/agents/quality-gates.md), the [`archer-pr-flow`](.agents/skills/archer-pr-flow/SKILL.md) skill |
| changing anything the page shows or how it behaves | [`UI_UX.md`](UI_UX.md), [`DESIGN.md`](DESIGN.md), [`PRODUCT.md`](PRODUCT.md) |
| handing back UI or service work; writing browser tests | [`docs/agents/ui-testing.md`](docs/agents/ui-testing.md), the `archer-ui-verification` skill |
| looking for known UI/UX deficiencies | GitHub issues |
| doing visual work with hot reload | [`docs/agents/ui-dev-server.md`](docs/agents/ui-dev-server.md) |
| facing a red CI job or a failing test | [`docs/known-failures.md`](docs/known-failures.md) |
| answering an architecture question | the Archer folder (below) |

<!-- archer:begin -->
## Archer

This project's diagrams (Mermaid `.mmd`) and notes (Markdown) live in `.archer/`.
Use them as reference documentation for the architecture, flows and decisions: read the ones
that concern a task before changing what they describe, and offer to update the ones it makes stale.
`archer list` shows what is there; the folder may be hidden from search tools by default.
In docs mode: before architecture work, read `.archer/index.md` and only the file your question needs; the rules are `archer docs docs-mode`.
<!-- archer:end -->
