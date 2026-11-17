# UI/UX contract

How Archer's page behaves for keyboard, touch, low-vision and screen-reader users. Every UI change
follows it. The look (palette, type ramp, spacing, components) is [`DESIGN.md`](DESIGN.md); the
product's principles are [`PRODUCT.md`](PRODUCT.md). Open defects are tracked as issues.

Each rule comes from a defect a person hit; where it helps, the defect follows the rule in italics.

## How to apply it

- **One root cause, one fix.** Fix the shared primitive (the keymap, `useCoveredInert`, the coarse
  target rule, the focus reveal), not each cell it fails in. Group findings into one row per root cause
  before fixing anything; one `inert` rule cleared the covered stops at every width.
- **A shared fix makes new edge cases; look for them.** `inert` on covered controls (pass 1) left
  scroll regions exposed; inerting those (pass 2) inerted a focused node. After a
  shared change, rerun the walk at every width, not only the one that failed.

## Input alternatives and keys

- **Every drag action has a keyboard path and a single-pointer path.** Graph nodes: Alt+arrow nudges
  10 px (Alt+Shift+arrow 50 px), and Move selected then a click places; Escape cancels; one Undo reverts
  a nudge run. *Positioning was drag-only. WCAG 2.1.1, 2.5.7; never waived.*
- **Single-character shortcuts fire only while their region has focus, or the person can switch them
  off.** Archer has the switch: Settings → Keyboard → Single-character shortcuts; it persists, and Help
  says when it is off. *`1` reset the zoom with focus on Notifications. WCAG 2.1.4.*
- **A `role="toolbar"` roves:** one Tab stop, arrows and Home/End move, disabled tools are skipped,
  Tab leaves. Don't claim a role whose keys you don't implement.
- **Menus use the shared keys:** arrows wrap, Home/End reveal the chosen item, Escape dismisses
  and restores the invoking context; Tab/Shift+Tab leave without restoring it. Loading items never
  steal focus or reset the active item. A menuitem performs one operation for pointer, keyboard and
  touch. Element menus are named **Actions for {element}**: Comment first when allowed, then
  title rows under Open Diagram that navigate once. Type, Proposed status and a short visible
  description are associated with `aria-describedby`, separately from the authored title's name.
  Descriptions never depend on hover or native tooltips. **Details and additions…** opens the
  nonmodal diagram-panel content slot (phone dock sheet), retains the Key, and restores prior
  content when closed. Full descriptions, Inside first, explicit Preview/Add/Open, refusal reasons
  and source cues remain available there. Preview persists across focus moving to Add and clears
  on another preview, Add, dismissal or navigation; touch uses explicit 44×44 controls.
- **A key pressed during a transition is queued per drawing, never globally.** `1` (Fit) pressed while a
  diagram or the editor opens applies once it is ready; navigating to any other drawing drops it, and
  a pan made since wins. *Fit was lost while opening; `1` on a project listing fitted a diagram
  opened 3 s later, and `1` then `]` fitted the next one.*

## Focus and covering surfaces

- **Anything a surface covers leaves the Tab order through `inert`**, decided by geometry
  (`useCoveredInert`). Every surface that lies over the page (the review, Export, Diagram accuracy,
  Compare, the phone Chat sheet) is listed in `COVERS` in `WebShell.tsx`; a new one joins it. Inert the
  covered scroll container or column header as a whole, not only the controls inside it.
  *Tab reached 5 controls under the review panel; axe `scrollable-region-focusable`,
  `empty-table-header`; Zoom, Fit and Source wholly under the accuracy panel; Chat was left out.
  WCAG 2.4.11.*
- **No covering surface is modal.** Panels and sheets sit beside live content and never trap focus;
  closing one returns focus to its launcher.
- **A hover-expanded surface folds when keyboard focus moves under it.** *The rail, widened by a
  resting pointer, covered the focused Zoom in.*
- **Headings stay exposed.** Never inert the page `h1`; the page keeps its level-one heading while a
  sheet covers it. *Axe `page-has-heading-one`.*
- **Never inert the element that has focus.** Reveal it, or move focus first. *At 390 a canvas node
  panned under the review sheet, was inerted 8 ms later, and focus fell to `<body>`.*
- **The focus pan moves the focused node or edge clear of every occluder:** the side panel, key,
  review sheet and compare panel, using the rendered geometry (SVG bounds for edges). Diagram content
  is never inerted to dodge this; the person must reach it. *Nodes, then an edge, sat behind the key
  at 1000×800; compare covered the zoom controls on phones.*
- **Two panels never cover each other's controls, and chrome never covers the drawing.** The
  connection panel avoids Source and the chat button (`panel-place.ts`); Edit sits in the status row.
  *The panel covered Mermaid source and the chat button covered Delete, which also timed out two
  harness journeys; Journey Source sat under Graph tools.*
