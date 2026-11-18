# Archer interface

## Overview

**Creative North Star: "The Annotated Survey Sheet"**

Archer is a precise technical drawing that carries margin notes. The architecture artifact leads;
selection, emphasis, captions, comments, filters, and navigation support it without competing with
it. The mood is quiet, precise, honest, and compact enough for sustained technical reading.

This document records what Archer should look like, and the tokens in `ui/src/styles.css` and the layout
constants in `ui/src/layout/` implement it. When the code and this document disagree, that is a defect to
resolve against this document, not a licence to copy whichever is current. Use real project content wherever it is available:
real diagrams, real notes, real project descriptions, and truthful empty or error states. Chrome
measurements named below are contextual defaults for the surfaces that established them; diagram
measurements are layout constants, which the layout, the page and the export painter share.

Discovery surfaces use a compact portfolio hierarchy. Project names and descriptions orient the
reader; diagram miniatures and note facts help recognition; Folders, Diagrams and Notes offer different
ways to scan the same material. Keep this direction scoped to browsing and discovery rather than
turning every Archer surface into a gallery.

**Key characteristics:**

- The artifact leads and the chrome recedes.
- Information is compact, legible, and grouped by meaning.
- Color clarifies roles and state while shape, text, or position supplies a second channel.
- Real content replaces decorative or placeholder imagery.
- Interaction state is honest, keyboard-complete, and stable while content changes.

## Shared application frame

Browser pages use the shared Application Shell and component composition. Header, sidebar, workspace actions
and Help behavior have shared owners; pages supply identity and content. Keep intentional
capability/read-only differences explicit. Preserve the smaller embedded MCP shell.

