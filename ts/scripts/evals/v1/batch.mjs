// Runs and judges a matrix of v1 small-agent evals, a few at a time, then writes summary.md.
//
//   node ts/scripts/evals/v1/batch.mjs --install <home> --out <dir> [--agents haiku,sol,luna] [--tasks a,b] [--reps 2] [--from 1] [--jobs 5] [--port 47200]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENTS, runOne } from "./run.mjs";
import { judgeRun, summarize } from "./judge.mjs";
import { TASKS } from "./tasks.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["install", "out", "agents", "tasks", "reps", "from", "jobs", "port"].map((k) => [k, { type: "string" }]),
  ),
});
const install = resolve(values.install),
  out = resolve(values.out);
const agents = (values.agents ?? Object.keys(AGENTS).join(",")).split(",");
const tasks = (values.tasks ?? TASKS.map((t) => t.id).join(",")).split(",");
const from = Number(values.from ?? 1),
  reps = Number(values.reps ?? 2);
const jobs = [];
for (let rep = from; rep < from + reps; rep++)
  for (const task of tasks) for (const agent of agents) jobs.push({ agent, task, rep });
let next = 0,
  port = Number(values.port ?? 21200); // below the ephemeral range, which outgoing connections take
const worker = async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const myPort = port++;
    try {
      const dir = await runOne({ install, out, ...job, port: myPort });
      const j = judgeRun(dir, install);
      console.log(
        `${j.agent} ${j.task} ${j.rep}: ${j.verdict} calls=${j.toolCalls} archer=${j.archerCalls} ${j.checks
          .filter((c) => !c.pass)
          .map((c) => `✗ ${c.name}`)
          .join("; ")}`,
      );
    } catch (error) {
      console.log(`${job.agent} ${job.task} r${job.rep}: ERROR ${error.message}`);
    }
  }
};
await Promise.all(Array.from({ length: Number(values.jobs ?? 5) }, worker));
writeFileSync(join(out, "summary.md"), summarize(out));
console.log(join(out, "summary.md"));
