# Layout eval (prototype)

A standard yardstick for **Archer's layout engine**: does a change draw the same diagrams more readably on the
screens people use? It tests the tool, not the author. Every diagram is laid out exactly as written, frames included,
so a variant can only score better by drawing the same diagram better.

Run from `ui/` (module resolution):

```sh
cd ui
../node_modules/.bin/tsx ../tools/layout-eval/eval.mts                      # every variant over the corpus
../node_modules/.bin/tsx ../tools/layout-eval/eval.mts --variants baseline,best-of --svg-dir /tmp/overlays
../node_modules/.bin/tsx ../tools/layout-eval/eval.mts --variants baseline --save-baseline
../node_modules/.bin/tsx ../tools/layout-eval/report.mts some.mmd --suggest --svg out.svg   # one diagram, agent-facing
../node_modules/.bin/tsx ../tools/layout-eval/states.mts                    # framed diagrams: full, collapsed, one frame open
```

## Pieces

| File | Role |
|---|---|
| `report.mts` | The calculator: lays a diagram out with the product pipeline and measures it; the debug overlay SVG; the agent-facing text report with measured, frame-preserving source suggestions. |
| `eval.mts` | Corpus × screens × engine variants. Prints per-diagram rows with deltas against `baseline.json` and per-variant totals; writes `last-run.json`. |
| `states.mts` | Screen states of framed diagrams (full, collapsed overview, each top-level frame opened alone), each judged readable at the 11 px floor on the laptop, pannable along one axis, or neither. |
| `corpus.mts` | The fixed corpus. |
| `variants.mts` | Engine variants, injected through the `LayoutEngine` seam `computeLayout` already takes. No product code is edited. |
| `corpus/` | Diagrams that are not already in the repo's fixtures (`library-pricing.mmd`). The rest of the corpus is the `route-bends` fixtures. |
| `gallery.mts` | Scores every round of a blind-author run (used for the first model comparison). |

## Metrics

- **Needless bends**: corners beyond the fewest a wire's two ends allow (`ui/tests/route-metrics.ts`). It is an
  obstacle-free lower bound, so it does not prove each counted corner can be removed.
- **Worst wire**, **crossings**, **wires through boxes**, **caption collisions** (a caption on a box, or crossed by
  another wire), **ends against the flow**, **frame-border crossings beyond nesting**.
- **Screen fit** on three drawing areas: the Archer canvas (1025×896, `DESKTOP_PROFILE`), a 1440×900 laptop
  (1200×740 after chrome) and a 1920×1080 desktop (1600×900). Reported as the fit zoom and the caption size at that
  zoom, against the 11 px type floor. Primary screen: the laptop.
- **Congestion (a heuristic: no published local-congestion metric matches it, and it is not validated with users)**:
  junctions (120 px windows with at least 6 different wires and 6 corners plus crossings, merged), junction load,
  tight runs (parallel runs of different wires closer than 6 px on the target screen, exact overlaps included),
  short jogs (a jog too short to show its rounded corners on screen) and ambiguous turns (a corner within 8 screen
  px of another wire's corner or crossing).
- **Validity**: a wire through a box or any caption collision (on a box, crossed by a wire, or on another caption)
  makes a drawing INVALID whatever its score; `best-of` never picks one, and failures are reported, not skipped.
- **Score**: 100 minus weighted penalties (needless bends 30, screen fit 20, crossings 15, worst wire 10, junction
  load 10, tight runs 5, overlaps 5, flow 5). The weights are uncalibrated guesses; deltas against the baseline
  matter more than the score. Known gaps: congestion windows are in layout, not
  screen, pixels; no path-task metrics yet; "against the flow" counts perpendicular arrivals that are not backward.

## What the measurements showed

- ELK option changes (node placement, thoroughness, spacing, compaction, label layers) never beat the shipped
  pipeline across the corpus.
- Rerouting cross-frame wires with the nested view's router (`ui/src/nesting/ortho-router.ts`) helps diagrams with
  frames: deployment +16, containers +7, home-rig +7. On `library-pricing` it trades bends for crossings.
- `best-of` (lay out several ways and keep the best candidate that adds no crossing or caption collision) raises the
  corpus mean from 81.1 to 85.8 with no regressions, but leaves `library-pricing` unchanged.
- `library-pricing` is limited by placement, not routing. Captions each take their own layer, which makes it
  2593 px wide, and 11 wires from two directions converge on the left face of the SDK's library column. Placing
  captions at the head end cut needless bends 46 → 26 and width by 9%, but Archer's caption placement then collides.

## Evidence behind the direction

- Highlighting a node's connections is the best-supported aid for tracing through clutter (Ware & Bobrow 2004, 2005).
  Archer now draws a hovered or selected node's own connections in the accent (`ATTACHED_EDGE_CLASS`).
- Uniformly shrinking to fit is not defensible: 6 px captions are below letter acuity (Legge & Bigelow 2011). The
  collapsed overview of every framed diagram in the corpus is readable at 11 px on a laptop (`states.mts`).
- In orthogonal drawings crossings are all 90 degrees and matter less than bends, edge length and continuity (Purchase
  1997; Ware et al. 2002; Pohl, Schmitt & Diehl 2009). Curves, chamfers and octilinear corners have no support for
  graphs (Xu et al. 2012; Purchase et al. 2012); corner radius is unstudied. libavoid is not in elkjs; ELK wrapping
  has open bugs with labelled edges and hierarchy (eclipse-elk/elk #1079, #1084).