- **A review keeps its draft and focus when it moves between hosts** (sidebar spot to panel): move
  the same DOM node, never remount. Verify `sameNode` and `sameFocus` across the move.

## Targets and touch

- **Coarse pointers get 44×44 on controls**, in both dimensions; an `::after` hit area counts only if
  it reaches 44. Inline prose links are exempt (DESIGN.md: "Text links continue to look like links");
  a focus-only metadata span or a disabled control is not a target. *Folder disclosure 28×44, Show all
  203×26.*
- **Fine pointers get 24 px or the spacing exception.** Widen a thin control's hit area with a
  transparent pseudo-element and keep the drawn line thin. *The 11 px panel divider.*
- **A control on the drawing keeps its on-screen size at every zoom it shows,** and the layout reserves
  that on-screen box: counter-scale it, or hide it below the zoom where it fits, as the frame "−" does.
  *A 44 px hit area scaled with the drawing to about 20 px after Fit.*
- **A tap on a parked control isn't eaten by an outside-pointerdown handler**, and the click that
  follows a touch never lands on what the tap just opened. Test it with real touch
  (`hasTouch`, `page.touchscreen.tap`), not a mouse click. *Tapping parked Chat opened it, then the
  click hit Collapse.*

## Framing and legibility

- **A diagram opens readable; Fit shows all of it.** The opening framing keeps labels at or above the
  reading floor and the off-screen cues point to the rest. Fit view and `1` show the whole drawing, as
  Show all does, even when labels get small: someone who asks to fit wants to see it all and zooms in
  to read. Fixed small lettering (node-kind eyebrow, emphasis markers) is at least `--type-floor` (11 px).
  *A floor on Fit stopped it short beside the docked key, which read as Fit ignoring the key.*
  *Labels at 5.6–8.9 px after Fit.*
- **Wires and plates keep off captions, other plates and toggles.** Layout reserves frame captions,
  edge-label plates (at their rendered width) and the "−" as obstacles; a collision found after
  layout gets a targeted repair of that wire, not a relayout. Check every zoom the drawing shows.
  *A wire through "Pageturner Online Booksho|p"; a wire under a detail plate.*
- **Only type tokens are used:** the chrome ramp (`--type-floor` … `--type-display`), the reading scale
  (`--type-reading*`, note pages only) and the canvas lettering tokens, whose layout px constants are
  tested equal to them. Inputs `font: inherit`. Any other size needs an approved exception.
  *21 off-scale sizes, a 30 px headline, 13.33 px inputs.*
- **Icons use the icon size and stroke tokens** (`--icon` 14/16/20, 1.5 stroke, `non-scaling-stroke` on
  24-unit viewBoxes); the text "×" is the shared close glyph. The logo is not an icon.
  *12×12 locks with a 1.3 stroke; 19 off-scale glyphs in one census.*
- **Text survives 200% text and the 1.4.12 spacing overrides.** Size columns by content or `rem`,
  let cells wrap, size badges in `em`. *The file table's dates collided and clipped.*

## Contrast and emphasis

- **Dimmed text keeps 4.5:1.** Fade the shape, not the words (`--text-faded`). *Off-path text at
  2.03:1.*
- **Off-path strokes, fills and borders may fade below 3:1** during a walkthrough step or emphasis;
  on-path graphics may not. Disabled controls may be faint. Nothing else is excepted.
- **Every other meaningful graphic keeps 3:1 at its rendered opacity:** group borders, flow lines
  (`--flow-line-opacity`), sequence lifelines. *Group border 2.09:1, flow line at 50%; light
  lifeline 2.98:1.*
- **Pressed and selected carry a ≥ 3:1 cue besides the fill.** One shared rule gives every pressed or
  selected control an `--accent` edge; a new pressed control joins that rule, not a local style. A
  segmented control has one border per segment, the pressed segment's border is the frame, and its
  ends share the group's radius. A selected edge takes the accent stroke at a heavier width.
  *Pressed by `--accent-fill` alone, 1.16:1 light / 1.35:1 dark; the editor tools missed the shared
  rule; a selected edge was React Flow grey, 1.37:1.*
