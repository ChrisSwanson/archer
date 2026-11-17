// Slice 2 of the nested view (docs/proposals/ws-b-boundary-zoom.md §4): how far a plain ELK
// relayout per open set moves what the person did not touch. Real diagrams from this repository,
// compiled and laid out by the production pipeline (`computeLayout`), one `+` at a time.
//
// Acceptance, per transition O → O ∪ {g}:
//   (a) ≥ 95% of pairs of untouched boxes keep their left/right and above/below order (no swap,
//       centres compared with an 8 px tolerance; the opened box and every frame are left out);
//   (b) the toggled box's centre moves ≤ 25% of the viewport's shorter side, with the camera
//       fitting the whole graph (phone 390×844 and desktop 1440×900; zoom capped at 1).
// A measurement, not a gate: it runs only with NEST_STABILITY=1 (about 2 min), and writes its
// tables to $NEST_STABILITY_REPORT. Results and the decision they led to: proposal §4.
//
// The camera model is simpler than the page's framing (`viewport-fit.ts` also clamps to a reading
// size); it is what a fit-to-view without that clamp would show.

import { writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutResult } from "../src/layout/elk-layout";
import { canonicalOpen, nestView } from "../src/nesting/nest-view";
import type { NestProfile } from "../src/nesting/profile";
import { stagedFirstMs } from "./support/nest-strategies";
import {
  boxes,
  closeOut,
  layOut,
  quality,
  STRATEGIES,
  viewOf,
  type Box,
  type Laid,
  type Quality,
  type Strategy,
} from "./support/nest-strategies";

const SOURCES = [
  "ts/test/fixtures/c4/nested.mmd",
  "ts/test/fixtures/c4/widened.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/c4-boundaries.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/state-composite.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/arch-awkward.mmd",
  ".archer/diagrams/overview/runtime-topology.mmd",
  ".archer/diagrams/service/application-components.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/flow-large.mmd",
];
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const ORDER_BOUND = 0.95;
const MOVE_BOUND = 0.25;
const TOLERANCE_PX = 8;

const centre = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function sign(delta: number): number {
  return delta > TOLERANCE_PX ? 1 : delta < -TOLERANCE_PX ? -1 : 0;
}

function orderKept(
  before: Map<string, Box>,
  after: Map<string, Box>,
  ids: readonly string[],
): { kept: number; pairs: number } {
  // Tolerance in layout units (CSS px at zoom 1).
  let kept = 0;
  let pairs = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a0, b0, a1, b1] = [
        before.get(ids[i]!)!,
        before.get(ids[j]!)!,
        after.get(ids[i]!)!,
        after.get(ids[j]!)!,
      ].map(centre);
      pairs++;
      // Orthogonal order (Misue et al.) is broken by a swap: left of becomes right of, above becomes below.
      const swapped = (d0: number, d1: number) => sign(d0) * sign(d1) === -1;
      if (!swapped(a0!.x - b0!.x, a1!.x - b1!.x) && !swapped(a0!.y - b0!.y, a1!.y - b1!.y)) kept++;
    }
  }
  return { kept, pairs };
}

/** Where a point lands on screen when the camera fits the whole graph (zoom ≤ 1). */
function onScreen(point: { x: number; y: number }, layout: LayoutResult, viewport: { width: number; height: number }) {
  const zoom = Math.min(1, viewport.width / layout.width, viewport.height / layout.height);
  return {
    x: viewport.width / 2 + (point.x - layout.width / 2) * zoom,
    y: viewport.height / 2 + (point.y - layout.height / 2) * zoom,
  };
}

type Row = {
  strategy: Strategy;
  diagram: string;
  elements: number;
  from: string;
  opened: string;
  /** Kept share of pairs; undefined when fewer than two untouched elements (N/A). */
  order: number | undefined;
  pairs: number;
  inversions: number;
  move: Record<string, number>;
  /** Positive control: the seeded layout differs from the plain one for the same transition. */
  differs: boolean;
  ms: number;
  quality: Quality;
  /** Phone zoom of the layout after the press. */
  zoom: number;
  parts?: { inner: number; route: number };
  profile?: NestProfile;
  /** grow2 only: the staged API's first picture, measured on its own (cold). */
  firstMs?: number;
};
const rows: Row[] = [];
/** Closing grow2's open again by compaction, against the layout it was opened from. */
type CloseRow = {
  strategy: Strategy;
  plates: number;
  enclosure: number;
  profile?: NestProfile;
  diagram: string;
  elements: number;
  recorded: boolean;
  ms: number;
  drift: number;
  order: number | undefined;
  area: number;
  crossings: number;
  beforeCrossings: number;
  sound: boolean;
};
const closeRows: CloseRow[] = [];
/** Phone zoom when nothing is open: a nested layout of its own vs the full layout it could be cut from. */
const spaceRows: { diagram: string; nested: number; full: number }[] = [];
const phoneZoom = (layout: LayoutResult) =>
  Math.min(1, VIEWPORTS[0].width / layout.width, VIEWPORTS[0].height / layout.height);

