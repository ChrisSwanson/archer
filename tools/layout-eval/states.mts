/**
 * PROTOTYPE screen-state eval: is a framed diagram readable on a laptop at the type floor, not just "fitted"?
 *
 * Shrinking a whole drawing to fit puts captions far below a legible size (library-pricing: 5.8 px on a 1440x900
 * laptop; Legge & Bigelow 2011 put fluent reading well above that). Archer already has the answer for frames: the
 * nested view collapses a frame into one box and opens it on demand. So each framed diagram is measured, with the
 * shipped engine and fresh layouts (`canonical-fresh`, as `archer measure` does), in these states:
 *
 *   - full: everything drawn;
 *   - collapsed: every frame closed (the overview);
 *   - open:<frame>: one top-level frame opened, the others closed (what a reader sees after one click).
 *
 * A state is READABLE when it fits the screen's drawing area with captions at or above the floor; PANNABLE when it
 * needs panning along one axis only at the floor. The laptop answer for a diagram is good when the overview is
 * readable and every single-frame state is readable or pannable along one axis.
 *
 *   cd ui && ../node_modules/.bin/tsx ../tools/layout-eval/states.mts [--only a,b] [--screen 1200x740] [--svg-dir d]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { computeLayout } from "../../ui/src/layout/elk-adapter";
import { nestView } from "../../ui/src/nesting/nest-view";
import { viewOfSource } from "../../ui/tests/route-metrics";
import { measure, overlaySvg } from "./report.mts";
import { CORPUS } from "./corpus.mts";

const FLOOR_PX = 11;
const LABEL_PX = 13;
const GUTTER = 24;

const { values } = parseArgs({
  options: { only: { type: "string" }, screen: { type: "string", default: "1200x740" }, "svg-dir": { type: "string" } },
});
const [sw, sh] = values.screen!.split("x").map(Number) as [number, number];
const screen = { width: sw, height: sh };
const names = values.only ? values.only.split(",") : Object.keys(CORPUS);

type StateRow = {
  diagram: string;
  state: string;
  width: number;
  height: number;
  labelPxAtFit: number;
  readable: boolean;
  /** At the floor's zoom, how many screens it spans each way. */
  screensAtFloor: { x: number; y: number };
  pannable: boolean;
  needless: number;
  crossings: number;
  junctionLoad: number;
  valid: boolean;
  score: number;
};

const rows: StateRow[] = [];
for (const name of names) {
  const full = await viewOfSource(readFileSync(CORPUS[name]!, "utf8"), name);
  if (full.groups.length === 0) continue;
  const topLevel = full.groups.filter((g) => g.parentId === undefined).map((g) => g.id);
  const states: [string, readonly string[] | null][] = [
    ["full", null],
    ["collapsed", []],
    ...topLevel.map((id) => [`open:${id}`, [id]] as [string, readonly string[]]),
  ];
  for (const [state, open] of states) {
    const view = open === null ? full : nestView(full, open).view;
    const layout = await computeLayout(view);
    const r = measure(`${name} ${state}`, layout, screen);
    const floorZoom = FLOOR_PX / LABEL_PX;
    const x = Math.round(((r.size.width * floorZoom) / (screen.width - 2 * GUTTER)) * 100) / 100;
    const y = Math.round(((r.size.height * floorZoom) / (screen.height - 2 * GUTTER)) * 100) / 100;
    rows.push({
      diagram: name,
      state,
      width: r.size.width,
      height: r.size.height,
      labelPxAtFit: r.labelPxAtFit,
      readable: r.labelPxAtFit >= FLOOR_PX,
      screensAtFloor: { x, y },
      pannable: x <= 1 || y <= 1,
      needless: r.excessBends,
      crossings: r.crossings,
      junctionLoad: r.congestion.junctionLoad,
      valid: r.valid,
      score: r.score,
    });
    if (values["svg-dir"]) {
      mkdirSync(values["svg-dir"], { recursive: true });
      writeFileSync(
        `${values["svg-dir"]}/${name}.${state.replace(":", "-")}.svg`,
        overlaySvg(layout, r, `${name} · ${state}`),
      );
    }
  }
}

console.log(`screen ${screen.width}x${screen.height}, floor ${FLOOR_PX}px`);
console.log(
  [
    "diagram".padEnd(15),
    "state".padEnd(22),
    "size".padEnd(10),
    "labels",
    "readable",
    "screens@floor",
    "needless",
    "cross",
    "knots",
    "score",
  ].join(" "),
);
for (const r of rows)
  console.log(
    [
      r.diagram.padEnd(15),
      r.state.padEnd(22),
      `${r.width}x${r.height}`.padEnd(10),
      `${r.labelPxAtFit}px`.padEnd(6),
      (r.readable ? "yes" : r.pannable ? "pan 1 axis" : "NO").padEnd(8),
      `${r.screensAtFloor.x} x ${r.screensAtFloor.y}`.padEnd(13),
      String(r.needless).padEnd(8),
      String(r.crossings).padEnd(5),
      String(r.junctionLoad).padEnd(5),
      `${r.score}${r.valid ? "" : " INVALID"}`,
    ].join(" "),
  );
console.log("\nlaptop answer per framed diagram (overview readable; every one-frame state readable or one-axis pan):");
for (const d of [...new Set(rows.map((r) => r.diagram))]) {
  const of = rows.filter((r) => r.diagram === d);
  const overview = of.find((r) => r.state === "collapsed")!;
  const singles = of.filter((r) => r.state.startsWith("open:"));
  const fullState = of.find((r) => r.state === "full")!;
  const good = overview.readable && singles.every((r) => r.readable || r.pannable);
  console.log(
    `  ${d.padEnd(15)} full ${fullState.readable ? "readable" : `${fullState.labelPxAtFit}px`}  overview ${overview.readable ? "readable" : `${overview.labelPxAtFit}px`}  one-frame states ${singles.filter((r) => r.readable).length}/${singles.length} readable, ${singles.filter((r) => !r.readable && r.pannable).length} pan  => ${good ? "GOOD" : "NOT YET"}`,
  );
}
const HERE = new URL(".", import.meta.url).pathname;
writeFileSync(`${HERE}states-run.json`, JSON.stringify({ screen, rows }, null, 1));
