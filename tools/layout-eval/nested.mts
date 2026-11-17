/**
 * PROTOTYPE: measure what the NESTED view draws (ADR 0029), not just a fresh layout. The page starts from the collapsed
 * overview (ELK) and grows each opened frame in place, keeping every other box where it was, then routes the wires
 * with Archer's own router. A diagram a reader opens frame by frame is drawn by that path, so the eval must see it.
 *
 *   cd ui && ../node_modules/.bin/tsx ../tools/layout-eval/nested.mts <file.mmd> [--svg-dir d]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { computeLayout } from "../../ui/src/layout/elk-adapter";
import { NestEngine } from "../../ui/src/nesting/nest-engine";
import { DEFAULT_TYPEFACE } from "../../ui/src/layout/text-measure";
import { viewOfSource } from "../../ui/tests/route-metrics";
import { measure, overlaySvg } from "./report.mts";
const { default: ELK } = await import("elkjs/lib/elk.bundled.js");

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "svg-dir": { type: "string" } } });
for (const file of positionals) {
  const name = file
    .split("/")
    .pop()!
    .replace(/\.mmd$/, "");
  const full = await viewOfSource(readFileSync(file, "utf8"), name);
  if (full.groups.length === 0) continue;
  console.log(name);
  const session = { full, typeface: DEFAULT_TYPEFACE, revision: "eval" };
  const all = full.groups.map((g) => g.id);
  const screen = { width: 1200, height: 740 };
  const line = (label: string, l: Parameters<typeof measure>[1]) => {
    const r = measure(label, l, screen);
    console.log(
      `${label.padEnd(44)} bends ${String(r.bends).padEnd(3)} needless ${String(r.excessBends).padEnd(3)} pair-lines-bent ${String(r.bentPairLines).padEnd(2)} cross ${String(r.crossings).padEnd(3)} knots ${String(r.congestion.junctionLoad).padEnd(3)} ${r.size.width}x${r.size.height} ${r.valid ? "" : "INVALID"}`,
    );
    if (values["svg-dir"]) {
      mkdirSync(values["svg-dir"], { recursive: true });
      writeFileSync(
        `${values["svg-dir"]}/${name}.${label.replace(/[^a-z0-9]+/gi, "-")}.svg`,
        overlaySvg(l, r, `${name} · ${label}`),
      );
    }
  };
  line("fresh layout, everything open", await computeLayout(full));
  async function pressInTurn(order: readonly string[], label: string) {
    const nest = new NestEngine({ kernel: new ELK() });
    const key = nest.open(session);
    await nest.layout(key, []).complete;
    let open: string[] = [];
    let last;
    for (const g of order) {
      const from = open;
      open = [...open, g];
      last = await nest.layout(key, open, { from, toggled: g }).complete;
    }
    line(label, last!);
  }
  // One frame at a time, as a reader pressing each "+" in turn would; two orders, to see whether presses matter.
  await pressInTurn(all, "nested: opened one by one (written order)");
  await pressInTurn([...all].reverse(), "nested: opened one by one (reverse order)");
  {
    const nest = new NestEngine({ kernel: new ELK() });
    const key = nest.open(session);
    line("nested: deep link with every frame open", await nest.layout(key, all).complete);
  }
}
