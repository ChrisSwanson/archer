#!/usr/bin/env node
// Motion probe (rubric ui-ux.md G11, V7): what moves on its own once a page has settled, per motion cell.
//
// Three collectors, deduplicated by element:
//   - CSS / Web Animations: `document.getAnimations()` that are running (CSS animations, CSS transitions, script
//     animations), with their target, name, duration and iterations;
//   - SMIL: every <animate>, <animateMotion>, <animateTransform>, <set> (the flow packet in
//     ui/src/emphasis/EmphasisChevrons.tsx), whether its document timeline is paused, and whether it has begun;
//   - transforms sampled over `sampleMs` (2 s) every 100 ms: the screen box of every rendered element in the
//     viewport (capped), so a requestAnimationFrame or SMIL motion shows up as displacement whatever drives it.
// The emphasis packet (`.archer-emph-chevrons`) is judged on its own: moving, or parked (still between samples, and no
// <animateMotion> left in it). Chrome transitions are counted statically too: under OS reduce, elements outside the
// drawing whose computed transition/animation duration is non-zero (G11 [H] "chrome has no non-essential transitions").
//
// Motion cells (rubric §6): flow-animation On / Off / Auto × OS reduced motion on / off. The rubric gates four:
// On+reduce (recorded, not gated), Off+reduce, Auto+reduce, Auto+no reduce. Expectations per cell are in `EXPECT`.
//
// Library:  import { probeMotion } from "./motion.mjs";  await probeMotion(page, { sampleMs: 2000 })
// Journey:  node tools/devkit/harness/smoke.mjs --sandbox <n> --journey tools/devkit/harness/motion.mjs
// CLI:      node tools/devkit/harness/motion.mjs (--sandbox <n> | --origin <url> --login <link>)
//             [--diagram <slug>/<path in the Archer folder>] [--cells on-reduce,off-reduce,…] [--viewports 1500x900]
//             [--themes light] [--sample-ms 2000] [--out dir]
// The diagram needs an emphasis with a `flow` group for the packet to exist (set one with `archer emphasis set`).
import { chromium } from "playwright";
import { parseArgs } from "node:util";
import {
  TARGET_OPTIONS,
  cellContext,
  defaultOut,
  isMain,
  loginState,
  mdTable,
  resolveTarget,
  sandboxTarget,
  selectList,
  settle,
  writeReport,
} from "./surfaces.mjs";

/** The motion cells. `gate` says whether the rubric gates the cell; `still` whether emphasis motion must be absent. */
export const MOTION_CELLS = [
  {
    id: "on-reduce",
    flow: "on",
    reduce: true,
    gate: false,
    still: false,
    note: "default On with OS reduce: recorded, not gated (2.3.3 is AAA)",
  },
  { id: "off-reduce", flow: "off", reduce: true, gate: true, still: true },
  { id: "auto-reduce", flow: "auto", reduce: true, gate: true, still: true },
  { id: "auto-noreduce", flow: "auto", reduce: false, gate: true, still: false },
  { id: "on-noreduce", flow: "on", reduce: false, gate: false, still: false },
  { id: "off-noreduce", flow: "off", reduce: false, gate: false, still: true },
];

