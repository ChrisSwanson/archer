---
type: overview
author: agent
description: What Archer is, the problem it solves, the loop it is built around, and who it is for.
diagrams: [heartbeat, system-context, containers, deployment, feedback-loop]
---
# What Is Archer?

Archer is the shared, visual memory of how a codebase works, kept next to the code. You and your
coding agent look at the same diagrams: the agent shows how it understands the system, you correct
it, and wrong ideas surface before any code is written.

The diagrams are Mermaid files and the notes are Markdown, in your repository's `.archer/` folder,
versioned in Git. Archer draws them in a web page on your machine, where you read, select and
comment, and your agent reaches the same files through the `archer` command (or MCP tools).

## The problem

Working with coding agents produces a lot of text. Plans, explanations and summaries arrive as
walls of prose, and the shared understanding they build lives in a chat that scrolls away. Two
things go wrong:

- **Agreement is slow and uncertain.** You read paragraphs to find out whether the agent's idea of
  your system matches yours. Often it doesn't, and you find out from the code.
- **Understanding doesn't last.** The next session, or the next agent, starts again from the code,
  because nothing durable recorded what was agreed.

A picture is quicker to check than a paragraph, and a picture kept in the repository is still there
next week.

## The heartbeat

Every Archer feature is judged by how well it serves one loop:
[The Heartbeat Loop](../diagrams/heartbeat.mmd). Open it in Archer and play the walkthrough
**One Turn of the Heartbeat** to follow it step by step.

1. **Big picture first, then drill down.** Agree on the top level (who uses the system, which
   parts it has) before going into flows, components and code. The agent asks the bigger questions
   before the detailed ones.
2. **Answer by showing.** When you ask how something works, the agent opens the diagram that holds
   the answer and lights the path with emphasis or a walkthrough. Prose in chat is the fallback.
3. **Keep a living knowledge base.** The agent maintains the diagrams and notes as the code
   changes, organised top down, so you and future agents can rely on them.
4. **Design together, live.** Start a feature by describing it while the agent draws; comment on
   the picture and watch it change, until it is the design you both agree on.

## What it looks like

Archer sits between you, your agent and your repository:
[Archer System Context](../diagrams/system-context.mmd).

- **You** use the Archer page in a browser: a canvas you can pan, zoom and select on, a notes
  reader with diagrams inside, comments, highlights, walkthroughs, and an editor.
- **Your agent** uses the `archer` command and the Archer skill, which teaches it the heartbeat
  and the operations: `validate_diagram`, `write_diagram`, `present_diagram`, `set_emphasis`,
  `get_comments`, `reply_comment` and the rest. An MCP server with the same operations is opt-in,
  and hosts that support MCP Apps can show Archer's page inside the chat.
- **Your repository** holds everything that matters: `archer.toml` and the `.archer/` folder.
  There are no accounts and no hosted copy of your model.

Inside, Archer is a handful of parts started from one install:
[Archer Containers](../diagrams/containers.mmd). Its walkthrough **A Diagram Reaches the Person**
follows one diagram from the agent's command to your screen and your comments back. A background
service, one per user, watches every attached project, compiles changed diagrams and pushes them to
open pages, so an edit shows up without a reload.

The agent often runs on another machine than your browser:
[Where Archer Runs](../diagrams/deployment.mmd). You get in with a pairing code or an access link
issued from the shell or the agent; opening Archer to your network takes your own yes.

## Like, and unlike

- **Like Claude artifacts, for architecture.** The picture drives the conversation.
- **Unlike a diagram renderer**, Archer is a two-way channel: the agent presents, highlights and
  captions; your selection, comments and edits flow back to the agent.
- **Unlike a generated wiki**, it is a small, checked set of docs the agent keeps true, not pages
  regenerated wholesale from the code.
- **Mermaid stays the source.** The page never becomes a second copy of the model, and any Mermaid
  tool can still read your files. Archer accepts a stricter subset of Mermaid so that every part has
  a stable id to select, highlight and comment on.

## Who it is for

A developer who works with coding agents, often several, often on remote hosts. You think in
pictures, you are tired of walls of text, and you want to agree on architecture, user flows and
data flows faster and with less reading. The agent is a user too: it writes the docs and reads them
back before it changes code.

Teams and reviewers come later. So does the phone: today it gets a readable picture, not the full
canvas.

## Where to go next

- [User stories](user-stories.md): five ways a session with Archer goes, each with its diagram.
- [A Working Session With Archer](../diagrams/working-session.mmd): one session, step by step, and
  how well today's Archer supports each step.

## Try the interaction

Start **One Turn of the Heartbeat** on [The Heartbeat Loop](../diagrams/heartbeat.mmd).
At **The person selects and comments**, select **Person Selects and Comments** and
leave a comment about the part of this loop you want explained. Send it when you want
your agent to respond.

Leave the walkthrough, then ask your agent to **show how sent comments reach it and
how its answer reaches the page** on
[Designing a Feature Together](../diagrams/feedback-loop.mmd). From the `archer-tour`
project folder, apply the live example:

```sh
archer present feedback-loop
archer emphasis set --file demo/emphasis/feedback-loop.json
```

In Highlights, toggle **Sent feedback** and **Revision and answer** to follow one
direction at a time. The recipe uses `flow` for directional exchanges; its chevrons
move, or stay still with reduced motion. A `highlight` points at a set of parts
without claiming a travel order. Select **Send to agent** and comment on what that
boundary should mean in your own project.

This is live pointing, separate from the saved walkthrough. A fresh clone has no
active emphasis. Applying the recipe changes the service's highlights, leaving the
Mermaid source intact. Clear it explicitly:

```sh
archer emphasis clear feedback-loop feedback-round
```
