# Docs mode: the doc pack

For a project whose `archer.toml` has `mode = "docs"`. The Archer folder holds a small pack of
capped files that say how the code works. Agents keep it true and answer from it.

## Read

- **Read `index.md` first, and nothing else unasked.** It is generated: never edit it by hand.
  `docs_index` with `question` (CLI `archer docs index "<question>"`) names at most three files.
- Never read `notes/scratch/` or `notes/proposals/` as a description of the system.

## The files (caps in characters, front matter and diagrams included)

| File | Answers | Cap |
|---|---|---|
| `index.md` | Which file answers my question? | 3,000 |
| `README.md` | The folder's front door for people; links `index.md` | 1,500 |
| `intent.md` | Why, for whom, goals, non-goals, constraints, quality order | 4,000 |
| `use-cases.md` | One row per job: case, job story, Intent, Built, flow and code | 6,000 |
| `architecture.md` | Parts, overview diagrams, code map, boundaries | 6,000 |
| `invariants.md` | What must never happen, each with its guard (at most 15) | 3,000 |
| `glossary.md`, `threat-model.md` | Terms; trust boundaries and guards | 6,000 |
| `lessons.md` | A surprise that cost time, and the rule it left | 3,000 |
| `diagrams/flows/*.mmd`, `notes/flows/*.md` | One key flow each | 4,000 |
| `notes/architecture/*.md`, `notes/decisions/*.md` | One part's detail; one decision | 4,000, 3,000 |

Required: index, README, intent, use cases, architecture and two to five flows. Write the rest only
when there is something true to put in it: no empty templates. Budgets: router 3,000; an answer
(router, use cases, one flow) 15,000; the routed pack 80,000.

## Write

- Front matter: `author: agent`, `description:` (the question it answers), `type:` (intent,
  use-cases, architecture, invariants, glossary, threat-model, lessons, user-flow, data-flow,
  decision), `status:` (proposed or built; intent: proposed or confirmed), `checked: <commit>
  <date>`, `refs: [...]`, and for a flow `use-cases: [...]`.
- Lead with the answer. Name the code, don't retell it. Slow-changing facts, tables, bullets;
  unknowns last, inferences marked "(inferred)". Built and proposed never mix.
- Code references are repository-root-relative in backticks (`a/b.ts`, `a/`, `a/b.ts#name`), no
  line numbers except in `lessons.md`. `refs` covers every path the body cites.
- `checked` names a commit holding the code you read: commit the code, check the docs, commit them.
- Every code reference must resolve and every diagram compile. Keep existing files where
  they are: comments and links follow the path.

## Answer "how does X work?"

1. `docs_index` with the question, or `index.md` then `use-cases.md`: two small reads, not a code search.
2. If the flow is stale or a ref is dead (`docs_index` with `check`), read the changed code first. A
   wrong doc is reported, never presented.
3. Spot-check the cited code, then `present_diagram` and `set_emphasis` (`flow` style) with a
   one-line caption.
4. More detail goes in a copy in `notes/scratch/` (`based-on: <diagram address>@<sourceRevision>`);
   the pack is unchanged.
5. Not in the pack: answer from the code, then offer one proposed case and flow.

## Before a structural change

When the change would make a doc wrong (a new part or store, a moved responsibility, a changed
flow, a new decision): write a copy in `notes/proposals/` (`status: proposed`, `based-on:`), present
it with "(proposed)" emphasis and the cases it serves, and wait for the person.

## End of every code-changing task

Commit the code. Find pack files whose `refs` match the changed paths; run `list_stale_diagrams`.
A doc the change made wrong is updated (in docs mode, not offered); one still true gets `checked`
set to the code commit. Update the Built status of cases the task changed. Consolidate files over
80% of their cap. Run `archer docs index --write --check` (`docs_index`), fix what fails, commit
the docs. Nothing changed or learned: do nothing.

## Growth

- Over 80% of a cap: consolidate. Merge duplicates, shorten, drop superseded entries. An invariant
  keeps its guard link. Never drop or reword a confirmed item without the person's yes; a changed
  confirmed item goes back to `proposed`.
- `write_diagram` refuses a diagram write past the cap (`doc_over_cap`, with the characters to
  free); `validate_diagram` warns. Prose edits with file tools are not checked as you write: `--check` finds them. Still
  over: split by purpose (a part's detail to `notes/architecture/<part>.md`, a sub-path to its
  own flow) and keep a one-line link.
- Two failed attempts to fit: stop and tell the person what is over and why.
- Prune what is stale; Git is the archive. A pack over 80,000: ask whether to split it by context.

## Intent

- **Bootstrap:** read the code, README and history first; never ask what the code answers. Draft
  `intent.md` (one line, for whom, goals, non-goals, constraints and the top three qualities in
  order) and the use-case map; present the map with guesses labelled.
- **At most five questions, one at a time**, each with a recommended answer and two to four
  choices, one of them "something else". One is open: "Tell me about the last time it should have
  helped and didn't." Stop when who it is for, the top job and the non-goals are covered; the rest
  goes in Open questions. Write each answer in at once, as `proposed`.
- **Confirmed** only after an explicit yes that names the item or the page: record
  `confirmed: <date> <revision> <what> (chat)`. Edits, comments and resolved threads are not a yes.
  Never write `confirmed` yourself without that yes.
- A request that breaks a **confirmed** constraint or non-goal: stop, quote the line, offer to change
  the request, propose an intent change, or note a one-off exception. A **proposed** item guides but
  never blocks: proceed and say what you assumed.
- A threat model is optional: offer it when the code has a listener, auth or untrusted input.