/** In-page: one snapshot of what is animating, plus the boxes to compare. Self-contained. */
export function motionSnapshot(arg) {
  const { phase, cap = 2500 } = arg ?? {};
  const DRAWING = ".react-flow, .archer-seq-canvas, .archer-journey, svg";
  const PACKET = ".archer-emph-chevrons";
  window.__motionIds ??= new WeakMap();
  let next = (window.__motionNext ??= 1);
  window.__motionEls ??= new Map();
  const idOf = (el) => {
    let id = window.__motionIds.get(el);
    if (!id) {
      id = next++;
      window.__motionIds.set(el, id);
      window.__motionEls.set(id, new WeakRef(el));
      window.__motionNext = next;
    }
    return id;
  };
  const path = (n) => {
    const parts = [];
    for (
      let x = n;
      x && x !== document.body && x !== document.documentElement && parts.length < 4;
      x = x.parentElement
    ) {
      const c = (typeof x.className === "string" ? x.className : (x.getAttribute?.("class") ?? ""))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      parts.unshift(x.tagName.toLowerCase() + (x.id ? `#${x.id}` : c ? `.${c}` : ""));
    }
    return parts.join(" > ");
  };
  const boxes = {};
  const els = [...document.querySelectorAll("body *")].filter(
    (el) => !/^(SCRIPT|STYLE|LINK|META|animate|animateMotion|animateTransform|set|mpath)$/i.test(el.tagName),
  );
  let n = 0;
  for (const el of els) {
    if (n >= cap) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    boxes[idOf(el)] = [
      Math.round(r.left * 4) / 4,
      Math.round(r.top * 4) / 4,
      Math.round(r.width * 4) / 4,
      Math.round(r.height * 4) / 4,
    ];
    n++;
  }
  if (phase !== "first") return { boxes };
  const paths = {};
  for (const el of els) {
    const id = window.__motionIds.get(el);
    if (id) paths[id] = { path: path(el), packet: !!el.closest(PACKET), drawing: !!el.closest(DRAWING) };
  }
  const animations = document.getAnimations().map((a) => {
    const t = a.effect?.target;
    const timing = a.effect?.getComputedTiming?.() ?? {};
    return {
      type: a.constructor.name,
      name: a.animationName ?? a.transitionProperty ?? a.id ?? "",
      playState: a.playState,
      target: t ? path(t) : null,
      targetId: t ? idOf(t) : null,
      packet: !!t?.closest?.(PACKET),
      drawing: !!t?.closest?.(DRAWING),
      duration: timing.duration,
      iterations: timing.iterations,
      endTime: timing.endTime,
    };
  });
  const smil = [...document.querySelectorAll("animate, animateMotion, animateTransform, set")].map((a) => {
    const svg = a.ownerSVGElement;
    let started = null;
    try {
      a.getStartTime();
      started = true;
    } catch {
      started = false;
    }
    return {
      tag: a.tagName,
      parent: path(a.parentElement),
      parentId: idOf(a.parentElement),
      packet: !!a.closest(PACKET),
      paused: svg?.animationsPaused?.() ?? null,
      time: svg?.getCurrentTime?.() ?? null,
      started,
      dur: a.getAttribute("dur"),
      repeat: a.getAttribute("repeatCount"),
    };
  });
  const packets = [...document.querySelectorAll(PACKET)].map((g) => ({
    edge: g.getAttribute("data-edge"),
    id: idOf(g),
    chevrons: g.querySelectorAll(".archer-emph-chevron").length,
    animateMotion: g.querySelectorAll("animateMotion").length,
    chevronIds: [...g.querySelectorAll(".archer-emph-chevron")].map(idOf),
  }));
  // Static chrome transitions: elements outside the drawing with a non-zero transition or a running-capable animation.
  const chromeTransitions = [];
  for (const el of document.querySelectorAll("body *")) {
    if (chromeTransitions.length >= 40) break;
    if (el.closest(DRAWING)) continue;
    const s = getComputedStyle(el);
    const td = s.transitionDuration.split(",").some((d) => parseFloat(d) > 0.01);
    const an = s.animationName !== "none" && s.animationDuration.split(",").some((d) => parseFloat(d) > 0.01);
    if ((td || an) && el.getClientRects().length)
      chromeTransitions.push({
        path: path(el),
        transition: td ? `${s.transitionProperty} ${s.transitionDuration}` : undefined,
        animation: an ? `${s.animationName} ${s.animationDuration}` : undefined,
      });
  }
  const control =
    document.querySelector("select[aria-label='Flow animation'], [role=combobox][aria-label='Flow animation']") ??
    [...document.querySelectorAll("select")].find((s) => s.labels?.[0]?.textContent?.includes("Flow animation"));
  return {
    boxes,
    paths,
    animations,
    smil,
    packets,
    chromeTransitions,
    media: { reduce: matchMedia("(prefers-reduced-motion: reduce)").matches },
    preference: {
      stored: (() => {
        try {
          return localStorage.getItem("archer.flow-animation");
        } catch {
          return "unreadable";
        }
      })(),
      attribute: document.documentElement.getAttribute("data-flow-animation"),
    },
    control: control ? { value: control.value, focusable: control.tabIndex >= 0 && !control.disabled } : null,
  };
}

/** Compare snapshots: elements whose box moved > `threshold` px between any two samples. Pure. */
export function movedElements(samples, threshold = 0.75) {
  const first = samples[0].boxes;
  const moved = new Map();
  for (const s of samples.slice(1))
    for (const [id, b] of Object.entries(s.boxes)) {
      const a = first[id];
      if (!a) continue;
      const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
      if (d > threshold) moved.set(id, Math.max(moved.get(id) ?? 0, d));
    }
  return moved;
}

