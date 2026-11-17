# How does a question become a shared picture?

Open [The Heartbeat Loop](.archer/diagrams/heartbeat.mmd) in Archer and start
**One Turn of the Heartbeat**. Follow a question through the picture, the person's
feedback and the next update to the docs.

Select **Person Selects and Comments** and write a comment about the part of that loop
you would want your agent to explain. Send it when you want the agent to respond.

From this folder, `archer present heartbeat` opens the diagram. The
[overview](.archer/notes/what-is-archer.md) explains the product; the
[user stories](.archer/notes/user-stories.md) show concrete sessions.

## Try the interaction

Leave the walkthrough, then ask your agent to **show how sent comments reach it and
how its answer reaches the page**, using the existing
[Designing a Feature Together](.archer/diagrams/feedback-loop.mmd) sequence.
From this folder, the agent can apply the supplied recipe:

```sh
archer present feedback-loop
archer emphasis set --file demo/emphasis/feedback-loop.json
```

The two labelled groups separate **Sent feedback** from **Revision and answer**.
Toggle either group in Highlights to follow one direction. Both use `flow`: chevrons
show exchanges in a direction, and remain still with reduced motion. A `highlight`
would instead point at a set of parts without suggesting travel.

Select **Send to agent** and comment on what you want explained before the agent
changes the picture. The recipe is a live action; a fresh clone has no active emphasis.
It changes the service's highlights and leaves the Mermaid source intact. Clear it with:

```sh
archer emphasis clear feedback-loop feedback-round
```
