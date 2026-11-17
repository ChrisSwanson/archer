---
type: scenario
author: agent
description: Five concrete ways a session with Archer goes, each told with the diagram that shows it.
diagrams: [feedback-loop, comment-thread, answer-by-showing, heartbeat, containers, deployment, working-session]
---
# User Stories

Five ways a working session with Archer goes. Each names the diagram that shows it; open them in
Archer to see the parts the story mentions. The operation names (`present_diagram`,
`get_comments`, …) are the real ones your agent runs.

## 1. Ideating a new feature with your agent

*When I have an idea for a feature, I want to see my agent's understanding of it as a picture, so
we agree on the design before any code is written.*

Sam wants to add saved searches to an app. They describe the feature to their agent in two
sentences. The agent writes a new note in `.archer/notes/` with a Mermaid diagram of how a saved
search would flow, checks it with `validate_diagram` (every problem comes back at its line), and
calls `present_diagram`. It gives Sam the page URL and one sentence on what the diagram shows.

Sam opens the page, clicks the arrow from the search service to the database and comments: "This
should go through the cache." They select another box and ask why it exists. A comment is a draft,
visible only to Sam, until it is sent: by default each one goes when Sam sends it, or Archer can
hold them all for one **Send to agent**. The agent, listening with `archer wait`, picks them up
with `get_comments`, changes the diagram with `write_diagram`, and replies to and
resolves each thread. The page redraws while Sam watches and names what changed.

Two or three rounds later the picture is the agreement.

- The loop: [Designing a Feature Together](../diagrams/feedback-loop.mmd).
- A thread's states, from draft to resolved: [Life of a Comment Thread](../diagrams/comment-thread.mmd).

## 2. "How does checkout work?"

*When I ask how part of the system works, I want to be shown the existing diagram with the path
lit, so I understand it at a glance instead of reading an explanation.*

Priya joins a project and asks her agent how checkout works. The agent does not write paragraphs,
and it does not draw a new diagram. It looks up the project's diagrams with `list_diagrams`, finds
the checkout sequence, reads its ids with `read_diagram`, and presents it with the checkout path in
**emphasis**: up to three groups, coloured by importance, with a short label each. If the diagram
has a walkthrough that covers the question, the agent opens that instead, at the step the question
is about, and Priya steps through it at her own pace.

Her answer is a link and a few sentences naming the diagram. The source is untouched: emphasis
never edits the file. If the diagram lacks a part the answer needs, the agent says so and offers
the change.

- The exchange: [How Does Checkout Work?](../diagrams/answer-by-showing.mmd). (This tour has no
  checkout diagram of its own; the story is about yours.)
- A walkthrough to try here: **A Diagram Reaches the Person** on
  [Archer Containers](../diagrams/containers.mmd).

## 3. Keeping a living architecture knowledge base

*When the code changes, I want the architecture docs to change with it, so the next answer, mine
or a future agent's, is still true.*

Alex sets `mode = "docs"` in `archer.toml` (`archer init --docs` does it). The project now keeps a
small **doc pack**: intent, use cases, architecture and a few key flows, each file with a size cap,
behind a generated router, `index.md`. Before architecture work, an agent reads the router first,
and only the files the question needs (`archer docs index "<question>"` names at most three).

Before a structural change (a new part, a moved responsibility, a changed flow), the agent writes
a proposal copy in `notes/proposals/`, presents it with the new parts marked "(proposed)", and
waits for Alex. After the code change, it updates the docs the change made wrong and runs
`archer docs index --check`, which reports caps, dead code references and stale diagrams.
A diagram registered with `covers` in `archer.toml` is reported stale by `list_stale_diagrams`
when the code it covers has changed since the diagram was last committed.

- The loop's knowledge-base half: [The Heartbeat Loop](../diagrams/heartbeat.mmd), the
  **Living Knowledge Base** card.
- Where today's support is thinner (staleness scores 3):
  [A Working Session With Archer](../diagrams/working-session.mmd).

## 4. Reviewing a proposed change in a copy

*When my agent proposes a change, I want to see it drawn against the documented architecture,
without the documentation changing, so I can review the design before it becomes the record.*

The agent wants to split the background service in two. Instead of editing the documented
container diagram, it makes a **copy**: a new note in `notes/scratch/` whose front matter says
`based-on: containers@<revision>`, with the new parts added. It presents the copy with the new
parts emphasised and labelled "(proposed)", lists its assumptions and asks one question. The
documented diagram stays exactly as it was until the change is agreed and built.

Reviews run the other way too. When the person edits a diagram in the page and saves, the agent
sees the saved change with `list_changes` and `read_change`, asks what it needs to, and clears it
with `resolve_change` and a summary of what it understood. For a pull request, `compare_diagrams`
shows one diagram's semantic changes between two commits. A before-and-after view of every
diagram a change touches is planned, not built.

- The diagram such a copy would start from: [Archer Containers](../diagrams/containers.mmd).

## 5. Following along from another device

*When my agent runs on another machine, I want to open the same page from my laptop, so I can
follow and comment without sitting at that machine.*

Jo's agent runs on a build server; Jo is on a laptop. The background service runs where the agent
and the repository are. To let Jo in, the agent runs `archer pair`, which gives a short single-use
code Jo types at Archer's address, or issues a revocable access link. Reaching the service from
another computer over the network uses HTTPS on the local network, and turning that on takes Jo's
own yes at a terminal.

On a phone the page is for reading: a readable picture first. Editing is on the desktop.

- Where each part runs: [Where Archer Runs](../diagrams/deployment.mmd).

## Not yet

Of the jobs Archer's own use cases list, these are planned, not built:
teach-back (explain a flow back on the diagram and see where you differ), now versus intended
(built and designed side by side), replaying an incident step by step, narrow assertions checked on
change, and a generated handover note for the next agent.
