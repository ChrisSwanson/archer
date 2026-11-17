// perf: the leak journey of gate G6 (docs/quality/rubrics/performance.md §3 G6, §5 heap row, §6 "Leak"). Each loop goes
// list → diagram → edit → back → note and back to the list, by in-app navigation only (clicks and history, never a
// reload or page.goto), so it ends where it started: /projects/awkward/?tab=diagrams. "Edit" opens the editor and
// cancels it with no change; nothing is saved. 3 warm-up loops are discarded, then 20 are measured. After each loop:
// HeapProfiler.collectGarbage twice, then the main heap (Runtime.getHeapUsage), every dedicated worker's heap (through
// the browser's CDP session, as heapAfterGc in tools/perf/page-load.mjs), and Memory.getDOMCounters.
// The OLS slope of each heap series with its 95% CI (tools/perf/lib/leak.mjs) decides, per §6, whether to diff the heap
// snapshots taken after measured loops 5 and 20 and follow the retainers of the classes that grew by ≥ 1 instance per loop.
// A third snapshot, after loop 13, confirms: a class scales with the loops only when its count and its Archer-held count
// also grew by ≥ 1 a loop in each half. Growth in one half only is a step, such as App's hooks gaining a second list or
// moving under its bound state dispatch (O187): reported in `steps`, not confirmed.
//
//   node tools/devkit/sandbox.mjs up --name perf-leak            # the production page (no --debug-ui)
//   PERF_OUT=<dir> node tools/devkit/harness/smoke.mjs --sandbox perf-leak --journey tools/devkit/journeys/perf/leak-navigation.mjs
//
// Environment:
//   PERF_OUT              where leak-navigation.json and the .heapsnapshot files go (default: the harness run dir for the
//                         JSON, a fresh dir under the OS temp dir for snapshots, so they never land in the repo)
//   PERF_RELEASE_SLOPE    the last release's main-heap slope, MB/loop (from its run of this journey)
//   PERF_RELEASE_OUT      or the path of the last release's leak-navigation.json (its main and worker slopes)
//                         Neither given: the comparison is "release slope not given" and only "CI excludes 0" applies.
//   PERF_SNAPSHOTS        auto (default: diff only when §6 trips; the loop-5 and loop-13 snapshots are taken speculatively and deleted
//                         when not needed), always (diff regardless), never (no snapshots: a tripped slope is NOT EVALUATED)
//   PERF_KEEP_SNAPSHOTS=1 keep snapshot files that were not diffed
//   PERF_SEED_FAULT=leak  seeded fault: each loop retains 101 detached <div>s and a closure over a 512 KB array in
//                         window.__archerSeededLeak (an `__archer*` global, which leak.mjs counts as Archer code). Must FAIL.
//   PERF_LOOPS / PERF_WARMUP  override 20 / 3 (only for trying the journey; the rubric's design is 3 + 20)
//   PERF_CONTROL=tabs     a control loop, not the gate: Notes tab → Diagrams tab on the same list, no diagram or note
//                         opened. It proves the PASS path live where the product's full loop retains (see the report).
//
// Verdict (leak-navigation.json `verdict`): PASS (no class scaling with loops with an Archer retainer outside a declared
// cache, tools/perf/leak-declared-caches.json), FAIL, or NOT EVALUATED with the reason. The journey step "G6 verdict"
// fails on FAIL and NOT EVALUATED, so the harness run fails too.
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classCounts,
  confirmRetention,
  declaredCachesFrom,
  diffClasses,
  heapGrowthByType,
  olsSlope,
  parseSnapshot,
  slopeVerdict,
} from "../../../perf/lib/leak.mjs";
import { KNOWN } from "../flowchart-create.mjs";

export const meta = {
  name: "perf-leak-navigation",
  // Trace DOM snapshots and entry screenshots would run in the page on every action; this journey measures the page.
  traceSnapshots: false,
  entryShots: false,
  maxMs: 40 * 60_000,
  invariants: {
    ...KNOWN,
    "duplicate-requests": { severity: "warn", reason: "known" },
    "requests-per-view": { severity: "warn", reason: "known" },
    "label-focus": { severity: "warn", reason: "known" },
  },
};

