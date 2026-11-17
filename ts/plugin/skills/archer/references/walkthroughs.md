# Walkthroughs

A walkthrough is a named, numbered path through one diagram that the person replays step by step on the page and shares as a link. It is kept in `<diagram>.walkthroughs.json` beside the diagram. Emphasis answers a question now; a walkthrough is for replay. Flowchart, C4, state, ER and architecture diagrams can host one; sequence and journey cannot. At most 12 per diagram, 20 steps each.

## Present

`list_diagrams` shows `walkthroughs: N`. When one covers the question, `present_diagram` with `walkthrough: {id, step}` instead of `emphasis` (never both; `annotation` is the caption). Start at the step the question is about. Say what the step shows in a sentence. `list_walkthroughs` (with `id` for the steps) shows each one's status.

## Write (only when asked)

Write one only when the person asks for a step-by-step to keep or replay. "Walk me through X" is answered with emphasis. Never write unasked.

1. `read_diagram`. Use only its ids; send no labels or line ends.
2. `write_walkthrough {viewId, modelRevision, walkthrough}`. Pass `modelRevision` as read; another is `revision_conflict`.
   - `id` (a-z, 0-9, `-`), `title` (6 words), optional `description` (one sentence), `steps`.
   - Step: `title` (48 chars), `kind` (`sends` when something travels a line, `does` when a part acts), `what` (200), optional `why` (200), `edges: [{id}]` in travel order, `nodes: [{id}]` (`kind: "group"` for a subgraph or boundary), `code` (up to 4 paths that exist; leave out what you do not know).
   - `messages: [{from, to, label}]` (label 28 chars, boxes of this diagram) draw a hop that has no line.
   - 4 to 8 steps, one hop each, in travel order. A step names at least one box, line or message.
3. All or nothing: a refusal (`invalid_walkthrough`) lists every problem with its fix, "Did you mean" for near ids. Fix them all, resend.
4. Replace with the walkthrough's `revision` as `expectedRevision` (`walkthrough_changed` returns it as it is now). `delete: true` removes one.
5. `present_diagram` with `walkthrough`, and give the URL.

## Keep it true

- A `write_diagram` that moves a walkthrough returns `walkthroughChange`. `list_stale_diagrams` also lists `walkthroughs` that are out of date or cite dead code. Offer the repair with `write_walkthrough`; never unasked.
- A step is out of date when its box or line is gone, or a line id now joins other ends. It is changed when a label differs: the step plays, its text may be stale. A walkthrough with no matching step is archived: `present_diagram` opens it by id (no step) as text, its old version one click away; offer to rewrite it.
- A step comment (`get_comments`: `walkthrough "T", step N "T"`) is fixed with `write_walkthrough`, keeping the step's id (send it back); then `reply_comment`, `resolve_comment`. `list_walkthroughs` shows `openComments`.
- Never edit a diagram to fit a walkthrough.

CLI: `archer walkthrough list|show|write|delete`; `show --markdown` prints one as prose.