/** Judge a probe for one cell. Pure: `snap` is the first snapshot (with paths), `moved` from movedElements. */
export function judgeMotion(snap, moved, cell = null, rawMoved = moved, inside = {}) {
  const running = snap.animations.filter((a) => a.playState === "running");
  const smilActive = snap.smil.filter((a) => a.started !== false && a.paused !== true);
  // Movers: elements displaced over the window (already reduced to the outermost of each moving subtree by the caller).
  const info = (id) => snap.paths[id] ?? { path: `#${id}` };
  const movers = [...moved.keys()].map((id) => ({
    id: Number(id),
    ...info(id),
    px: Math.round(moved.get(id) * 10) / 10,
    packet: info(id).packet || (inside[id] ?? []).some((d) => snap.paths[d]?.packet),
  }));
  const packetMoving = snap.packets.some(
    (p) => p.animateMotion > 0 || p.chevronIds.some((c) => rawMoved.has(String(c)) || rawMoved.has(c)),
  );
  const emphasisMotions =
    running.filter((a) => a.packet).length +
    smilActive.filter((a) => a.packet).length +
    movers.filter((m) => m.packet).length;
  // One count per distinct moving thing: running animations by target, SMIL by parent, movers not already explained.
  const explained = new Set([...running.map((a) => a.targetId), ...smilActive.map((a) => a.parentId)].filter(Boolean));
  const unexplainedMovers = movers.filter(
    (m) => !explained.has(m.id) && !(inside[m.id] ?? []).some((d) => explained.has(d)),
  );
  const automaticMotions =
    new Set(running.map((a) => a.targetId ?? a.name)).size +
    new Set(smilActive.map((a) => a.parentId)).size +
    unexplainedMovers.length;
  const verdict = {};
  if (cell) {
    if (cell.still) {
      verdict.noEmphasisMotion = emphasisMotions === 0 && !packetMoving;
      verdict.packetParked =
        snap.packets.length === 0
          ? null
          : snap.packets.every((p) => p.chevrons > 0 && p.animateMotion === 0) && !packetMoving;
    } else verdict.packetMoving = snap.packets.length === 0 ? null : packetMoving;
    if (cell.reduce) verdict.chromeTransitions = snap.chromeTransitions.length;
    verdict.pass = cell.still ? verdict.noEmphasisMotion && verdict.packetParked !== false : true;
  }
  return {
    summary: {
      automaticMotions,
      runningAnimations: running.length,
      smilActive: smilActive.length,
      smilTotal: snap.smil.length,
      movers: movers.length,
      packets: snap.packets.length,
      packetMoving,
      emphasisMotions,
      chromeTransitions: snap.chromeTransitions.length,
    },
    verdict,
    running: running.slice(0, 40),
    smil: snap.smil.slice(0, 40),
    movers: movers.slice(0, 40),
    packets: snap.packets.map(({ chevronIds, ...p }) => p),
    chromeTransitions: snap.chromeTransitions,
    media: snap.media,
    preference: snap.preference,
    control: snap.control,
  };
}

/** Sample the page as it is now over `sampleMs` and judge it for `cell` (optional). */
export async function probeMotion(page, { sampleMs = 2000, everyMs = 100, cell = null } = {}) {
  const first = await page.evaluate(motionSnapshot, { phase: "first" });
  const samples = [first];
  const until = Date.now() + sampleMs;
  while (Date.now() < until) {
    await page.waitForTimeout(everyMs);
    samples.push(await page.evaluate(motionSnapshot, { phase: "sample" }));
  }
  const raw = movedElements(samples);
  const moved = new Map(raw);
  // A child moving with its parent is one motion: keep the outermost moved element of each subtree, and remember the
  // moved elements inside it (a group whose box changes because an animated child moves is that child's motion).
  const tree = await page.evaluate(
    (ids) => {
      const els = new Map(ids.map((id) => [id, window.__motionEls?.get(Number(id))?.deref()]));
      const keep = [],
        inside = {};
      for (const [id, el] of els) {
        if (el && [...els].some(([o, other]) => o !== id && other && other !== el && other.contains(el))) continue;
        keep.push(id);
        inside[id] = el
          ? [...els].filter(([o, other]) => o !== id && other && el.contains(other)).map(([o]) => Number(o))
          : [];
      }
      return { keep, inside };
    },
    [...moved.keys()],
  );
  for (const id of [...moved.keys()]) if (!tree.keep.includes(id)) moved.delete(id);
  return { samples: samples.length, ...judgeMotion(first, moved, cell, raw, tree.inside) };
}

function markdown(run) {
  let md =
    `# Motion probe (G11, V7)\n\nTarget: ${run.target.origin} (${run.target.source}) · ${run.generatedAt} · diagram ${run.diagram} · ${run.sampleMs} ms sampled\n\n` +
    "Automatic motions = distinct running CSS/Web animations by target + active SMIL animations by parent + elements displaced > 0.75 px that neither explains. Gated cells must show no emphasis motion and a parked packet where `still`.\n\n";
  md += mdTable(
    [
      "cell",
      "gated",
      "automatic motions",
      "CSS/WAAPI running",
      "SMIL active/total",
      "movers",
      "packets",
      "packet moving",
      "chrome transitions",
      "verdict",
    ],
    run.cells.map((c) =>
      c.result
        ? [
            c.cell,
            c.gate ? "yes" : "recorded",
            c.result.summary.automaticMotions,
            c.result.summary.runningAnimations,
            `${c.result.summary.smilActive}/${c.result.summary.smilTotal}`,
            c.result.summary.movers,
            c.result.summary.packets,
            c.result.summary.packetMoving,
            c.result.summary.chromeTransitions,
            c.result.verdict.pass === undefined ? "—" : c.result.verdict.pass ? "PASS" : "FAIL",
          ]
        : [c.cell, "", `error: ${c.error}`, "", "", "", "", "", "", ""],
    ),
  );
  return md;
}

