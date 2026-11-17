// perf (rubric docs/quality/rubrics/performance.md S5, S4): frame pacing on the 150-node flowchart
// (awkward/diagrams/flow-large.mmd). Pan (middle-button drag on the empty canvas) and zoom (Ctrl+wheel) on the reading
// page, then a node drag in the editor, discarded with Cancel → Discard (nothing is saved; the journey checks that
// no editor write was sent). During each gesture the page records requestAnimationFrame timestamps; the output is the
// frame-interval p95 per gesture and the long animation frames (LoAF, > 50 ms) in that gesture's window, plus one
// click on the empty canvas (interaction-latency, failing over 200 ms: the G7 band).
//
//   node tools/devkit/harness/smoke.mjs --sandbox <name> --journey tools/devkit/journeys/perf/canvas-pan.mjs
//
// Output: $PERF_OUT/canvas-pan.json (default: the run directory), schema archer-canvas-pan/1, and one NOTE line per
// gesture. Seeded faults, to prove the collectors (PERF_SEED_FAULT):
//   jank        a 120 ms busy loop in a rAF callback, four times during each gesture: long frames, a raised p95
//   slow-click  a click listener that busy-waits 300 ms: the canvas click fails interaction-latency
// The interaction steps (enter edit, add part, Cancel) also report their long frames (claude-11: the gesture windows
// alone hid them). PERF_TRACE_STEPS=enter-edit[,add-part,cancel] records a Chrome trace of those steps
// ($PERF_OUT/trace-<step>.json, token values redacted) and explains each long frame from it: the main thread's time
// by class before renderStart and after, and the workers' load (tools/perf/lib/trace.mjs; codex-10's 107.7 ms
// scriptless frame on entering the editor). Tracing costs main-thread time: a traced step's frame timings are for
// diagnosis, not for the S5 comparison.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameIntervals, loafSummary, p95 } from "../../../perf/lib/vitals.mjs";
import { STEP_TRACE_CATEGORIES, clockOffset, frameBreakdown, markThread } from "../../../perf/lib/trace.mjs";

export const meta = {
  name: "perf-canvas-pan",
  invariants: {
    "interaction-latency": { failAtMs: 200 },
    // Measured, not gated here: the 150-node page is over the per-view request cap on purpose.
    "requests-per-view": { severity: "warn", reason: "measured, not gated" },
  },
  timeoutMs: 120_000,
  // Playwright's DOM snapshots and the entry screenshots cost main-thread time on every action: measuring, so off.
  traceSnapshots: false,
  entryShots: false,
};

const FAULT = process.env.PERF_SEED_FAULT ?? "";
const FRAMES = 40; // pointer moves per gesture, one per ~16 ms

