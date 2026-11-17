# Claude entry point for Archer

Follow [`AGENTS.md`](AGENTS.md) as the repository-wide operating instructions.

The product is the TypeScript implementation in `ts/` (with the page in `ui/`).

At the beginning of a session:

1. Find the work: the GitHub issue (or pull request) you are picking up, and the newest
   [`CHANGELOG.md`](CHANGELOG.md) entry for what shipped last.
2. Read `docs/agents/frozen-boundaries.md` and `ts/docs/supported-mermaid.md` for the contracts
   that bind the area, and the Archer folder's diagrams for it, before editing.
3. Confirm the Git branch and its base (`git log --oneline origin/main..HEAD`).
4. Work in bounded red-green-refactor slices with focused tests, run the aggregate gates
   (`npm run pr-check`) once before the PR, get an independent review, check the integrated result
   by hand, and open the PR as [`CONTRIBUTING.md`](CONTRIBUTING.md) and the `archer-pr-flow` skill
   describe.

Do not duplicate work already on `main` or alter frozen contracts without an explicit, reviewed
decision argued in the PR.

Frontend work reuses the shared App Shell's layout and workspace behavior; keep page content, scope/capability policy and state identity separate.
