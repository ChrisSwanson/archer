# Archer

Archer is a shared visual memory of a codebase: Mermaid diagrams and notes that a person and their
agents read, comment on and keep current. This glossary covers terms whose meaning is specific here.

## Architecture model

**Element**:
One thing in the architecture (a person, system, container, component, database, table) with one
id and one name, the same in every diagram that draws it.
_Avoid_: node (for the thing itself; a node is how one diagram draws an element), box

**Part of**:
The containment relationship that makes the levels: an element is part of one parent, to any
depth. C4's System › Container › Component › Code are the default names (Online shop › API
application › Orders controller); a database is a container, its tables are code-level. When
diagrams disagree, the project model keeps each reading and flags the conflict; it never picks one.
_Avoid_: inside, child of, contains (as a relationship name)

**Runs on**:
The deployment relationship between an element and where it is hosted (the orders database runs on
the Postgres server). Separate from part of, so an element never has two parents.
_Avoid_: hosted in (as containment), lives in

**Dataflow**:
An ordered path over existing elements showing how data moves; it may name a hop no diagram draws,
but never introduces an element.
_Avoid_: flow diagram (a Mermaid flowchart is a diagram, not a dataflow)

**Occurrence**:
One diagram's drawing of an element: its id, label, kind and parent there. The project model is
built from occurrences, and a grown canvas keeps each frame's occurrences apart.
_Avoid_: instance, copy

**Reading**:
One kind or parent that one or more diagrams give an element. Two readings are a conflict.
_Avoid_: version, variant

**Project model**:
Every element and relationship of a project, merged from all its diagrams; no diagram draws all
of it.
_Avoid_: master diagram, union diagram

**Exploration**:
A canvas grown from one diagram by expanding its elements into the project model, each added part
framed by the diagram it came from.
_Avoid_: view (in the code a view is one diagram), composed view, canvas view

**Source**:
One other diagram whose part touching an element is added to an exploration, inside a frame that
names it.
_Avoid_: layer, overlay (a dataflow is the overlay)