const MB = 1048576;
const DIAGRAM = "Fixture sequence full",
  DIAGRAM_PATH = /\/projects\/awkward\/diagrams\/fixture-seq-full\.mmd$/;
const NOTE = "Auth design",
  NOTE_PATH = /\/projects\/awkward\/notes\/auth\.md$/;
const SNAP_EARLY = 5,
  SNAP_LATE = 20;
/** The middle snapshot's loop for a late one at `late`: halfway, so each half spans several loops (O187). */
const midLoop = (late) => (late - SNAP_EARLY >= 2 ? Math.round((SNAP_EARLY + late) / 2) : null);

/** A CDP session to a dedicated worker through the browser session (flatten: false), with its events. */
async function workerSession(browserCdp, targetId) {
  const { sessionId } = await browserCdp.send("Target.attachToTarget", { targetId, flatten: false });
  let id = 0;
  const replies = new Map(),
    handlers = new Map();
  const listen = (e) => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message);
    if (m.id !== undefined) {
      const r = replies.get(m.id);
      replies.delete(m.id);
      r?.(m);
    } else handlers.get(m.method)?.(m.params);
  };
  browserCdp.on("Target.receivedMessageFromTarget", listen);
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        replies.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
        browserCdp
          .send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: n, method, params }) })
          .catch(reject);
      }),
    on: (method, fn) => handlers.set(method, fn),
    off: (method) => handlers.delete(method),
    detach: async () => {
      browserCdp.off("Target.receivedMessageFromTarget", listen);
      await browserCdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    },
  };
}

/** A heap snapshot through `session` ({send, on, off}) streamed to `file`. */
async function snapshotTo(session, file) {
  const out = createWriteStream(file);
  await session.send("HeapProfiler.enable");
  await session.send("HeapProfiler.collectGarbage");
  session.on("HeapProfiler.addHeapSnapshotChunk", (p) => out.write(p.chunk));
  try {
    await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
  } finally {
    session.off("HeapProfiler.addHeapSnapshotChunk");
    await new Promise((r) => out.end(r));
  }
  return file;
}

const pageSession = (cdp) => {
  const fns = new Map();
  return {
    send: (m, p) => cdp.send(m, p),
    on: (m, fn) => {
      fns.set(m, fn);
      cdp.on(m, fn);
    },
    off: (m) => {
      const fn = fns.get(m);
      if (fn) cdp.off(m, fn);
      fns.delete(m);
    },
  };
};

/** Read the release's slopes: PERF_RELEASE_SLOPE (main) or PERF_RELEASE_OUT (a previous leak-navigation.json). */
function releaseSlopes() {
  if (process.env.PERF_RELEASE_OUT) {
    const prev = JSON.parse(readFileSync(process.env.PERF_RELEASE_OUT, "utf8"));
    return {
      source: process.env.PERF_RELEASE_OUT,
      main: prev.slopes?.main?.slope ?? null,
      worker: prev.slopes?.worker?.slope ?? null,
    };
  }
  if (process.env.PERF_RELEASE_SLOPE !== undefined) {
    const v = Number(process.env.PERF_RELEASE_SLOPE);
    if (!Number.isFinite(v))
      throw new Error(`PERF_RELEASE_SLOPE=${process.env.PERF_RELEASE_SLOPE} is not a number (MB/loop)`);
    return { source: "PERF_RELEASE_SLOPE", main: v, worker: null };
  }
  return { source: null, main: null, worker: null };
}

