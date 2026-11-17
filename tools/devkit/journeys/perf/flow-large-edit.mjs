// perf: the 150-node flowchart in the editor (ledger smoke-a#3): open in edit, move one node, add a part,
// rename it. Each step's wall time is in summary.json (steps[].ms); main-thread busy time per step is printed
// as NOTE lines: the page's own JavaScript (a CPU profile split by harness/cpu.mjs: what the harness's probes cost
// is left out) and its top functions. Run alone, on a quiet host for numbers that compare.
import { KNOWN } from "../flowchart-create.mjs";
import { splitProfile } from "../../harness/cpu.mjs";
export const meta = {
  name: "perf-flow-large-edit",
  invariants: {
    ...KNOWN,
    "duplicate-requests": { severity: "warn", reason: "measured, not gated" },
    "requests-per-view": { severity: "warn", reason: "measured, not gated" },
  },
  timeoutMs: 300000,
};

export default async ({ ui, page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  const timed = async (label, fn) => {
    const t0 = Date.now();
    await cdp.send("Profiler.start");
    const r = await fn();
    const { profile } = await cdp.send("Profiler.stop");
    const split = splitProfile(profile, new URL(page.url()).origin);
    console.log(
      `NOTE ${label}: ${Date.now() - t0} ms wall, ${Math.round(split.appMs)} ms page JS, ${Math.round(split.harnessMs)} ms harness; top: ${split.topApp.slice(0, 4).join("; ")}`,
    );
    return r;
  };
  await ui.resetProject("awkward");
  await timed("open in edit", () => ui.openDiagram("awkward", "diagrams/flow-large.mmd", { edit: true }));
  const first = await page.locator(".react-flow__node:not(.react-flow__node-group)").first().getAttribute("data-id");
  await timed("move one node", () => ui.moveNode(first, 40, 60));
  const id = await timed("add a part", () => ui.addPart("Process"));
  if (id !== undefined) await timed("rename it", () => ui.rename(id, "Measured"));
  await timed("move it again", () => ui.moveNode(first, -40, -60));
  await ui.cancel({ discard: true });
};