const measuring = process.env.NEST_STABILITY === "1";

/*
 * Paired: one navigation history per diagram (plain relayout, each open set laid out once and
 * cached, as the page will), and for each press every strategy starts from that SAME layout.
 * Order is measured over the same population for every strategy: the drawn nodes (boxes) both
 * layouts have, but the one opened; frames are left out (a frame that grows moves its centre
 * without reordering anything in it).
 */
describe.skipIf(!measuring).each(SOURCES)("%s", (path) => {
  test("opening one level at a time, every strategy from the same layout", async () => {
    const full = await viewOf(path);
    const history = new Map<string, Laid>();
    const remembered = async (open: readonly string[], from?: Laid): Promise<Laid> => {
      const key = open.join(",");
      if (!history.has(key)) history.set(key, await layOut(full, open, "plain", from));
      return history.get(key)!;
    };
    // Breadth-first over reachable open sets, at most 12 presses per diagram.
    const queue: string[][] = [[]];
    const seen = new Set<string>([""]);
    let transitions = 0;
    while (queue.length > 0 && transitions < 12) {
      const open = queue.shift()!;
      const nested = nestView(full, open);
      for (const [groupId, box] of nested.closed) {
        if (transitions >= 12) break;
        const next = canonicalOpen(full, [...open, groupId]);
        const before = await remembered(open);
        const plainAfter = await remembered(next, before);
        const b0 = boxes(before.layout, before.view);
        const nodeIds = new Set(before.layout.nodes.map((n) => n.id));
        for (const strategy of STRATEGIES) {
          const after = strategy === "plain" ? plainAfter : await layOut(full, next, strategy, before, groupId);
          const b1 = boxes(after.layout, after.view);
          const untouched = [...nodeIds].filter((id) => id !== box.drawnId && b1.has(id));
          const { kept, pairs } = orderKept(b0, b1, untouched);
          const move: Record<string, number> = {};
          for (const viewport of VIEWPORTS) {
            const p0 = onScreen(centre(b0.get(box.drawnId)!), before.layout, viewport);
            const p1 = onScreen(centre(b1.get(box.drawnId)!), after.layout, viewport);
            move[viewport.name] = Math.hypot(p1.x - p0.x, p1.y - p0.y) / Math.min(viewport.width, viewport.height);
          }
          const plainBoxes = boxes(plainAfter.layout, plainAfter.view);
          const differs = [...b1].some(([id, b]) => {
            const p = plainBoxes.get(id);
            return p === undefined || Math.abs(p.x - b.x) > 1 || Math.abs(p.y - b.y) > 1;
          });
          if (strategy === "grow2" || strategy === "grow2b") {
            for (const forget of [false, true]) {
              const closed = await closeOut(full, open, after, groupId, forget, strategy === "grow2b");
              const b2 = boxes(closed.layout, closed.view);
              const ids = untouched.filter((id) => b2.has(id));
              const deltas = ids.map((id) => ({
                x: centre(b2.get(id)!).x - centre(b0.get(id)!).x,
                y: centre(b2.get(id)!).y - centre(b0.get(id)!).y,
              }));
              const mean = deltas.reduce(
                (m, d) => ({ x: m.x + d.x / Math.max(1, deltas.length), y: m.y + d.y / Math.max(1, deltas.length) }),
                { x: 0, y: 0 },
              );
              const kept = orderKept(b1, b2, ids);
              const q = quality(closed.layout, closed.view);
              closeRows.push({
                diagram: path.split("/").pop()!,
                elements: full.nodes.length + full.groups.length,
                recorded: !forget,
                strategy,
                plates: q.plateFaults,
                enclosure: q.enclosureFaults,
                ...(closed.profile === undefined ? {} : { profile: closed.profile }),
                ms: closed.ms,
                drift:
                  deltas.reduce((sum, d) => sum + Math.hypot(d.x - mean.x, d.y - mean.y), 0) /
                  Math.max(1, deltas.length),
                order: kept.pairs === 0 ? undefined : kept.kept / kept.pairs,
                area: (closed.layout.width * closed.layout.height) / (before.layout.width * before.layout.height),
                crossings: q.crossings,
                beforeCrossings: quality(before.layout, before.view).crossings,
                sound: q.throughBoxes === 0 && q.frameFaults === 0 && q.missing === 0,
              });
            }
          }
          rows.push({
            strategy,
            diagram: path.split("/").pop()!,
            elements: full.nodes.length + full.groups.length,
            from: open.join(",") || "∅",
            opened: groupId,
            order: pairs === 0 ? undefined : kept / pairs,
            pairs,
            inversions: pairs - kept,
            move,
            differs,
            ms: after.ms,
            quality: quality(after.layout, after.view),
            zoom: phoneZoom(after.layout),
            ...(after.parts === undefined ? {} : { parts: after.parts }),
            ...(after.profile === undefined ? {} : { profile: after.profile }),
            ...(strategy === "grow2" || strategy === "grow2b"
              ? { firstMs: await stagedFirstMs(full, next, before, groupId, strategy === "grow2b") }
              : {}),
          });
        }
        transitions++;
        const key = next.join(",");
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(next);
        }
      }
    }
    const top = await remembered([]);
    const all = await computeLayout(full);
    spaceRows.push({ diagram: path.split("/").pop()!, nested: phoneZoom(top.layout), full: phoneZoom(all) });
    expect(transitions).toBeGreaterThan(0);
  }, 300_000);
});