export default async ({ ui, step, page, sandbox, run }) => {
  const out = process.env.PERF_OUT ?? run.dir;
  mkdirSync(out, { recursive: true });
  const writes = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/authoring$/.test(new URL(r.url()).pathname)) writes.push(r.url());
  });

  /** An empty point of the graph canvas (the pane, no node or edge under it). */
  const emptyPoint = () =>
    page.evaluate(() => {
      const c = document.querySelector(".react-flow")?.getBoundingClientRect();
      if (!c) return null;
      for (let fy = 0.85; fy >= 0.15; fy -= 0.05)
        for (let fx = 0.15; fx <= 0.85; fx += 0.05) {
          const x = c.x + c.width * fx,
            y = c.y + c.height * fy,
            el = document.elementFromPoint(x, y);
          if (el?.classList.contains("react-flow__pane")) return { x, y };
        }
      return null;
    });
  const transform = () => page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform ?? null);
  /** Start recording rAF timestamps (and, with the jank fault, queue the busy frames). */
  const startFrames = (jank) =>
    page.evaluate((jank) => {
      const rec = (window.__canvasPan = { ts: [], on: true, from: performance.now() });
      const tick = (t) => {
        if (!rec.on) return;
        rec.ts.push(t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      if (jank)
        for (let i = 1; i <= 4; i++)
          setTimeout(
            () =>
              requestAnimationFrame(() => {
                const end = performance.now() + 120;
                while (performance.now() < end) {
                  /* seeded fault: a busy frame */
                }
              }),
            i * 150,
          );
    }, jank);
  const stopFrames = async () => {
    await page.evaluate(() => window.__perfLab?.flush?.());
    return page.evaluate(() => {
      const rec = window.__canvasPan;
      rec.on = false;
      return { ts: rec.ts, from: rec.from, to: performance.now(), loaf: window.__perfLab?.loaf ?? null };
    });
  };
  const results = {};
  const measure = (name, gesture) =>
    step(
      `${name} (frame pacing)`,
      async () => {
        const before = await transform();
        await startFrames(FAULT === "jank");
        await gesture();
        const rec = await stopFrames();
        const intervals = frameIntervals(rec.ts);
        const loaf = rec.loaf === null ? null : loafSummary(rec.loaf, { fromMs: rec.from, toMs: rec.to });
        const moved = name === "node drag" ? null : (await transform()) !== before;
        results[name] = {
          frames: rec.ts.length,
          windowMs: Math.round(rec.to - rec.from),
          p95IntervalMs: p95(intervals) === null ? null : Math.round(p95(intervals) * 10) / 10,
          maxIntervalMs: intervals.length ? Math.round(Math.max(...intervals) * 10) / 10 : null,
          ...(moved === null ? {} : { viewportMoved: moved }),
          loaf:
            loaf === null
              ? "NOT EVALUATED: no long-frame record for the step"
              : {
                  count: loaf.count,
                  blockingMs: loaf.blockingMs,
                  longestMs: loaf.longestMs,
                  unattributed: loaf.unattributed,
                  attributed: loaf.frames
                    .filter((f) => f.attributed)
                    .map((f) => ({ startTime: f.startTime, duration: f.duration, scripts: f.scripts.slice(0, 3) })),
                },
        };
        if (moved === false) throw new Error(`${name}: the viewport did not move`);
        const r = results[name];
        console.log(
          `NOTE ${name}: ${r.frames} frames in ${r.windowMs} ms, interval p95 ${r.p95IntervalMs} ms (max ${r.maxIntervalMs}), long frames ${loaf?.count ?? "?"} (${loaf?.blockingMs ?? "?"} ms blocking, ${loaf?.unattributed.length ?? "?"} unattributed)`,
        );
      },
      { interaction: true },
    );
  const TRACE = new Set(
    (process.env.PERF_TRACE_STEPS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const steps = {};
  /** An interaction step's long frames, and with PERF_TRACE_STEPS its trace and each long frame's breakdown. */
  const interactionStep = async (name, fn) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const browser = page.context().browser?.() ?? null,
      traced = TRACE.has(slug) && browser !== null;
    const tracePath = join(out, `trace-${slug}.json`);
    if (traced)
      await browser.startTracing(page, { path: tracePath, screenshots: false, categories: STEP_TRACE_CATEGORIES });
    const markName = `perf:step:${slug}`;
    // The step's long frames come from the harness's own record of its steps (the long-frame invariant's frames):
    // the harness drains `__perfLab.loaf` as each of its steps ends, and ui.enterEdit and friends are harness steps,
    // so the page's list is empty by the time fn returns.
    const from = await page.evaluate((n) => performance.mark(n).startTime, markName);
    const firstStep = run.steps.length;
    let value;
    try {
      value = await fn();
    } finally {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const to = await page.evaluate(() => performance.now());
      const recorded = run.steps
        .slice(firstStep)
        .map((st) => (st.invariants ?? []).find((x) => x.name === "long-frame"))
        .filter((x) => x && !x.skipped);
      const loaf =
        recorded.length === 0
          ? null
          : recorded.flatMap((x) => [...(x.details?.attributed ?? []), ...(x.details?.unattributed ?? [])]);
      const summary = loaf === null ? null : loafSummary(loaf, { fromMs: from, toMs: to });
      const entry = {
        windowMs: Math.round(to - from),
        loaf:
          summary === null
            ? "NOT EVALUATED: no LoAF observer"
            : {
                count: summary.count,
                blockingMs: summary.blockingMs,
                longestMs: summary.longestMs,
                unattributed: summary.unattributed,
                frames: summary.frames.map((f) => ({
                  startTime: f.startTime,
                  duration: f.duration,
                  blockingDuration: f.blockingDuration,
                  renderStart: f.renderStart,
                  styleAndLayoutStart: f.styleAndLayoutStart,
                  scripts: (f.scripts ?? []).slice(0, 3),
                })),
              },
      };
      if (TRACE.has(slug) && !traced) entry.trace = "NOT EVALUATED: no browser handle to trace with";
      if (traced) {
        await browser.stopTracing();
        // The trace file holds URLs; strip token values before it is kept (rubric §9 Secrets).
        const text = readFileSync(tracePath, "utf8").replace(/([?&]token=)[^&#\s"\\]+/gi, "$1REDACTED");
        writeFileSync(tracePath, text);
        const events = JSON.parse(text).traceEvents ?? [];
        const main = markThread(events, markName);
        entry.trace =
          main === null
            ? { file: tracePath, note: "NOT EVALUATED: the step mark is not in the trace" }
            : {
                file: tracePath,
                frames: (summary?.frames ?? [])
                  .slice(0, 5)
                  .map((f) => frameBreakdown(events, f, { offsetUs: clockOffset(main.ts, from), main })),
              };
      }
      steps[name] = entry;
      const l = entry.loaf;
      console.log(
        `NOTE ${name}: long frames ${typeof l === "string" ? l : `${l.count} (longest ${l.longestMs} ms, ${l.unattributed.length} unattributed)`}${traced ? `; trace ${tracePath}` : ""}`,
      );
    }
    return value;
  };
  const paced = async (from, dx, dy, opts = {}) => {
    for (let i = 1; i <= FRAMES; i++) {
      await page.mouse.move(from.x + (dx * i) / FRAMES, from.y + (dy * i) / FRAMES, opts);
      await page.waitForTimeout(16);
    }
  };

  await ui.openDiagram("awkward", "diagrams/flow-large.mmd");
  await step("canvas ready", async () => {
    await page.locator(".react-flow__node").first().waitFor();
    await page.waitForFunction(() => performance.getEntriesByName("archer:interactive").length > 0, null, {
      timeout: 15_000,
    });
  });

  await measure("pan", async () => {
    const at = await emptyPoint();
    if (!at) throw new Error("no empty point on the canvas to pan from");
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button: "middle" });
    await paced(at, -240, -120);
    await page.mouse.up({ button: "middle" });
  });

  await measure("zoom", async () => {
    const at = (await emptyPoint()) ?? { x: 700, y: 450 };
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down("Control");
    try {
      for (let i = 0; i < FRAMES; i++) {
        await page.mouse.wheel(0, i < FRAMES / 2 ? -40 : 40);
        await page.waitForTimeout(16);
      }
    } finally {
      await page.keyboard.up("Control");
    }
  });

  await step(
    "click the empty canvas",
    async () => {
      if (FAULT === "slow-click")
        await page.evaluate(() =>
          document.addEventListener(
            "click",
            () => {
              const end = performance.now() + 300;
              while (performance.now() < end) {
                /* seeded fault: a slow handler */
              }
            },
            { capture: true, once: true },
          ),
        );
      const at = await emptyPoint();
      if (!at) throw new Error("no empty point on the canvas to click");
      await page.mouse.click(at.x, at.y);
    },
    { interaction: true },
  );

  await interactionStep("enter edit", () => ui.enterEdit());
  // Every node of flow-large sits in a subgraph, and a grouped node's position is fixed (the editor refuses the drag):
  // the drag is of a top-level part added to the draft, on the full 150-node canvas. Cancel → Discard drops it.
  const added = await interactionStep("add part", () => ui.addPart("Process", { name: "Drag me" }));
  if (added !== undefined) await ui.panTo(added);
  await measure("node drag", async () => {
    const pick = await page.evaluate((id) => {
      const el = id ? document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) : null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id, x: r.x + r.width / 2, y: r.y + r.height / 2, transform: el.style.transform };
    }, added ?? null);
    if (!pick) throw new Error(`the added part ${added} is not on the canvas to drag`);
    await page.mouse.move(pick.x, pick.y);
    await page.mouse.down();
    await paced(pick, 120, 80);
    await page.mouse.up();
    const after = await page.locator(`.react-flow__node[data-id="${pick.id}"]`).evaluate((el) => el.style.transform);
    if (after === pick.transform) throw new Error(`node drag: ${pick.id} did not move`);
    results.dragged = pick.id;
  });
  await interactionStep("cancel", () => ui.cancel({ discard: true }));

  const report = {
    schema: "archer-canvas-pan/1",
    at: new Date().toISOString(),
    diagram: "awkward/diagrams/flow-large.mmd",
    variant: sandbox.debugUi ? "debug" : "production",
    fault: FAULT || null,
    framesPerGesture: FRAMES,
    gestures: Object.fromEntries(Object.entries(results).filter(([k]) => k !== "dragged")),
    interactionSteps: steps,
    tracedSteps: [...TRACE],
    draggedNode: results.dragged ?? null,
    editorWrites: writes.length,
  };
  writeFileSync(join(out, "canvas-pan.json"), JSON.stringify(report, null, 2));
  console.log(`NOTE canvas-pan.json: ${join(out, "canvas-pan.json")}`);
  if (writes.length)
    throw new Error(`the node drag was meant to be discarded, but ${writes.length} editor write(s) were sent`);
};