- **The shared rail.** Every web page has one sidebar on the left: a 64px rail of icons (Archer, Projects,
  Settings, Shortcuts) that expands over the page, never pushing it, to `min(340px, 100vw - 12px)`. Expanded it
  lists Projects (the all-project overview, attached projects by name, the reader's five most recent files)
  and the shortcuts sheet; no paths and no file tree. At 720px and narrower it is a drawer
  (`min(320px, 100vw - 48px)`, over a scrim) that the document bar's menu button opens.
- **The document bar** above the content carries the breadcrumb, the page title (`--type-title`, 600) and
  the workspace actions.
- **The diagram side panel** sits to the right of the drawing, never over it. Its top section is the mode's
  surface: Explore (the walkthroughs to start and the agent's highlights to show), a Walkthrough, or the
  Highlights legend. Its bottom section is always the Diagram Key (at most 45% of the panel's height). `»`
  collapses it to a 44px rail of icons, remembered per viewer; a window narrower than 1000px starts collapsed,
  and a walkthrough opened there lies over the drawing with the rail's place kept. `↗` pops the Key out as a
  floating, movable box in the drawing's lower-left corner; its dock button puts it back. On a phone the same
  sections are one sheet of the stage's dock; nothing sits beside or over the drawing.
- **The review sidebar** overlays the canvas from the right (`min(330px, 100vw - 64px)`) without narrowing it.

## Colors

**Cool slate**, platform-wide: chrome, canvas, diagrams and exports. Use the light and dark custom properties in
`ui/src/styles.css` verbatim; do not add raw color outside the token blocks (the system-light block is
byte-identical to the explicit light block). Structure is white and Tailwind-like cool slate in light, a cool
near-black slate in dark. Chrome stays quieter than the diagram it frames.

| Role | Dark | Light |
|---|---|---|
| Canvas `--bg` / panel `--surface` / tint `--surface-2` | `#0f141b` / `#0b0f15` / `#18202a` | `#ffffff` / `#f8fafc` / `#f1f5f9` |
| Border / strong | `#273141` / `#384456` | `#e2e8f0` / `#cbd5e1` |
| Text / dim / faint | `#e6ebf1` / `#a3aebd` / `#8d99aa` | `#0f172a` / `#475569` / `#5d6b7e` |
| Faded words `--text-faded` | `#808b9b` | `#5d6b7e` |
| Node fill / node border / node words | `#1b2430` / `#8a9ab0` / `#f1f5f9` | `#f1f5f9` / `#64748b` / `#0f172a` |
| Connection `--edge` (and its filled arrowhead) | `#b4c0cd` | `#334155` |
| Accent / accent ink | `#9db4ff` / `#101a3a` | `#2645a3` / `#ffffff` |
| Accent fill / text on fill | `#1f2b52` / `#ffffff` | `#e1e6f6` / `#13235a` |
| Agent `--agent` | `#f2b544` | `#8a5f05` |

Hue is functional. Ink blue is the reader's voice: selection, the active tab and chip, focus on chrome,
highlights, expand buttons and the reader's contributions; no diagram family is blue. Amber is the agent's
voice: its emphasis, captions, replies and pin marks. The emphasis and danger families keep their established
meanings. Use the moderate existing palette to distinguish content and states; do not remove useful color
simply to make a surface more neutral.

**The Stable Meaning Rule.** Never swap role colors between contexts. A state expressed with color
also needs text, shape, position, or another non-color cue.

## Diagram palette

Colour identifies kinds and authored categories; structure is
neutral. Most of the clarity comes from composition: a bold title over a fully inked description, solid
rounded panels, crisp slate connections and few bends. A family is not an interaction state.

Six chromatic families, neutral and the quiet neutral. Each family is a set of tokens in every theme block
(dark, system-light and explicit light): fill, border, ink (captions, cards, Key), text (words on the fill),
panel and card (`--family-<name>-*`). `ui/src/diagrams/palette.ts` decides which family anything is drawn in, once,
for the canvas, exports and miniatures; exported drawings resolve the same tokens to their literal values.

| Family | Light: fill / border / ink / panel | Dark: fill / border / ink / panel | Default role |
|---|---|---|---|
| Neutral | `#f1f5f9` / `#64748b` / `#0f172a` / `#ffffff`, nested `#f8fafc` | `#1b2430` / `#8a9ab0` / `#f1f5f9` / `#121821`, nested `#19212c` | Unclassified, component, external, structure |
| Violet | `#f3effe` / `#6d28d9` / `#4c1d95` / `#f5f3ff` | `#241f3a` / `#a78bfa` / `#d8cefd` / `#16182a` | Person; an authored blue ("you decide") |
| Teal | `#ddf7f1` / `#0f766e` / `#134e4a` / `#f0fdfa` | `#122b2c` / `#2fbfae` / `#a0e7dd` / `#111e23` | System, serving infrastructure |
| Green | `#dcfce7` / `#15803d` / `#14532d` / `#f0fdf4` | `#142b1e` / `#4cc27a` / `#aeeac1` / `#121c1c` | Container, execution unit |
| Plum | `#fdeef6` / `#a3216a` / `#831843` / `#fdf2f8` | `#2e1828` / `#ec79b5` / `#f8c4df` / `#1c1722` | Database, storage |
| Rust | `#fff0dc` / `#c2410c` / `#7c2d12` / `#fff7ed` | `#2e1d12` / `#f0803c` / `#fdc9a2` / `#1d1a19` | An authored orange (a walled-off sandbox) |
| Red | `#7f1d1d`, white words / `#450a0a` / `#7f1d1d` / `#fef2f2` | `#8a2020`, white words / `#f87171` / `#fca5a5` / `#1b181b` | An authored red: consequential ("changes the real server") |

Cards in a family panel are `#ffffff` in light and the neutral node fill (`#1b2430`) in dark, with the family's
border and ink.

**The quiet neutral.** An authored grey category whose outline is a light grey (OKLCH lightness 0.65 or more,
fill grey or absent) recedes a step: light `#e5e7eb` / `#7f8896` / words `#4b5563`, dark `#30343b` / `#666d78` /
`#a3aebd`. Its words keep 4.5:1 on its fill and its border 3:1 on any ground, both under the plain neutral's; its
fill is a visible step off the plain card (CIEDE2000 3 or more in light, 6 or more in dark). Any other grey
category is the plain neutral. A drawing may need both: "the AI's work" (slate outline) and "Dropped"
(light grey outline). The outline decides because the two fills barely differ; a fill-only grey stays plain.

**Node words.** Title and description are in the box's own full ink: the node words on neutral, the family's
text on its fill (white on the solid red), the family's ink on a card. Never the chrome's `--text-dim`.

**The hue rule.** Reader blue and agent amber stay reserved (Colors). An authored colour whose OKLCH hue falls in
the blue band (235–290°) is drawn in the nearest other family (violet for an ink blue); one in the amber band
(55–110°) is neutral. Orange and red are not reserved: an isolated sandbox is not an error, and its dash and name
still say it. Below OKLCH chroma 0.05 an authored colour has no usable hue and is a grey; a cool slate such as
`#64748b` (chroma 0.041) is a grey.

**Mapping.**

- Flowchart kinds: `person` violet, `system` teal, `container` green, `database` plum; `component`,
  `external` and nodes without a kind neutral.
- C4: Person, System, Container use their families, database variants plum, Component and every `*_Ext`
  neutral with its External cue. System and container boundaries use teal and green panels; enterprise and
  generic boundaries are neutral unless a category colours them. Boundary dash patterns and caption words stay
  (they are notation).
- Architecture: `server` teal; `database` and `disk` plum; `cloud`, `internet` and no icon neutral.
- An authored `classDef` category takes the family nearest its usable chromatic fill, else its usable
  chromatic stroke, compared perceptually (OKLCH hue) against the six family hues (violet 300°, teal 190°,
  green 150°, plum 345°, rust 42°, red 26°). Source order never decides a colour, so adding a category recolours
  nothing else. Two categories may share a family: their names and members tell them apart. A category's name
  says nothing about its meaning (`gpu` is the author's word).
- **Structure is neutral**: hashing groups into families would invent meaning. An unclassified
  group is never coloured and passes no colour on. A group coloured by its own category or notation is a family
  panel; a node directly inside it with no colour of its own, or of the same family, is a light card in that
  family's border and ink. A node's other kind or category keeps its own.

**Group panels.** Opaque, never stacked transparency, in three roles:

- **The outer boundary**: the outermost plain neutral subgraph, round the drawing. A clear panel (`--group-bg`,
  the canvas in light) with the dark outline (`--group-border`) at `--line-boundary` (2px), its caption at the
  top **right**.
- **A structural panel**: a neutral subgraph inside another panel. The pale step (`--group-bg-alt`) with the
  quieter outline (`--group-border-alt`) at `--line-panel` (1.5px) and the quieter caption
  (`--group-caption-alt`), top left.
- **A family panel**: tinted (the family's panel) with the family's border at `--line-panel` (1.5px) and its
  caption in the family's ink, top left.

All three round at `--radius-panel` (16px). A caption is 14px (`--type-canvas-frame`), weight 700, on a 20px
row, inset 14px from the frame's side and 10px from its top (`FRAME_CAPTION_INSET`). The layout reserves the
caption's band in the frame's top padding (52px: inset, row, an arrowhead's reach and a gap; 20px on the other
sides) and places the caption at the first run of that band, from its end, that no wire, arrowhead or edge label
crosses; a frame whose band every wire crosses is widened and laid out again. Frames that are model elements (a
C4 boundary, an architecture group) are 2px boundaries rounded at `--radius-node` (12px) with captions top left;
a composite state rounds at 16px. Nesting shows by enclosure, outline weight and the pale step, never by
deepening saturation or transparency. Notation-defined patterns and authored dashes stay.

**Shadows.** None on nodes: resting boxes are separated by
tone and line, as the Quiet Depth Rule says, on the page, in exports and in the Key. Selection keeps its own glow
and the keyboard its ring.

**Lines and nodes.** Lines are inked, not hairlines, but not heavy either. Ordinary connections are 2px, opaque
`--edge`; thick lines 4px (every state's thick twin stays exactly 2px over its solid one); hover is 3px, selection
6px of accent (2px each side), a hovered or selected node's own connections 4px of accent drawn above the others
(between resting and selected, so they never read as a selection; nothing else fades), emphasis the resting weight in
its hue, a bundle 3px or 5px; a state
machine's transitions 1.5px (thick 3.5px) and ER relationships 1.25px (thick 3px), where the boxes carry the
reading; sequence messages 1.25px.
Dotted is `2 4`, dashed `6 4`, dash-dot `8 3 2 3`; authored line patterns keep their Key meanings, and the
arrowhead is a filled marker in the connection's own colour (notation-defined heads stay). Node borders are
`--line-node` (1.5px), a C4 system's `--line-node-strong` (2px); rectangular nodes round at `--radius-node` (12px), less than the 16px panel they sit in;
the `rounded` shape and a state round at 16px; semantic shapes stay. Judge weight at the opening view and at
Fit, in both themes.
**Curved lines** (a viewer's choice in Archer Settings, saved in this browser; off by
default): the boxes stay where they are and each line is drawn as one gentle curve from box to box, the way
Mermaid draws a flowchart (`diagrams/mermaid-curve.ts`): d3's `curveBasis` through a few points only (where the line
leaves its source, one point per gap between layers at the level the line is heading for, one per layer it passes,
and where it enters its target). Each end is where the line from the box's centre toward its nearest point meets
the outline, so lines leave and enter at a slant and the arrowhead follows the curve, its tip on the border. A caption
sits on its curve at the middle of its length and slides along it until clear; captions have no plates. A curve
keeps 6px from every other box, note and frame caption and never enters its own ends; one that cannot is drawn
through the route's corners nearest the trouble, and failing that with wide rounded corners on the square route
(caption where the layout put it). A line that crosses a caption, or whose caption has no clear place, is drawn
that way too, so the drawing never has a collision the square one lacks. Lines with stated ports keep their sides.
Curves cross at shallower angles than square corners and a dense fan-in converges on one point, as in Mermaid.
The click band follows the curve. Exports keep square corners.

**Node text.** In Fira Sans (Typography). A flowchart node's first line is its title: 18px, weight 700, on a
24px line (`--type-canvas-node-title`). Every following line is its description: 15px, weight 400, on a 23px
line, 4px under the title (`--type-canvas-node-description`), in the same full ink as the title (Node words).
A figure that draws every row alike (a state, an entity, a C4 element) is 14px, weight 600, on an 18px line
(`--type-canvas-node-label`). A box is at least 180 by 60, keeps 24px each side and 16px above and below its
words, and widens before it wraps: its words wrap at 344px (a 392px box less its padding). Described cards
(a title over a description) in one panel share a width: one within 75% of the widest is drawn at the widest.
Figures, closed containers, circles, diamonds and title-only cards keep their own. A kind other than a person
says itself in a caption row above the label (11px, weight 500, 16px line, capitalised, its glyph beside it);
a flowchart **person** shows a 16px glyph 6px before its title instead, and no "Person" row; C4 elements keep
their kind words. Archer measures text outside the browser, so a size, weight or line here changes with its
constant (`NODE_TITLE_*`, `NODE_DESCRIPTION_*`, `NODE_PAD_*`, `NODE_MAX_WIDTH`, `PERSON_GLYPH_*` in
`layout/graph-metrics.ts`), and the layout, the page, the export painter and miniatures change together.

**Edge labels.** No plate. The label is 13px (`--type-canvas-edge-label`) regular
italic on an 18px line, in the softer ink (`--edge-label-ink`, which is `--text-dim`; on a family panel, the
family's ink). The line breaks round the words: the gap (the words plus 4px either side and 2px above and below)
is painted in the colour of the ground behind it, region by region where a panel's edge runs through it, with the
frame's line left showing (`diagrams/label-ground.ts`, shared by canvas and export). A label wraps at about 24
characters of prose, on at most two lines; a longer one widens rather than taking a third line or being cut, and
the lint `edge_label_too_long` counts the same 24. The layout keeps 10px of line visible either side
along the flow (`EDGE_LABEL_LEAD_PX`). A C4 relationship's technology (11px on a 15px line, in brackets) and
description (wrapped at 150px, up to three lines) sit under its label.

**Dark mode.** Colour lives mostly in the lines: bright family borders and inks (each 4.5:1 or more on the
canvas and on its panel), quiet tinted fills (CIEDE2000 3–20 from the neutral fill, under 1.15:1 in lightness)
and faintly tinted panels (CIEDE2000 3–8 from the neutral panel, under 1.15:1). Never dark, muddy coloured boxes
on the near-black canvas; the solid red is the one deliberate exception.

**Selection and emphasis.** Selection fills the body (`--accent-fill`, its words `--accent-on-fill`) with a
`--line-selected` (2.5px) accent border and its glow (`--node-shadow-selected`); a family's colour yields to it,
and membership stays in text. The keyboard's ring is an inset 3px `--kbd-focus`; on the solid red it is white.
Emphasis keeps its group hues and draws a `--line-emphasis` (3px) border. Teal and violet families sit
close to two of the hues, and rust and red near coral, so a drawing that uses family colours shows emphasis group
numbers by default, on the canvas and in exports. On the solid red no
emphasis hue reads against the fill, so an emphasised red node is read where its 3px border meets the ground and by
its number. Do not add rings, bands or glows.

**Highlights fade clearly.** While a highlight is shown, every node and frame it does not name steps back: its fill
and border at a quarter (`--node-bg-faded`, `--group-border-faded`), family ink and words in `--text-faded` (the
quietest grey that keeps 4.5:1 on every faded box and ground). Every connection not on the path (one it names, or
one between two members) does too: its stroke and arrowheads at a quarter, its words in the faded ink. Faded words
stay opaque; fade shapes, not words. Members keep their colour, so a highlight in a family's hue reads over boxes in
that hue, and a frame holding a member stays as its context (page and export).

**The Diagram Key** lives in the side panel and **opens expanded** wherever it appears, docked or floating; a
reader's own collapse is remembered, and during a walkthrough it starts closed. The panel is
present whenever the drawing has a row to give or has groups (a flowchart of plain shapes and arrows has none).
It shows only the kinds and categories present, each with its real sample (28 by 18: a node's fill, its 1.5px border
and dash at a 4px corner, or a panel's fill and 1.5px line at a 6px corner, where every member is a panel or a
card in one), its name, and a Members disclosure naming the nodes and groups in it. Membership is also in each
member's accessible name. A row is called by the author's words (`%% archer-key gpu: Model server on a GPU`, up
to 32 characters), else the class name as written; a kind keeps its word and glyph, said once. The detail line
names the class. Colour rows are in the order each kind or category is first worn in the source (`sourceOrder`),
the same in the Key and exports; C4 and architecture rows
follow the model's element order. Only the order: a colour never depends on where anything is written. The
notation rows keep what a drawing does not say on its face, the author's line meanings first: authored line
patterns, C4 boundaries, composite states, architecture groups and shapes with meaning. Plain structure has no row, and no lone
"Group" row (its frame and caption say it). Node and group samples are kept apart from connection-pattern
samples: a dashed category says nothing about a connection. The Key ends with the voices: blue marks the reader's
selection and comments, amber the agent's replies.

There is **no legend in the drawing** on the canvas: it would say what the Diagram Key says.

**The export's colour key.** An export has no sidebar, so it draws the colour rows compactly **beside** the
drawing, 32px to its right, aligned with its top: each row's sample (24 by 18, its members' fill, border at their
line role -- a node's 2px, a panel's 1.5px -- and dash), a kind's 18px glyph in `--text-dim`, and the label in
13px `--text`, wrapped at 220px up to three lines. "Include diagram key" decides whether it is drawn; a drawing
without colour draws none.

**Contrast floors** (WCAG, computed from the tokens by `ui/tests/diagram-palette.test.ts` and
`diagram-palette-render.test.ts`; light / dark where they differ). Neutral node words on the node fill and both
neutral panels ≥ 16 / 14; family words on their fill ≥ 8 (white on the red); family ink on its card and panel ≥ 8;
the neutral caption on both neutral panels ≥ 9.8; node and group borders on the canvas ≥ 4.7 / 4.5 and on any
panel ≥ 4.3 (the light red's fill is its shape, ≥ 9 on any ground); connections on the canvas ≥ 10 / 9.6 and on
any box or panel ≥ 8; selection blue on its fill, any tinted box or panel ≥ 6.8; emphasis hues on any tinted box
≥ 4.26 and on any ground ≥ 4.3; the keyboard ring on every fill ≥ 8; faded words ≥ 4.5 on every faded box and
ground. Contrast is not separability: rendered state combinations (resting, selected, focused, emphasised,
selected and emphasised, walked, faded inside a tinted parent), forced colours and colour-vision simulation are
acceptance checks, on the canvas, SVG, PNG and miniatures.

- **Do** keep most of a drawing neutral; colour is for kinds and authored categories.
- **Do** name every coloured thing in the Key with its members.
- **Don't** draw a family in blue or amber; an authored blue is drawn in the nearest other family.
- **Don't** colour structure: an unclassified group is neutral and passes nothing on.
- **Don't** flood every member of a family with its tint where the group panel already says it.

## Typography

The typeface is Fira Sans (SIL OFL), bundled: 400, 500, 600, 700 and 400 italic, each a latin subset embedded as a
`data:` URI (`ui/src/theme/current-font.css`), for every sans line -- chrome, canvas, notes, the Diagram Key and
SVG/PNG export. The stack is `--font-sans: "Fira Sans", ui-sans-serif, system-ui, sans-serif`;
code, paths and ids take `--font-mono` (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`). Name a
family only through those two tokens, and set a weight only where a face exists.

**The One Tracking Rule.** Sans text is set loose by one token, `--type-tracking: 0.04em`, applied once to every
element (`:where(*)`) so each line tracks in its own em. No rule sets its own `letter-spacing`; the one other value
is `--type-tracking: 0` on a monospace run, so code keeps its grid (`ui/tests/tracking-one-token.test.ts`).

Archer measures diagram text outside the browser, per glyph, from the bundled faces' own advance tables
(`ui/src/layout/fira-metrics.ts`, generated by `ui/scripts/fira-fonts.py`) plus the tracking (`TYPE_TRACKING_EM`),
so a typeface, weight or tracking change is a layout change. The estimate leans wide and is held at or above
what Chromium draws (`ui/tests/browser-ts/text-measure.e2e.ts`).

**Known limitation.** A gallery SVG thumbnail loads nothing, `data:` URLs included, by policy, so it embeds no
face and may draw in the host's fallback. PNG thumbnails and SVG/PNG exports embed and draw in Fira Sans, and an
export refuses without it.

The chrome's ramp, in `rem` so it follows the reader's text size: `--type-floor` 11px (badges, counts, key caps),
`--type-small` 12px (kinds, metadata, secondary controls), `--type-body` 14px (tabs, panel text, buttons),
`--type-title` 17px (sheet and notice headings) and `--type-display` 22px (the one headline an empty page shows).
Nothing the reader needs is set below the floor. Note pages have a separate long-form reading scale
(`--type-reading`, `-heading`, `-title`: 15, 22.5 and 26px) for someone's prose, its section headings and the page
title; chrome on a note page stays on the ramp.

Canvas lettering is measured in pixels and keeps its own sizes, each a token equal to its layout constant:
`--type-canvas-node-title` 18px, `--type-canvas-node-description` 15px, `--type-canvas-node-label` 14px (a figure's
label), `--type-canvas-frame` 14px (a frame's caption, `FRAME_CAPTION_FONT_PX`), `--type-canvas-edge-label` 13px,
`--type-canvas-edge-detail` 11px (a relationship's technology), `--type-canvas-kind` 11px (a node's kind caption),
`--type-canvas-nest-caption` 12px (a closed container's "N inside"), `--type-canvas-participant` 13px (a sequence
participant), `--type-canvas-journey` 13.5px, `--type-canvas-journey-title` 15px, `--type-canvas-journey-detail`
12px, and `--type-canvas-overlay` / `-small` 12 / 11px (the emphasis legend and off-screen cue over the canvas).
Change one only with its constant. Counts and dates use tabular figures.

Secondary copy is regular-weight and muted. It should support the primary label rather than repeat
it, compete through boldness, or shrink below comfortable reading size. Prefer one clear label over
several near-duplicates.

**The One Read Rule.** A control or result should state its purpose once at the strongest useful
level; supporting text adds information rather than paraphrasing the label.

**Titles are Title Case; everything else is sentence case.** Page, panel, dialog, section and table
headings, and the names of surfaces (Diagram Key, Project Review), capitalise every major word.
Buttons, menu items, labels, tooltips and messages stay in sentence case ("Dock diagram key"), as
does a heading written as a question. The side panel names its parts with Title Case headings on the ramp,
never re-cased capitals. The same holds for our demo content: diagram titles and element names are Title Case
("Back Office"), edge labels are not. The page never re-cases a person's own text.
`ui/tests/title-case.test.ts` checks the literal headings.

## Layout

Archer frames a full diagram canvas between the shared rail on the left and the diagram side panel on the right
(Shared application frame), with contextual discussion beside what it discusses. The page must not create
horizontal overflow; a component that needs width manages that overflow within its own boundary.

### Diagram layout

Graphs are laid out by ELK (layered, orthogonal routing), sized from the measured text, so the layout, the canvas
and the export agree on every coordinate.

- **The author's written order leads.** ELK is given nodes, groups and
  edges in the order the source writes them (`sourceOrder`, `writtenOrder`), with model order considered for
  nodes and edges, so a flow reads the way it was written.
- **Loops are broken depth-first** from the first-written source in a flowchart, so "1. Ask" leads and a loop
  back goes up the side. Other notations keep ELK's default.
- **Rhythm**: 32px between layers (`LAYER_GAP`; a one-line captioned hop is about 106px), 56px between nodes,
  32px between a line and a node (40px in C4 and architecture, which reserve a terminal lane for the arrowhead),
  20px between lines, 72px between unconnected components.
- **A route simplifier** (`layout/route-simplify.ts`) then offers each line the simplest shape its ends allow --
  straight, an L, a Z or a U -- and accepts it only when it has fewer corners than now and is collision-free: each
  end stays on its own side of its box, no run enters another box, caption or frame that holds neither end, runs
  along a frame or another line, crosses more lines than before, or loses the arrowhead's straight approach, and
  the label still finds a clear place with line showing either side.
- **Back-edges by side ports**: a line whose target ranks above its source leaves by a side and runs up a lane
  beside the flow into the target's same side -- two corners where the flow's own sides would need four.
- **Line ends are spread along a side**: ends sharing one side of a box are spaced evenly along it, 16px clear of
  its corners, in the order their lines head off so they do not cross; never bunched at one spot.
- Architecture edges keep their declared sides as fixed ports.

### Semantic grouping and responsive sizing

Whitespace expresses relationships. Keep controls within one semantic group close together, and
give distinct groups clearly more separation. Headings visually anchor the controls and content
they describe, including nested subgroups. Do not distribute controls across empty space merely to
fill a container.

Place section dividers immediately below section titles, as in Overview, so the line introduces the
content it governs. Do not box or bracket a whole section when a title-level divider expresses the
hierarchy more clearly.

Size fields and selectors for their likely content and task, then apply responsive maximums and
allow groups to reflow before they become cramped. A large modal or page does not require stretched
inputs. Apply this principle to filters, settings, toolbars, detail panels, and future screens.

### Project discovery

The project browser and search page show every diagram and note of the attached projects in three tabs --
**Folders**, **Diagrams** and **Notes** -- under one search field. A project's own page leads with its title
section and README card. The page's state is its address, so a filtered view is a link and Back returns to where
the reader came from.

- **Folders** is the project's files as a tree: folders with disclosure arrows and indentation only, an aligned
  Title column beside the file names, then kind, threads, edited and created. Headers sort (files within each
  folder) and reorder by their handle.
- **Diagrams** is one uniform card gallery with no folder grouping: as many tracks of at least 250px as fit
  (`repeat(auto-fill, minmax(min(250px, 100%), 1fr))`, one column at phone width), 16px apart. Type chips narrow
  the gallery within the view.
- **Notes** is one flat table, newest edit first; each header sorts by its own kind of value and a second click
  reverses.

Trailing counts and other supplementary footer information keep visible breathing room from the
scrollbar and container edge, including while vertical overflow is active. They should never appear
pressed against the scroll track or clipped by the viewport boundary.

### Search and control rows

The primary search field uses the accepted compact 48px height and remains visually stable. Typing
filters the current scope; Enter or the right-edge magnifying-glass action submits immediately while
preserving filters and sort. Searching does not open a result. Opening a new project or folder starts
unfiltered.

A slider-knobs Filters button is the search field's trailing control, after the magnifying-glass
Search. Use quiet icon or link treatment for navigation, disclosure, and adjacent
utility actions. Icon-only controls share one scale: a 20px glyph (`--icon`) at a 1.5px stroke in a 36px
button (`--icon-button`); an icon beside its word is 16px, a small indicator 14px. Coarse-pointer targets grow
to at least 44px (`--icon-touch`).

## Elevation & Depth

Depth is quiet and structural. Resting content -- nodes, panels, cards -- has no shadow: it is separated by tone,
enclosure and line. Two shadow tokens remain, for temporary layers only: `--shadow-panel` (a popover, a
floating panel, an overlaid side panel or drawer; light `0 2px 10px rgb(15 23 42 / 8%)`, dark
`0 4px 14px rgb(0 0 0 / 24%)`) and `--shadow-modal` (dialogs; light `0 20px 56px rgb(15 23 42 / 20%)`, dark
`0 24px 70px rgb(0 0 0 / 40%)`). Modal scrims always darken (`--scrim`). Glow is reserved for meaningful state:
the selection's glow (`--node-shadow-selected`) and the hover ring (`--node-ring-hover`, a 2px ring) are
interaction state, retuned per theme, not resting depth.

Expanded table details are inset and gently tinted so they read as supporting information attached
to a row. They should remain quieter than the document title and must not resemble a new top-level
card.

**The Quiet Depth Rule.** Resting content is separated by tone and lines, never by shadow; elevation is
reserved for temporary layers, and glow for selection.

## Shapes

Corners are tokens by role (`ui/src/styles.css`): `--radius-mark` 4px (a chip, a swatch, a key cap),
`--radius-control` 6px (a button, a field, a menu row), `--radius-card` 8px (a popover, a panel, a list card),
`--radius-dialog` 12px (a dialog, a sheet, a bubble), `--radius-pill` (badges, status, pins and filter chips
only), `--radius-cluster` (control plus the cluster's 3px inset, so its tiles sit concentric). In the diagram, a
card rounds less than the panel round it: `--radius-node` 12px, `--radius-panel` 16px. A notation's own outline
(a rounded node, a cylinder, a C4 component) is geometry the layout and export share. A button should not look
like a badge.

Line weights are tokens by role too: `--line-chrome` 1px (a divider, a field, a card), `--line-chrome-strong` 2px
(a status frame, a tab's mark, a key cap), `--line-mark` 1.5px (a chevron, a number badge); in the diagram
`--line-node` 1.5px (a card), `--line-node-strong` 2px (a C4 system's card), `--line-boundary` 2px (the outer boundary and element frames), `--line-panel` 1.5px (a
panel inside it), `--line-selected` 2.5px and `--line-emphasis` 3px. Set a weight or a corner through its role
token, not a raw value.

Icons use the existing fine, rounded stroke language. Native disclosure direction and familiar
magnifying-glass, filter, column, note, and document symbols carry meaning without decorative
embellishment.

## Components

Use the real existing controls and production content. No filler diagrams, comments, metadata, or
project descriptions.

### Buttons, links, and fields

- Ordinary commit actions use the established soft tint. The one primary action a panel exists for
  may use accent fill and accent hover treatment.
- Navigation-like text and icon-only utilities remain visually quiet, gaining surface or color on
  hover and a visible accent focus ring.
- Inputs and selects retain a visible border and are sized to their content rather than stretched by
  default.
- Native select chevrons stay visibly inset from the right edge. Reserve enough end padding that
  selected text and the chevron never collide.
- Disabled controls remain legible. Coarse pointers retain at least 44px targets.
- Text links continue to look like links. Pills remain reserved for compact status and identity.

### Diagram cards

- A fixed 16:9 preview (the real exported miniature), a title, a description line and one metadata row.
- The whole card opens the diagram through its one button.
- Keep card density compact and spacing balanced. Do not stretch cards or their contents to consume
  unused page height.

### Folder tree and Notes table

- The folder tree is a treegrid with one roving tab stop over the rows' names; a folder's arrow only opens and
  closes it, its name links to its page, and a file's row opens the file.
- Keep threads, unresolved, edited and created as separate facts; counts and dates use tabular figures.
- Table headers sort their own columns; the folder tree's columns also reorder by their header handle.
- Counts beneath a scrolling body keep clear space from the active scrollbar and the container edge.

### Filters

- The Filters button opens the Project Filters dialog: permanent Order, Files, Discussions and Dates sections.
  On desktop it is bounded to `min(1040px, 100%)` by `min(820px, 100dvh - 48px)`; on phones it fits the viewport
  and becomes one column.
- Filters update the result set live; the dialog does not repeat a "Show N files" action.
- The dialog's internal controls remain task-sized, with more space between semantic groups than within
  them. Numeric operators and ranges use compact controls; date fields keep fieldset and legend grouping.
- The dialog traps focus, closes with Escape, and restores focus to its launcher.

### Project review sidebar

The review sidebar overlays the canvas from the right without narrowing it. Its tabs, actions,
thread grouping, reader/agent rail, selected state, and destructive confirmation keep the existing
role colors and hierarchy. Collapsed threads align to a consistent rhythm; expanded threads continue
the same conversation rail. Motion communicates state only when reduced motion is not requested.

### Docs site top bar

Every page of the documentation site, the landing and each docs page, in both themes, has one top bar: the stage
blue `#34499e` (`--docs-bar`, the owner's R3-2 choice), with a white title, white nav links, a translucent white
search field and the theme switch. The title, search, links and switch sit at the same place and size on every page
at desktop and phone widths, so moving from the landing into the docs changes nothing at the top; on docs pages the
bar spans the sidebar column rather than sizing a title cell to it. The bar never changes colour on scroll. The
current section's link is underlined (2px) as well as named, since every link on the bar is white; focus rings on
the bar are white (8:1). Menus that open from the bar (the "more" menu, the phone menu, the search dialog) use the
page's own surface and colours.

### Docs landing: the film and the install terminal

The docs landing is the one sanctioned exception to the no-window-chrome and no-resting-shadow rules. Under the stage, which continues the top bar's blue (`#34499e`) in both themes, a scripted film sets the same answer side by
side: "Chat alone", the agent's long reply in a terminal window (macOS lights and a title, the answer as real,
selectable text in a scrollable `role="log"`), and "With Archer", a browser window (lights and the Archer address)
around the app's own chrome: crumbs, title, rail, canvas, side panel with the walkthrough and the Diagram Key. Both
windows carry a soft drop shadow on the stage, and the terminal is dark in both themes. A "Scripted example" badge
says it is not live.

What the film shows is only what Archer does. The drawings are the shop example's Mermaid painted by the export
painter (`site/scripts/film-drawings.mts`, checked in as `film-drawings.json`); walkthrough steps light their parts
with the app's own emphasis (current step flowing, earlier steps walked, the rest faded), the follow camera never
draws past the app's own size, the comment is the app's string ("Waiting for the agent's next turn") until the
agent's next turn, and the agent's revision is a highlight in Archer's emphasis, not an invented "changed" mark.
The sequence diagram shows the agent's highlights with their legend, never a walkthrough
(Archer cannot host one there), and the reader zooms in. The Key stays in the side panel (no canvas legend); on a
phone the panel is a sheet under the drawing, so the comment, the wait and the reply stay in the story. It plays
only while the browser window itself is on screen in a visible tab; reduced motion
starts it paused on its first frame, with Play and Pause always offered. Pause stills everything, the terminal's
scroll and the carets included, and a reader in the terminal keeps it where they put it. Its captions are one
reserved cell so the page never moves.

The install terminal below keeps the reader's own frame: macOS Terminal (traffic lights, a title), a GNOME
Terminal/Ptyxis header bar (one round close button), or Windows Terminal (the window's three controls, the active
tab "Ubuntu (WSL)", and a note that Archer runs in WSL on Windows, linking the install guide). The platform is read
after mount; served HTML, no script, phones and anything unknown get a neutral frame. Every variant has one bar
height, and every note shares one reserved line, so neither the frame nor the method moves the page. The npx and
curl choices are the window's tabs (one tablist, arrow keys, the shared remembered choice). The command is the whole
command in the page; only the long release address in its middle is drawn as "…/", and the note says the copy
button copies the full command. A click anywhere in the body copies it, and the Copy button stays for the keyboard
and screen readers, with the result announced. The terminal is dark in both themes, with its own custom properties and
the film's soft shadow; the window furniture is `aria-hidden` decoration. Under it, one line offers
`install.sh` to read before piping and the install guide.

## Do's and Don'ts

### Do

- **Do** let architecture artifacts and real project content lead the composition.
- **Do** use spacing, headings, and bounded control widths to make semantic groups obvious.
- **Do** keep compact surfaces balanced rather than stretching them to fill available space.
- **Do** use the established palette when color improves differentiation.
- **Do** keep reader selection, keyboard focus, agent emphasis, and unresolved state distinct.
- **Do** carry every color meaning in a second channel and preserve meaning under reduced motion.
- **Do** set corners, line weights, type sizes and tracking through their role tokens, and change a canvas
  size only together with its layout constant.
- **Do** use native keyboard order and familiar control behavior, with visible focus and no
  page-level horizontal overflow.

### Don't

- **Don't** add decorative imagery, placeholder diagrams, or invented project content.
- **Don't** repeat labels, counts, or actions when one clear expression is enough.
- **Don't** make every control the same width or spread controls across a container to fill it.
- **Don't** turn navigation, disclosure, or icon utilities into visually heavy raised buttons.
- **Don't** put a shadow on resting content (nodes, panels, cards), on the page or in exports; the docs landing's
  film windows and install terminal are the one sanctioned exception (see Components).
- **Don't** mark a card, row, callout or panel with a coloured side stripe; colour a whole outline or fill,
  or use a word.
- **Don't** put a plate behind an edge label, or a legend inside the drawing on the canvas.
- **Don't** draw operating-system window chrome (title bars, traffic lights, window controls) around content; the
  docs landing's film and install terminal are the one sanctioned exception (see Components).
- **Don't** set `letter-spacing` outside the one tracking token.
- **Don't** hide activity distinctions by combining Total and Unresolved or by using color alone.
- **Don't** promote surface-specific implementation mechanics, cache limits, test history, or
  temporary review state into the durable design system.