async function runCell(browser, target, { cell, diagram, viewport, theme, storageState, sampleMs }) {
  const ctx = await cellContext(browser, {
    viewport,
    theme,
    reducedMotion: cell.reduce ? "reduce" : "no-preference",
    flowAnimation: cell.flow,
    storageState,
  });
  try {
    const page = await ctx.newPage();
    await page.goto(`${target.origin}/projects/${diagram}`, { waitUntil: "domcontentloaded" });
    await page
      .locator(".react-flow__node, .archer-seq-participant")
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await page
      .locator(".archer-emph-chevrons")
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    await settle(page, 800);
    return { result: await probeMotion(page, { sampleMs, cell }) };
  } catch (e) {
    return { error: String(e?.message ?? e).split("\n")[0] };
  } finally {
    await ctx.close();
  }
}

/** Harness journey: the six motion cells on the journeys project's flow diagram (it must carry a flow emphasis). */
export const meta = { name: "motion" };
export default async function journey({ step, sandbox, run, browser }) {
  const target = sandboxTarget(sandbox);
  const b = browser ?? (await chromium.launch());
  const report = {
    tool: "motion",
    generatedAt: new Date().toISOString(),
    target: { origin: target.origin, source: target.source },
    diagram: process.env.ARCHER_MOTION_DIAGRAM ?? "journeys/diagrams/flow.mmd",
    sampleMs: 2000,
    cells: [],
  };
  try {
    const storageState = await loginState(b, target);
    for (const cell of MOTION_CELLS)
      await step(`motion: ${cell.id}`, async () => {
        report.cells.push({
          cell: cell.id,
          gate: cell.gate,
          ...(await runCell(b, target, {
            cell,
            diagram: report.diagram,
            viewport: "1500x900",
            theme: "light",
            storageState,
            sampleMs: 2000,
          })),
        });
      });
  } finally {
    if (!browser) await b.close();
  }
  if (run?.dir) writeReport(run.dir, "motion", report, markdown(report));
}

async function cli() {
  const { values } = parseArgs({
    options: {
      ...TARGET_OPTIONS,
      diagram: { type: "string" },
      cells: { type: "string" },
      "sample-ms": { type: "string" },
    },
  });
  let target;
  try {
    target = resolveTarget(values);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  const cells = selectList(MOTION_CELLS, values.cells ?? process.env.ARCHER_MOTION_CELLS, (c) => c.id);
  const viewports = selectList(
    ["1500x900", "1000x800", "390x844", "320x640"],
    values.viewports ?? process.env.ARCHER_MEASURE_VIEWPORTS ?? "1500x900",
  );
  const themes = selectList(["light", "dark"], values.themes ?? process.env.ARCHER_MEASURE_THEMES ?? "light");
  const diagram = values.diagram ?? process.env.ARCHER_MOTION_DIAGRAM ?? `${target.slug}/diagrams/fulfilment.mmd`;
  const sampleMs = Number(values["sample-ms"] ?? 2000);
  const out = values.out ?? defaultOut("motion");
  const browser = await chromium.launch({ headless: !values.headed });
  const run = {
    tool: "motion",
    schema: "archer-motion/1",
    generatedAt: new Date().toISOString(),
    target: { origin: target.origin, source: target.source },
    diagram,
    sampleMs,
    cells: [],
  };
  try {
    const storageState = await loginState(browser, target);
    for (const vp of viewports)
      for (const theme of themes)
        for (const cell of cells) {
          const r = await runCell(browser, target, { cell, diagram, viewport: vp, theme, storageState, sampleMs });
          run.cells.push({
            cell: `${cell.id}@${vp}/${theme}`,
            motionCell: cell.id,
            gate: cell.gate,
            note: cell.note,
            viewport: vp,
            theme,
            ...r,
          });
          if (!values.json)
            process.stdout.write(
              `${cell.id}@${vp}/${theme} ${JSON.stringify(r.result ? { ...r.result.summary, verdict: r.result.verdict } : r.error)}\n`,
            );
        }
  } finally {
    await browser.close();
  }
  const paths = writeReport(out, "motion", run, markdown(run));
  process.stdout.write(`${values.json ? JSON.stringify(paths) : `motion: ${paths.json}\n        ${paths.md}`}\n`);
}

if (isMain(import.meta.url)) await cli();
