// One named press of the nested view, repeated, for profiling (`profile-nest.mjs` runs this under
// `node --cpu-prof --import tsx`). Setup (compile, the layout it opens from) happens once first, so
// the profile is dominated by the press itself.
//
//   node --import tsx scripts/profile-nest-run.mts <diagram> <open> [from,from] [--strategy grow2] [--repeat 10] [--close]
//
// Prints each run's time, then the last run's spans, counters and route quality as JSON.

import { canonicalOpen } from "../src/nesting/nest-view";
import { closeOut, layOut, quality, viewOf, type Strategy } from "../tests/support/nest-strategies";

const options = new Map<string, string>();
const positional: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--close") options.set("close", "yes");
  else if (arg.startsWith("--")) options.set(arg.slice(2), argv[++i] ?? "");
  else positional.push(arg);
}
const flag = (name: string, fallback: string) => options.get(name) ?? fallback;
const [diagram, opened, fromList] = positional;
if (diagram === undefined || opened === undefined) {
  console.error("usage: profile-nest-run.mts <diagram> <open> [from,from] [--strategy grow2] [--repeat 10] [--close]");
  process.exit(2);
}
const strategy = flag("strategy", "grow2") as Strategy;
const repeat = Number(flag("repeat", "10"));
const closing = options.has("close");

const full = await viewOf(diagram);
const from = fromList === undefined || fromList === "" ? [] : fromList.split(",");
const before = await layOut(full, from, "plain");
const next = canonicalOpen(full, [...from, opened]);
const times: number[] = [];
/** CPU time per run (user + system): far steadier than wall time on a shared, loaded host. */
const cpu: number[] = [];
let last: Awaited<ReturnType<typeof layOut>> | undefined;
// A close measures only the close: the open it undoes is laid out once, before the runs.
const grownOnce = closing ? await layOut(full, next, strategy, before, opened) : undefined;
for (let run = 0; run < repeat; run++) {
  const used = process.cpuUsage();
  last =
    grownOnce !== undefined
      ? await closeOut(full, from, grownOnce, opened)
      : await layOut(full, next, strategy, before, opened);
  times.push(last.ms);
  const spent = process.cpuUsage(used);
  cpu.push((spent.user + spent.system) / 1000);
}
const sorted = [...times].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      press: `${diagram} ${from.join(",") || "∅"} ${closing ? "−" : "+"}${opened}`,
      strategy,
      runs: times.map((t) => Math.round(t)),
      median: Math.round(sorted[Math.floor(sorted.length / 2)]!),
      cpu: cpu.map((t) => Math.round(t)),
      cpuMedian: Math.round([...cpu].sort((a, b) => a - b)[Math.floor(cpu.length / 2)]!),
      spans: Object.fromEntries(
        Object.entries(last?.profile?.spans ?? {}).map(([k, v]) => [k, Math.round(v * 10) / 10]),
      ),
      counts: last?.profile?.counts ?? {},
      quality: last === undefined ? undefined : quality(last.layout),
    },
    null,
    1,
  ),
);