export default async ({ page, context, ui, step, expect, sandbox, run, devtools }) => {
  const outDir = process.env.PERF_OUT ?? run.dir;
  mkdirSync(outDir, { recursive: true });
  const snapDir = process.env.PERF_OUT ?? mkdtempSync(join(tmpdir(), "archer-perf-leak-"));
  const warmup = Number(process.env.PERF_WARMUP ?? 3),
    loops = Number(process.env.PERF_LOOPS ?? 20);
  const snapshots = process.env.PERF_SNAPSHOTS ?? "auto";
  const seeded = process.env.PERF_SEED_FAULT === "leak";
  const release = releaseSlopes();
  const declaredCaches = declaredCachesFrom(
    JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../perf/leak-declared-caches.json", import.meta.url)), "utf8"),
    ),
  );
  const origin = sandbox.origin,
    LIST = `${origin}/projects/awkward/?tab=diagrams`;
  const cdp = await context.newCDPSession(page);
  const browserCdp = await context.browser().newBrowserCDPSession();
  const notEvaluated = [];

  const atList = () => page.url() === LIST;
  const backToList = async () => {
    for (let k = 0; k < 6 && !atList(); k++) await page.goBack();
    if (!atList()) throw new Error(`history did not lead back to the list (at ${page.url()})`);
    await expect(page.getByRole("tab", { name: /^Diagrams/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: DIAGRAM, exact: true })).toBeVisible();
  };

  const workerTargets = async () =>
    (await browserCdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "worker");
  const heapOf = async (send) => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    return (await send("Runtime.getHeapUsage")).usedSize;
  };
  const sample = async (loop) => {
    const main = await heapOf((m) => cdp.send(m));
    const workers = [];
    for (const t of await workerTargets()) {
      const w = await workerSession(browserCdp, t.targetId);
      try {
        workers.push({ url: t.url.replace(/[?#].*$/, ""), bytes: await heapOf((m) => w.send(m)) });
      } catch (e) {
        workers.push({ url: t.url.replace(/[?#].*$/, ""), bytes: null, error: String(e.message ?? e) });
      } finally {
        await w.detach();
      }
    }
    const dom = await cdp.send("Memory.getDOMCounters");
    const workerBytes =
      workers.length && workers.every((w) => w.bytes !== null) ? workers.reduce((a, w) => a + w.bytes, 0) : null;
    return {
      loop,
      url: page.url().replace(origin, ""),
      historyLength: await page.evaluate(() => history.length),
      mainMb: main / MB,
      workerMb: workerBytes === null ? null : workerBytes / MB,
      workers,
      documents: dom.documents,
      nodes: dom.nodes,
      listeners: dom.jsEventListeners,
    };
  };

  const takeSnapshots = async (label) => {
    if (snapshots === "never") return null;
    const files = {
      main: await snapshotTo(pageSession(cdp), join(snapDir, `leak-main-loop${label}.heapsnapshot`)),
      workers: [],
    };
    for (const [i, t] of (await workerTargets()).entries()) {
      const w = await workerSession(browserCdp, t.targetId);
      try {
        files.workers.push({
          url: t.url.replace(/[?#].*$/, ""),
          file: await snapshotTo(w, join(snapDir, `leak-worker${i}-loop${label}.heapsnapshot`)),
        });
      } finally {
        await w.detach();
      }
    }
    return files;
  };

  const seedFault = () =>
    page.evaluate(() => {
      const root = document.createElement("div");
      for (let i = 0; i < 100; i++) root.appendChild(document.createElement("div"));
      const payload = Array.from({ length: 65536 }, (_, i) => i + 0.5); // 512 KB of doubles
      (window.__archerSeededLeak ||= []).push({ root, keep: () => payload.length });
    });

  const control = process.env.PERF_CONTROL === "tabs";
  const tabsLoop = async (n) => {
    await step(
      `loop ${n} (control): Notes tab → Diagrams tab`,
      async () => {
        await page.getByRole("tab", { name: /^Notes/ }).click();
        await expect(page.getByRole("button", { name: NOTE, exact: true })).toBeVisible();
        await page.getByRole("tab", { name: /^Diagrams/ }).click();
      },
      { selectionMayChange: true },
    );
    await step(`loop ${n} (control): back to the list`, backToList, { selectionMayChange: true });
    if (seeded) await seedFault();
    await page.waitForTimeout(500);
  };
  const fullLoop = async (n) => {
    await step(
      `loop ${n}: list → diagram`,
      async () => {
        await page.getByRole("button", { name: DIAGRAM, exact: true }).click();
        await expect(page).toHaveURL(DIAGRAM_PATH);
        await expect(page.locator(".archer-seq-canvas").first()).toBeVisible();
      },
      { selectionMayChange: true },
    );
    await ui.enterEdit();
    await ui.cancel({ discard: true });
    await step(`loop ${n}: back to the list`, backToList, { selectionMayChange: true, leavesEditor: true });
    await step(
      `loop ${n}: list → note`,
      async () => {
        await page.getByRole("tab", { name: /^Notes/ }).click();
        await page.getByRole("button", { name: NOTE, exact: true }).click();
        await expect(page).toHaveURL(NOTE_PATH);
        await expect(page.locator(".archer-note, article").first()).toBeVisible();
      },
      { selectionMayChange: true },
    );
    await step(`loop ${n}: back to the list`, backToList, { selectionMayChange: true });
    if (seeded) await seedFault();
    // Let debounced work after the last navigation finish before the GC.
    await page.waitForTimeout(500);
  };

  // What grows with the steps a journey takes, not with Archer, is emptied after each loop (O73): the harness's vitals
  // lists (window.__perfLab), Resource Timing (with its Server Timing entries) and the harness session's network records.
  // Playwright's own session keeps its network records; they are browser natives, never an Archer retainer.
  const clearHarnessBuffers = async () => {
    await page.evaluate(() => {
      const lab = window.__perfLab;
      if (lab)
        for (const k of ["shifts", "longTasks", "loaf", "events", "inputs"])
          if (Array.isArray(lab[k])) lab[k].length = 0;
      performance.clearResourceTimings();
    });
    await devtools?.clearNetworkRecords?.();
  };
  const loop = async (n) => {
    await (control ? tabsLoop : fullLoop)(n);
    await clearHarnessBuffers();
  };
  await step(
    "open the list (the loop's start and end state)",
    async () => {
      await page.goto(LIST);
      await expect(page.getByRole("button", { name: DIAGRAM, exact: true })).toBeVisible();
    },
    { selectionMayChange: true },
  );

  const samples = [],
    warm = [];
  let early = null,
    middle = null,
    late = null;
  const MID = midLoop(Math.min(loops, SNAP_LATE));
  for (let i = 1; i <= warmup + loops; i++) {
    await loop(i);
    if (run.failures.length) {
      notEvaluated.push(`loop ${i} failed: ${run.failures[0].error ?? run.failures[0].invariant}`);
      break;
    }
    if (!atList()) {
      notEvaluated.push(`loop ${i} ended at ${page.url()}, not the list`);
      break;
    }
    const s = await sample(i <= warmup ? -i : i - warmup);
    (i <= warmup ? warm : samples).push(s);
    const m = i - warmup;
    if (m === SNAP_EARLY)
      early = await takeSnapshots(m).catch((e) => {
        notEvaluated.push(`snapshot at loop ${m}: ${e.message}`);
        return null;
      });
    if (m === MID)
      middle = {
        at: m,
        files: await takeSnapshots(m).catch((e) => {
          notEvaluated.push(`snapshot at loop ${m}: ${e.message}`);
          return null;
        }),
      };
    if (m === SNAP_LATE || (m === loops && loops < SNAP_LATE))
      late = {
        at: m,
        files: await takeSnapshots(m).catch((e) => {
          notEvaluated.push(`snapshot at loop ${m}: ${e.message}`);
          return null;
        }),
      };
  }

  // Globals the app created: the page's own names beyond those of a blank same-origin document (after the snapshots).
  const appGlobals = await page
    .evaluate(() => {
      const f = document.createElement("iframe");
      f.src = "about:blank";
      f.style.display = "none";
      document.body.appendChild(f);
      const blank = new Set(Object.getOwnPropertyNames(f.contentWindow));
      f.remove();
      return Object.getOwnPropertyNames(window).filter((n) => !blank.has(n));
    })
    .catch(() => []);

  const series = (key) => samples.filter((s) => s[key] !== null).map((s) => [s.loop, s[key]]);
  const slopes = {
    main: olsSlope(series("mainMb")),
    worker: olsSlope(series("workerMb")),
    nodes: olsSlope(series("nodes")),
    listeners: olsSlope(series("listeners")),
  };
  const decisions = {
    main: slopeVerdict({ candidate: slopes.main, release: release.main }),
    worker: slopes.worker.n ? slopeVerdict({ candidate: slopes.worker, release: release.worker }) : null,
  };
  if (samples.length < loops) notEvaluated.push(`${samples.length} of ${loops} measured loops`);
  if (samples.some((s) => s.workers.some((w) => w.bytes === null)))
    notEvaluated.push("a worker heap could not be read");
  const tripped = decisions.main.takeSnapshots || Boolean(decisions.worker?.takeSnapshots);

  // §6: snapshots at 5 and 20, diff, follow the retainers.
  const diffs = [];
  const loopsBetween = (late?.at ?? SNAP_LATE) - SNAP_EARLY;
  if ((tripped || snapshots === "always") && !notEvaluated.length) {
    if (!early || !late?.files || (MID !== null && !middle?.files))
      notEvaluated.push(
        snapshots === "never"
          ? "the slope tripped §6 but PERF_SNAPSHOTS=never"
          : `the snapshots at loops 5${MID === null ? "" : `, ${MID}`} and 20 are missing`,
      );
    else {
      const pairs = [{ heap: "main", a: early.main, m: middle?.files?.main, b: late.files.main, why: decisions.main }];
      // A worker is paired with the one of the same script at loop 5 (heap ids are only comparable within one worker).
      for (const w of late.files.workers) {
        const e = early.workers.find((x) => x.url === w.url);
        if (e)
          pairs.push({
            heap: `worker ${w.url}`,
            a: e.file,
            m: middle?.files?.workers.find((x) => x.url === w.url)?.file,
            b: w.file,
            why: decisions.worker,
          });
      }
      for (const p of pairs) {
        if (!(p.why?.takeSnapshots || snapshots === "always")) continue;
        // O73: harness-held instances are left out of the counts, and a class is confirmed only by Archer-held
        // instances whose count grows (a retainer signature that grows), not by a sample of new instances.
        const earlier = parseSnapshot(readFileSync(p.a)),
          later = parseSnapshot(readFileSync(p.b));
        const mid = p.m ? parseSnapshot(readFileSync(p.m)) : undefined;
        const halves = mid ? [middle.at - SNAP_EARLY, late.at - middle.at] : undefined;
        const grown = diffClasses(
          classCounts(earlier, { leaveOutHarness: true }),
          classCounts(later, { leaveOutHarness: true }),
          loopsBetween,
        );
        const classes = confirmRetention(later, grown, {
          earlier,
          middle: mid,
          loops: halves,
          declaredCaches,
          appGlobals,
        });
        // Growth by node type: "code" is V8's compiled code and feedback (warming up), reported apart from app objects.
        const byType = heapGrowthByType(earlier, later, loopsBetween);
        // The ways the confirmed instances are held, most classes first: usually one or two root causes behind many classes.
        const holders = new Map();
        for (const c of classes.filter((x) => x.confirmed))
          for (const r of c.retainers.filter((x) => x.archer && !x.declared)) {
            const h = holders.get(r.signature) ?? {
              signature: r.signature,
              kind: r.kind,
              via: r.via,
              example: r.path,
              classes: new Set(),
            };
            h.classes.add(c.cls);
            holders.set(r.signature, h);
          }
        const retainers = [...holders.values()]
          .map((h) => ({ ...h, classes: [...h.classes] }))
          .sort((a, b) => b.classes.length - a.classes.length);
        // Each Archer holder (`via`: the global or the closure the path enters by) with its classes, most classes first.
        const byVia = new Map();
        for (const r of retainers) {
          const v = byVia.get(r.via) ?? { via: r.via, kind: r.kind, classes: new Set(), signatures: [] };
          r.classes.forEach((c) => v.classes.add(c));
          v.signatures.push(r.signature);
          byVia.set(r.via, v);
        }
        const holdersByVia = [...byVia.values()]
          .map((v) => ({ ...v, classes: [...v.classes], signatures: v.signatures.slice(0, 5) }))
          .sort((a, b) => b.classes.length - a.classes.length);
        // Classes whose Archer-held count grew from loop 5 to 20 but not in both halves: a step, not growth (O187).
        const steps = classes
          .filter((c) => c.step)
          .map((c) => ({ cls: c.cls, counts: c.counts, archerCounts: c.archerCounts }));
        diffs.push({
          heap: p.heap,
          snapshots: [p.a, ...(p.m ? [p.m] : []), p.b],
          snapshotsAt: [SNAP_EARLY, ...(mid ? [middle.at] : []), late.at],
          loopsBetween,
          steps,
          byType,
          v8CodeMbPerLoop: (byType.code?.perLoop ?? 0) / MB,
          grownClasses: grown.length,
          confirmed: classes.filter((c) => c.confirmed).map((c) => c.cls),
          holders: holdersByVia,
          retainers: retainers.slice(0, 30),
          classes,
        });
      }
    }
  }
  if (!tripped && snapshots !== "always" && !process.env.PERF_KEEP_SNAPSHOTS) {
    for (const f of [
      early?.main,
      ...(early?.workers ?? []).map((w) => w.file),
      middle?.files?.main,
      ...(middle?.files?.workers ?? []).map((w) => w.file),
      late?.files?.main,
      ...(late?.files?.workers ?? []).map((w) => w.file),
    ])
      if (f) rmSync(f, { force: true });
  }

  const confirmed = diffs.flatMap((d) => d.confirmed.map((c) => `${d.heap}: ${c}`));
  const failReasons = () => [
    `confirmed retention of ${confirmed.length} classes (${confirmed.slice(0, 6).join("; ")}${confirmed.length > 6 ? "; …" : ""})`,
    ...diffs.flatMap((d) =>
      d.holders
        .slice(0, 5)
        .map((h) => `${d.heap}: ${h.classes.length} classes held through ${h.kind} ${h.via}, e.g. ${h.signatures[0]}`),
    ),
  ];
  const verdict = notEvaluated.length
    ? { result: "NOT EVALUATED", reasons: notEvaluated }
    : confirmed.length
      ? { result: "FAIL", reasons: failReasons() }
      : {
          result: "PASS",
          reasons:
            tripped || snapshots === "always"
              ? ["no class scaling with loops has an Archer retainer outside a declared cache"]
              : ["the slope did not trip §6: no snapshots needed"],
        };
  const report = {
    gate: "G6",
    rubric: "docs/quality/rubrics/performance.md",
    journey: "tools/devkit/journeys/perf/leak-navigation.mjs",
    at: new Date().toISOString(),
    sandbox: { name: sandbox.name, page: sandbox.page, debugUi: sandbox.debugUi },
    design: {
      warmup,
      loops,
      loop: control
        ? "CONTROL (not the gate): Notes tab → Diagrams tab (clicks), back (history) if needed"
        : "list → diagram (click) → Edit → Cancel → back (history) → Notes tab → note (click) → back (history)",
      start: "/projects/awkward/?tab=diagrams",
      snapshotsAt: [SNAP_EARLY, ...(MID === null ? [] : [MID]), late?.at ?? SNAP_LATE],
      kPerLoop: 1,
      snapshotMode: snapshots,
    },
    seededFault: seeded
      ? "leak: 101 detached divs + a closure over 512 KB per loop in window.__archerSeededLeak"
      : null,
    release: {
      ...release,
      note: release.main === null && release.worker === null ? "release slope not given" : undefined,
    },
    slopes,
    decisions,
    tripped,
    appGlobals,
    // Every confirmed class, and the first unconfirmed ones; per class its followed retainers.
    snapshotDiff: diffs.map((d) => ({
      ...d,
      classes: [...d.classes.filter((c) => c.confirmed), ...d.classes.filter((c) => !c.confirmed).slice(0, 15)],
    })),
    verdict,
    warmup: warm,
    samples,
  };
  const file = join(outDir, "leak-navigation.json");
  writeFileSync(file, JSON.stringify(report, null, 2));
  const code = diffs.find((d) => d.heap === "main")?.v8CodeMbPerLoop;
  await step(
    `G6 verdict: ${verdict.result} (main ${slopes.main.slope?.toFixed(4)} MB/loop, CI ${slopes.main.ci?.map((v) => v.toFixed(4)).join("…")}${code === undefined ? "" : `; V8 code ${code.toFixed(4)} MB/loop of it`}) → ${file}`,
    async () => {
      if (verdict.result !== "PASS") throw new Error(`G6 ${verdict.result}: ${verdict.reasons.join("; ")}`);
    },
  );
};
