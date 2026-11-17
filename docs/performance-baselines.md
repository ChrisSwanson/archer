# Performance baselines

How long the page's layout passes take at 10, 100 and 1000 elements, measured once on one machine
and checked in with the command that reproduces them. The Rust parser, compile and validation
baselines that used to be here went with that implementation and are not in this tree.

## What these numbers are for

Two things.

- **Catching an order-of-magnitude regression.** If laying out a 1000-element sequence takes
  60 ms instead of 6 ms, something is wrong, and it is wrong on any machine.
- **Catching super-linear behaviour.** Every table gives the time *per element* at each size. A pass
  that costs time in proportion to its input holds that figure steady as the input grows; one that
  does not, climbs. That reading does not depend on the machine at all.

They are **not** for micro-optimisation, and not for comparing two commits that differ by ten
percent. Other builds were running when they were taken, under heavy host load, so individual
figures are good to about ±25%. Nothing here is a budget, and
no test asserts on any of it.

The bench never runs in CI. A shared runner with several jobs per host times nothing reliably.

## The machine, the date, the code

| | |
|---|---|
| Date | 2026-10-01 |
| Code | a 0.2.x development build (the commit that added the benches) |
| Machine | a mid-range Linux (amd64) desktop |
| Node | v20.19.2, elkjs 0.11.1, modules loaded through Vite 8.1.5 |

CI runs Node 24, and a browser is not Node. Treat the layout figures as the same order of magnitude
as what a user sees.

## Commands

```sh
# UI: ELK layout in each direction, the sequence layout, and group nesting.
npm run bench:ui

# The nesting rows below go deeper than the default; this is how.
ARCHER_BENCH_NESTING=8,24,64,256,1000,2000,4000 npm run bench:ui
```

The script prints the median of up to fifty runs.

`elements` counts everything with an identity: nodes, edges and groups in a graph (about 45%, 45%
and 10%), or participants, messages, fragments and notes in a trace. Both shapes are built in
`ui/bench/layout-bench.mjs`.

## Layout

`npm run bench:ui`. ELK is the graph layout; the sequence layout is Archer's own.

| Layout                 | Elements | Median   | Per element |
|------------------------|---------:|---------:|------------:|
| graph (ELK), `tb`      |       10 |  16.7 ms |     1.67 ms |
| graph (ELK), `tb`      |      100 |   235 ms |     2.35 ms |
| graph (ELK), `tb`      |     1000 |  4.09 s  |     4.09 ms |
| graph (ELK), `bt`      |       10 |  15.9 ms |     1.59 ms |
| graph (ELK), `bt`      |      100 |   250 ms |     2.50 ms |
| graph (ELK), `bt`      |     1000 |  3.95 s  |     3.95 ms |
| graph (ELK), `lr`      |       10 |  16.4 ms |     1.64 ms |
| graph (ELK), `lr`      |      100 |   240 ms |     2.40 ms |
| graph (ELK), `lr`      |     1000 |  3.44 s  |     3.44 ms |
| graph (ELK), `rl`      |       10 |  11.9 ms |     1.19 ms |
| graph (ELK), `rl`      |      100 |   204 ms |     2.04 ms |
| graph (ELK), `rl`      |     1000 |  3.37 s  |     3.37 ms |
| sequence               |       10 |  0.17 ms |       17 µs |
| sequence               |      100 |  0.87 ms |      8.7 µs |
| sequence               |     1000 |  5.82 ms |      5.8 µs |

Direction makes no difference worth the name. The sequence layout is linear and three orders of
magnitude cheaper than ELK.

**ELK is mildly super-linear.** The cost per element roughly doubles between 10 and 1000 elements,
which is the `n log n` of a layered layout with crossing minimisation. That is ELK's, not ours, and
it is the number to remember. A 1000-element graph takes three to four seconds to lay out, and it
runs on the page's main thread. A diagram that size is far outside what Archer is for, but nothing
refuses one.

## Where the cost is not linear

Each of these was measured at sizes well past a real diagram, so that the curve is visible.

### Nested subgraphs in the layout (quadratic, then a stack overflow; now bounded)

A chain of groups, each inside the last, around two nodes.

| Nested groups | Median  |
|--------------:|--------:|
|             8 |   21 ms |
|            24 |   54 ms |
|            64 |  120 ms |
|           256 |  591 ms |
|          1000 |  5.11 s |
|          2000 |  16.4 s |
|          4000 | `RangeError: Maximum call stack size exceeded` |

Linear up to a few hundred, quadratic beyond, and at 4000 ELK's recursion exhausts the JavaScript
stack. Subgraph nesting used to have no bound, so one `.mmd` file could do this to the page. The
parser now refuses a source nested more than 24 deep with `subgraph_nesting_too_deep`
(`MAX_NESTING_DEPTH` in `ts/src/mermaid/limits.ts`).

### The sequence layout's column pass (linear in practice)

The horizontal pass widens every gap a message crosses, so its worst case is messages × lifelines.
With 1000 messages each sent from the first lifeline to the last:

| Lifelines | Median  |
|----------:|--------:|
|        10 | 5.64 ms |
|       100 | 6.09 ms |
|      1000 | 10.1 ms |

A hundred times the lifelines costs less than twice the time. The inner loop is a few additions,
and a million of them take a few milliseconds.
