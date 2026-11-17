# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A developer working with coding agents, often several, often on remote hosts. They are a visual
thinker, tired of walls of text, who wants to understand and agree on architecture, user flows and
data flows faster and with fewer words. Open source, so it must work for someone who installs it from
the [install guide](docs/install.md) alone. Teams and reviewers come later.

## Product Purpose

Archer is the shared, visual memory of how a codebase works, kept next to the code. Person and
agent use it to see the same picture: the agent shows how it understands the system, the person
corrects it, and both catch wrong ideas before code is written.

Its diagrams and notes are living documentation, like a DeepWiki for your own repository, kept
current by the agent as the code changes, versioned in git, and read later as reference (RAG) by
future agents getting their bearings. When someone asks "how does this feature work?", the agent
answers by **finding the existing diagram and highlighting the path** (emphasis), not by writing
prose or drawing a new picture from scratch. When more detail is needed, it makes a **copy** that
elaborates on the documented diagram and leaves the documentation untouched.

Success: higher-assurance agreement between person and agent, reached faster and with less
reading, from documentation that stays true.

### The heartbeat: shared understanding, big picture first

A picture is worth a thousand words. Shared understanding kept only in chat text gets lost and goes
fuzzy; architecture diagrams and the notes around them hold it at a higher level and make the
detail easier to find. Every feature is judged by how well it serves this loop:

1. **Start from the big picture, then drill down.** Person and agent agree on the top level first
   (system context, then containers), and only then go step by step into components, flows and
   code. The agent asks the bigger questions before the detailed ones.
2. **Answer by showing.** When the person asks how something in this application works, the agent
   takes them to the diagram that holds the answer and shows it with emphasis or a walkthrough, or
   opens the note that explains it with the relevant passage highlighted. Prose in chat is the
   fallback.
3. **Keep an active knowledge base, architecture first.** The agent maintains the project's
   documentation as a knowledge base the person and future agents can rely on. Diagrams and notes
   are organised top down, so higher-level views lead to the lower-level stories, and they stay
   neat, current and easy to search rather than growing as a pile. The agent writes as a skilled
   technical writer and follows well-known structures (ADRs, architecture docs, open knowledge
   formats) so the layout is predictable and search works well.
4. **Design together, live** (the intended starting point, not the only use). A person can start a project with their agent, open it in Archer and
   talk with the agent from the web page while the agent draws what they describe, in Mermaid
   diagrams and notes, as the conversation goes.

## Positioning

Like Claude artifacts, but for architecture understanding and agreement: the picture drives the
conversation. Unlike a diagram renderer or a generated wiki, Archer is a two-way channel. The agent
presents, highlights and captions; the person's selection, comments and edits flow back to the
agent. Everything is local Mermaid and Markdown in git, with no hosted copy of the model.

## Operating Context

- Agents use MCP tools, a skill and a CLI. People use a web page served by a local background
  service across many projects, and an MCP App in hosts that support it.
- Usually beside an editor or terminal on a desktop. Phone use is secondary for now. On a phone
  the likely surface is the MCP App or a static picture, not the full interactive canvas.
- Diagrams and notes live in the project's Archer folder (`.archer/` by default) and `archer.toml`.
- A project with `mode = "docs"` in `archer.toml` keeps a few maintained architecture docs that the
  agent reads first (via a generated index) and updates before structural code changes. One-off
  sketches and elaborations live under `notes/scratch/` in any project; a project without the
  setting keeps the plain behaviour.
- Agents often run on other hosts than the person's browser. The person opens Archer from whichever
  device they are on (laptop, desktop); access is granted by a pairing code or an access link issued
  from the shell or the agent, so having shell or agent access is enough to get in. Opening the
  service to the network takes the person's own yes at a terminal.

## Capabilities and Constraints

- Canvas: select, pan, zoom, keyboard traversal, marquee selection, emphasis, comment pins, a
  nested view, and an editor for supported families.
- A diagram is in one mode at a time: Explore, Highlights, Walkthrough or Edit, with one side panel
  for walkthrough steps or highlight groups and their key. A walkthrough step always shows the same
  picture however it is reached; leaving restores the prior view.
- Network access: a LAN-only HTTPS address with a local certificate, pairing codes and revocable
  access links. Undecided: a basic-auth style login for later.
- Projects sidebar, notes reader with embedded diagrams, search, comments and review panel,
  staleness and revision compare, SVG/PNG export.
- Text is measured without a browser for layout, so a typeface is a layout input, not only a style.
- Frozen contracts (`docs/agents/frozen-boundaries.md`) change only through a reviewed pull request.

## Brand Commitments

- Name: Archer.
- Voice in the UI is plain and honest about state: it says what is off screen, stale, or failed to
  compile, and how to recover. The agent's words are labelled as the agent's.

## Evidence on Hand

- Archer's own diagrams and notes in this repository; example and fixture diagrams in `examples/`
  and `fixtures/`. No users, testimonials, or adoption figures exist; do not invent them.

## Product Principles

1. Show, don't tell: a highlighted diagram beats a paragraph. Reduce what anyone has to read.
2. Reuse the documentation: answer from existing diagrams with emphasis; elaborate in a copy.
3. Agent and human must never be looking at different things without knowing it.
4. Be honest about state: never imply something is current, visible, or valid when it is not.
5. Mermaid stays the source of truth; the UI never becomes a second copy of the model.
6. Desktop first; a phone gets a readable picture before it gets the full canvas.

## Accessibility & Inclusion

WCAG 2.2 AA, enforced by the axe browser suite. Keyboard-complete. Reduced motion keeps emphasis
meaning without animation. Meaning carried by colour (emphasis groups) is also available as text.
Low barrier to entry: install from one guide, with no accounts.