test.skipIf(!measuring)("report", () => {
  const out = process.env.NEST_STABILITY_REPORT;
  const pct = (value: number | undefined) => (value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`);
  const lines = [
    "| strategy | diagram | elements | from | opened | order kept | inversions / pairs | move phone | move desktop | differs from plain | layout ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.strategy} | ${r.diagram} | ${r.elements} | ${r.from} | ${r.opened} | ${pct(r.order)} | ${r.inversions}/${r.pairs} | ${pct(r.move.phone)} | ${pct(r.move.desktop)} | ${r.differs ? "yes" : "no"} | ${r.ms.toFixed(0)} |`,
    ),
  ];
  const within = (r: Row) =>
    (r.order === undefined || r.order >= ORDER_BOUND) && Object.values(r.move).every((m) => m <= MOVE_BOUND);
  const summary = STRATEGIES.map((strategy) => {
    const mine = rows.filter((r) => r.strategy === strategy);
    const rated = mine.filter((r) => r.order !== undefined);
    const orderOk = rated.filter((r) => r.order! >= ORDER_BOUND).length;
    const moveOk = mine.filter((r) => Object.values(r.move).every((m) => m <= MOVE_BOUND)).length;
    const inversions = mine.reduce((sum, r) => sum + r.inversions, 0);
    const pairs = mine.reduce((sum, r) => sum + r.pairs, 0);
    const differs = mine.filter((r) => r.differs).length;
    return `| ${strategy} | ${mine.filter(within).length}/${mine.length} | ${orderOk}/${rated.length} | ${moveOk}/${mine.length} | ${inversions}/${pairs} (${((inversions / pairs) * 100).toFixed(1)}%) | ${differs}/${mine.length} |`;
  });
  const space = [
    "| diagram | phone zoom, nothing open (own layout) | phone zoom, cut from the full layout |",
    "|---|---|---|",
    ...spaceRows.map((r) => `| ${r.diagram} | ${(r.nested * 100).toFixed(0)}% | ${(r.full * 100).toFixed(0)}% |`),
    "",
  ];
  const qualityRows = STRATEGIES.map((strategy) => {
    const mine = rows.filter((r) => r.strategy === strategy);
    const sum = (f: (q: Quality) => number) => mine.reduce((total, r) => total + f(r.quality), 0);
    const edges = sum((q) => q.edges);
    const large = mine.filter((r) => r.elements > 100);
    const small = mine.filter((r) => r.elements <= 100);
    const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((x, y) => x + y, 0) / values.length);
    return `| ${strategy} | ${(sum((q) => q.crossings) / mine.length).toFixed(1)} | ${(sum((q) => q.overlaps) / mine.length).toFixed(1)} | ${sum((q) => q.frameFaults)} | ${sum((q) => q.plateFaults)} | ${sum((q) => q.enclosureFaults)} | ${(mean(large.map((r) => r.quality.crossings))).toFixed(1)} | ${mean(small.map((r) => r.quality.crossings)).toFixed(2)} | ${mean(small.map((r) => r.quality.overlaps)).toFixed(2)} | ${(sum((q) => q.bends) / edges).toFixed(2)} | ${sum((q) => q.throughBoxes)} | ${sum((q) => q.missing)} | ${sum((q) => q.nonOrthogonal)} | ${(sum((q) => q.length) / edges).toFixed(0)} | ${(mean(mine.map((r) => r.zoom)) * 100).toFixed(0)}% | ${mean(mine.map((r) => r.ms)).toFixed(0)} | ${mean(large.map((r) => r.ms)).toFixed(0)} |`;
  });
  const grown2 = rows.filter((r) => r.parts !== undefined && r.strategy === "grow2");
  const split2 = (filter: (r: Row) => boolean) => {
    const mine = grown2.filter(filter);
    const avg = (f: (r: Row) => number) =>
      (mine.length === 0 ? 0 : mine.reduce((t, r) => t + f(r), 0) / mine.length).toFixed(0);
    return `inner layout ${avg((r) => r.parts!.inner)} ms, routing ${avg((r) => r.parts!.route)} ms, the rest ${avg((r) => r.ms - r.parts!.inner - r.parts!.route)} ms`;
  };
  const timing = [
    `Grow in place v2, mean per press: ${split2(() => true)}; on the 156-node diagram: ${split2((r) => r.elements > 100)}.`,
    "",
  ];
  const closeTable = (["grow2", "grow2b"] as const)
    .flatMap((strategy) => [true, false].map((recorded) => [strategy, recorded] as const))
    .map(([strategy, recorded]) => {
      const mine = closeRows.filter((r) => r.recorded === recorded && r.strategy === strategy);
      const avg = (f: (r: CloseRow) => number, of = mine) =>
        of.length === 0 ? 0 : of.reduce((t, r) => t + f(r), 0) / of.length;
      const rated = mine.filter((r) => r.order !== undefined);
      return `| ${strategy}, ${recorded ? "with the open's record" : "no record (deep link)"} | ${mine.reduce((t, r) => t + r.plates, 0)} | ${mine.reduce((t, r) => t + r.enclosure, 0)} | ${mine.length} | ${rated.filter((r) => r.order === 1).length}/${rated.length} | ${mine.filter((r) => r.sound).length}/${mine.length} | ${avg((r) => r.drift).toFixed(1)} | ${(avg((r) => r.area) * 100).toFixed(0)}% | ${avg((r) => r.crossings).toFixed(1)} vs ${avg((r) => r.beforeCrossings).toFixed(1)} | ${avg((r) => r.ms).toFixed(0)} | ${avg(
        (r) => r.ms,
        mine.filter((r) => r.elements > 100),
      ).toFixed(0)} |`;
    });
  const closing = [
    "Closing again (each grower's open, closed by compaction), against the layout it was opened from:",
    "",
    "| close | plates on a frame edge, box or plate | frames not enclosing | presses | order kept vs the open layout | sound (no wire through a box or frame, none missing) | boxes off where they were (px, mean, after removing a common shift) | area vs before | crossings vs before | ms | ms, 156-node |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...closeTable,
    "",
  ];
  const qualityTable = [
    ...timing,
    "| strategy | crossings per press | overlapping segments per press | frame faults (all presses) | label plates on a frame edge, box or plate (all presses) | frames not enclosing their contents (all presses) | crossings per press, 156-node | crossings per press, ≤ 23 elements | overlapping segments per press, ≤ 23 elements | bends per wire | wires through a box (all presses) | wires with no route | wires not orthogonal | length per wire | phone zoom after | ms per press (warm) | ms per press, 156-node |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...qualityRows,
    "",
  ];
  // grow2's phases (ms) and work counters, typical (mean) and worst (max total), per group of presses.
  const SPANS = ["inner", "placement", "stretch", "route", "grid", "search", "nudge", "labels", "compaction"];
  const COUNTS = [
    "grid.points",
    "router.calls",
    "search.calls",
    "search.expanded",
    "wires.routed",
    "wires.kept",
    "checks.stretch",
    "compaction.tests",
  ];
  const phaseRow = (label: string, mine: { ms: number; profile?: NestProfile }[]) => {
    const withProfile = mine.filter((r) => r.profile !== undefined);
    if (withProfile.length === 0) return `| ${label} | 0 |${" |".repeat(SPANS.length + COUNTS.length + 3)}`;
    const mean = (f: (r: (typeof withProfile)[number]) => number) =>
      withProfile.reduce((t, r) => t + f(r), 0) / withProfile.length;
    const worst = withProfile.reduce((w, r) => (r.ms > w.ms ? r : w));
    const cell = (f: (r: (typeof withProfile)[number]) => number, digits = 0) =>
      `${mean(f).toFixed(digits)} / ${f(worst).toFixed(digits)}`;
    const spanOf = (r: (typeof withProfile)[number], k: string) => r.profile!.spans[k] ?? 0;
    // Derived estimates: their own mean / max over the presses (not the worst-total press's value).
    const spread = (f: (r: (typeof withProfile)[number]) => number) =>
      `${mean(f).toFixed(0)} / ${Math.max(...withProfile.map(f)).toFixed(0)}`;
    return `| ${label} | ${withProfile.length} | ${cell((r) => r.ms)} | ${spread((r) => r.ms - spanOf(r, "route"))} | ${spread((r) => r.ms - spanOf(r, "inner"))} | ${SPANS.map((k) => cell((r) => r.profile!.spans[k] ?? 0)).join(" | ")} | ${COUNTS.map((k) => cell((r) => r.profile!.counts[k] ?? 0)).join(" | ")} |`;
  };
  const g2 = rows.filter((r) => r.strategy === "grow2");
  const g2b = rows.filter((r) => r.strategy === "grow2b");
  const phases = [
    "grow2 phases, typical / worst press (mean / the press with the largest total). Spans in ms; grid, search and nudge are inside route; counters are work done, independent of host load.",
    "",
    `| presses | n | total ms | first picture ms, estimate (total − route; mean / max) | inside prepared ms, estimate (total − inner; mean / max) | ${SPANS.join(" | ")} | ${COUNTS.join(" | ")} |`,
    `|---|---|---|---|---|${"---|".repeat(SPANS.length + COUNTS.length)}`,
    phaseRow(
      "open, ≤ 23 elements",
      g2.filter((r) => r.elements <= 100),
    ),
    phaseRow(
      "open, 156-node",
      g2.filter((r) => r.elements > 100),
    ),
    phaseRow(
      "close (recorded), ≤ 23 elements",
      closeRows.filter((r) => r.strategy === "grow2" && r.recorded && r.elements <= 100),
    ),
    phaseRow(
      "close (recorded), 156-node",
      closeRows.filter((r) => r.strategy === "grow2" && r.recorded && r.elements > 100),
    ),
    phaseRow(
      "grow2b open, ≤ 23 elements",
      g2b.filter((r) => r.elements <= 100),
    ),
    phaseRow(
      "grow2b open, 156-node",
      g2b.filter((r) => r.elements > 100),
    ),
    phaseRow(
      "grow2b close (recorded), ≤ 23 elements",
      closeRows.filter((r) => r.strategy === "grow2b" && r.recorded && r.elements <= 100),
    ),
    phaseRow(
      "grow2b close (recorded), 156-node",
      closeRows.filter((r) => r.strategy === "grow2b" && r.recorded && r.elements > 100),
    ),
    "",
  ];
  const firstOf = (mine: Row[]) => {
    const values = mine.map((r) => r.firstMs ?? 0);
    return values.length === 0
      ? "—"
      : `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(0)} / ${Math.max(...values).toFixed(0)}`;
  };
  phases.push(
    `Staged first picture (\`growInPlaceV2Staged\`, measured on its own, cold; mean / max): grow2 ≤ 23 elements ${firstOf(g2.filter((r) => r.elements <= 100))} ms, 156-node ${firstOf(g2.filter((r) => r.elements > 100))} ms; grow2b ≤ 23 elements ${firstOf(g2b.filter((r) => r.elements <= 100))} ms, 156-node ${firstOf(g2b.filter((r) => r.elements > 100))} ms.`,
    "",
  );
  const head = [
    ...space,
    ...phases,
    ...qualityTable,
    ...closing,
    "| strategy | within both bounds | order ≥ 95% (rated) | move ≤ 25% | inversions / pairs | differs from plain |",
    "|---|---|---|---|---|---|",
    ...summary,
    "",
  ];
  if (out !== undefined) writeFileSync(out, `${[...head, ...lines].join("\n")}\n`);
  expect(rows.length).toBeGreaterThan(0);
});
