// perf: a ~200-edit editing session (flowchart then sequence: add, rename, connect/draw, undo),
// sampling JS heap, DOM nodes and listeners in the page and heap/RSS in the service every 20 edits,
// with heap snapshots before and after (forced GC). Output dir: $PERF_OUT (default /tmp).
import { writeFileSync, mkdirSync } from "node:fs";
import { KNOWN } from "../flowchart-create.mjs";
export const meta = {
  name: "perf-memory-session",
  invariants: {
    ...KNOWN,
    "duplicate-requests": { severity: "warn", reason: "known" },
    "requests-per-view": { severity: "warn", reason: "known" },
    "label-focus": { severity: "warn", reason: "known" },
  },
};

export default async ({ ui, step, page }) => {
  const out = process.env.PERF_OUT ?? "/tmp";
  mkdirSync(out, { recursive: true });
  const origin = new URL(page.url() === "about:blank" ? "http://x" : page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const samples = [];
  let edits = 0;
  // Health is open to a loopback peer; metrics need the service token (security round 1, D-1).
  const svc = async (o) => {
    try {
      const r = await fetch(o + "/-/debug/health");
      const h = await r.json();
      return h.heapUsedMb === undefined ? null : { heapUsedMb: h.heapUsedMb, rssMb: h.rssMb };
    } catch {
      return null;
    }
  };
  const sample = async (label) => {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const o = new URL(page.url()).origin;
    samples.push({
      label,
      edits,
      at: Date.now(),
      heapMb: +(m.JSHeapUsedSize / 1048576).toFixed(2),
      nodes: m.Nodes,
      listeners: m.JSEventListeners,
      documents: m.Documents,
      service: await svc(o),
    });
    writeFileSync(`${out}/memory-samples.json`, JSON.stringify(samples, null, 2));
  };
  const snapshot = async (name) => {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const chunks = [];
    const h = (e) => chunks.push(e.chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", h);
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
    cdp.off("HeapProfiler.addHeapSnapshotChunk", h);
    writeFileSync(`${out}/${name}.heapsnapshot`, chunks.join(""));
  };
  const edit = async (fn) => {
    const r = await fn();
    edits++;
    if (edits % 20 === 0) await sample(`edit ${edits}`);
    return r;
  };

  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/flow.mmd");
  await ui.enterEdit();
  await sample("flow edit start");
  await step("heap snapshot before", () => snapshot("before"));
  for (let i = 0; i < 25; i++) {
    const id = await edit(() => ui.addPart("Process", { name: `N${i}` }));
    await edit(() => ui.rename(id, `Renamed ${i}`));
    await edit(() => ui.connect("a", id));
    await edit(() => ui.undo());
  }
  await ui.cancel({ discard: true });
  await sample("flow cancelled");
  await ui.openDiagram("journeys", "diagrams/seq.mmd");
  await ui.enterEdit();
  await sample("seq edit start");
  for (let i = 0; i < 25; i++) {
    const m = await edit(() => ui.seq.drawMessage("c", "s", { label: `m${i}` }));
    await edit(() => ui.rename(m, `msg ${i}`));
    await edit(() => ui.undo());
    await edit(() => ui.seq.drawMessage("s", "d", { label: `k${i}` }));
  }
  await ui.cancel({ discard: true });
  await sample("seq cancelled");
  // Back to where the "before" snapshot was taken, so the comparison is like for like.
  await ui.openDiagram("journeys", "diagrams/flow.mmd");
  await ui.enterEdit();
  await sample("flow edit again");
  await step("heap snapshot after", () => snapshot("after"));
};