- **Focus is drawn at full strength, apart from what it marks.** A ring never inherits a faded
  element's opacity, and on a pressed segment it is an outer ring offset 2 px from the accent edge.
  *A dimmed edge's ring at 0.25 opacity, 1.69:1; light edge glow 2.84:1.* Placeholders use a token,
  not the browser grey (*#757575, 4.03:1*).
- **Fix contrast; don't `exclude()` it.** An axe exclusion needs an approved, recorded exception.
  *Eight walkthrough `exclude()` calls hid the off-path text failure.*
- **Every page sets its own background and colour tokens**, including service-rendered pages.
  *The access page had none, so axe read #9e9eff on white in dark.*

## Motion

- **Under reduced motion, nothing transitions**, chrome hovers included; state changes are instant.
  *Theme hover ran colour transitions under OS reduce.*
- **Flow emphasis honours its preference:** Off, and Auto under reduce, park the packet and keep
  direction in the static chevrons. On under reduce animates by the person's explicit choice.

## Phone layout

Phones are best-effort for v1. These rules still hold.

- **The location stays readable at 320.** The breadcrumb collapses to "… / current" with a whole-path
  control; it never shrinks crumbs to stubs. Metadata ("Committed …") takes its own row.
  *Crumbs 2–5 px wide; "autl" under "Committed 41m ago".*
- **A bottom sheet parks floating controls above it, never over or under them.** *The dock sheet
  covered Chat and Highlights.*
- **Cards and notices flow and wrap at 320**; none overlays its own heading. *The compile-error
  card.*

## Help and keymap truth

- **Help is generated from the same keymap table as dispatch**, per surface and mode. `KEYMAP` in
  `ui/src/app/shortcuts.ts` does this for the character keys; extend it rather than add a second list. A key that a mode disables is not listed in that mode. *Help while
  editing listed `C`, ⌘A and Enter, but the editing handler ignored them; the `/edit` route listed no
  keys at all.*

## Status and announcements

- **The mode is named in text**, not only by colour or outline: EXPLORE, Editing, Step n of m.
  *Plain Explore had no text.*
- **Titles are Title Case and the accessible name is the visible title**; controls, labels and
  messages stay sentence case (`DESIGN.md`). *Three sentence-case titles built from expressions; the
  Help dialog named "Keyboard shortcuts" under "Keyboard & Pointer".*
- **One control per action in a region.** *Settings had a header Close and a footer Close.*
- Status messages announced exactly once are not yet verified; a screen-reader pass with Orca
  and Firefox is pending. Add rules here when it reports.

## Names and semantics in diagrams

- **Whole sequence blocks are comment targets, separate from selection.** With comments available, `alt`, `opt`,
  `loop` and `par` headers are named controls (for example, “alt block: ready”). Tab reaches headers; focused
  C, Enter, Space, the context-menu key or Shift+F10 opens the whole-block composer. Ordinary header click opens the same composer. Right-click or long press
  the header/border does the same. Child messages retain click priority; activations and individual
  branches gain no selection or comment identity. Editor block picking keeps its existing meaning.
- **Sequence notes are comment targets only.** With comments available, each sheet has a named button
  stating its text and participants. Click, C, Enter, Space, context-menu key/Shift+F10, right-click and
  touch long press open its composer. Pins sit on the note; the About picker and Project Review name
  it consistently. Show on diagram reveals the note without selecting it. Notes remain outside
  published selection, presentation focus and emphasis. Editing retains its separate note picking.
  Unique unchanged annotations retain their comments through insertion/reordering; missing, changed
  or ambiguous notes retain their discussion with recovery guidance and no positional pin. A changed
  diagram while composing keeps the words and requires reopening the intended note.
- **Discussions use the clear workspace.** Attached cards avoid docked panels, the Diagram Key and canvas controls; panel/card resize and camera movement recompute placement. Constrained cards scroll internally. Covered chrome cannot receive keyboard focus.
- **Phone notes open on the content.** The outline starts collapsed at phone widths; its native disclosure remains available by keyboard and touch.
- **Block pins belong at the header.** Project Review opens and reveals that header without publishing a
  fragment selection. A block that cannot be identified safely retains its discussion with recovery guidance,
  without a positional pin or focus on a different block. If the diagram changes while a block comment is being
  written, keep the text and require reopening the intended block before adding it.

- **Accessible names carry every fact the drawing shows.** ER relationships name both multiplicities
  and identifying status; sequence messages name their kind (call, reply, async), activation and
  `alt` branch; a nested element names its container ("in Fulfilment").
- **A role or kind shown by a picture is also said in words.** If a node's role is drawn as an icon
  (person, system, external), its accessible name states the role, and its visible text sits outside the
  shape, because an image cell can't hold text. Undefined `:::class` tags with no `classDef` are not
  facts.

## How to check

The procedure is the [`archer-ui-verification` skill](.agents/skills/archer-ui-verification/SKILL.md).
The collectors live in `tools/devkit/harness/`, each proven on a known pass and a known fail:
the sweep (`ui/tests/browser-ts/a11y-sweep.e2e.ts`), `targets.mjs`, `focus-walk.mjs`,
`motion.mjs`, `contrast.mjs`, `labels.mjs`, `tokens.mjs`, and `zoom.mjs` (400% reflow, 200% text
fallback).
