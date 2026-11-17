#!/usr/bin/env node
// Target census (rubric ui-ux.md G7): every pointer target's box in each cell, judged twice.
//
//   [W] WCAG 2.2 SC 2.5.8 Target Size (Minimum): a target passes when it is at least 24×24 CSS px, or when a 24 px
//       diameter circle centred on its bounding box intersects no other target and no other undersized target's
//       circle (the spacing exception). The SC's other exceptions are recorded per target as *candidates*, never
//       as passes: `inline` (a link in a sentence or block of text), `user-agent` (a native control the author
//       did not size), `canvas` (a node or edge in the drawing: the "essential" presentation, a project decision),
//       and `equivalent` (only by an approved exception record; this tool cannot see one).
//   [H] Archer policy (DESIGN.md): ≥ 44 px in both dimensions under `(pointer: coarse)`. A separate column, judged
//       only in cells where the coarse pointer matches.
//
// Library:  import { collectTargets, judgeTargets, censusPage } from "./targets.mjs"
//           const r = await censusPage(page)            // inside any harness journey: r.summary, r.targets
// Journey:  node tools/devkit/harness/smoke.mjs --sandbox <n> --journey tools/devkit/harness/targets.mjs
// CLI:      node tools/devkit/harness/targets.mjs (--sandbox <n> | --origin <url> --login <link>)
//             [--surfaces P1,P4.*] [--viewports 1500x900,390x844] [--themes light,dark] [--out dir] [--all-targets]
// Writes <out>/targets.json and <out>/targets.md. Exit 0 always (a census is a measurement); 2 on usage errors.
import { chromium } from "playwright";
import { parseArgs } from "node:util";
import {
  TARGET_OPTIONS,
  cellContext,
  journeyCells,
  defaultOut,
  isMain,
  leaveState,
  loginState,
  mdTable,
  openState,
  resolveTarget,
  selectCells,
  writeReport,
} from "./surfaces.mjs";

/** In-page: every visible pointer target with its box and the facts the exceptions need. Self-contained. */
export function collectTargets() {
  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "label[for]",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=menuitemcheckbox]",
    "[role=menuitemradio]",
    "[role=option]",
    "[role=slider]",
    "[role=spinbutton]",
    "[role=combobox]",
    "[role=treeitem]",
    "[tabindex]:not([tabindex='-1'])",
    "[contenteditable=''], [contenteditable=true]",
    ".react-flow__node",
    ".react-flow__edge",
    ".react-flow__handle",
    ".archer-seq-participant",
    ".archer-seq-message",
  ].join(", ");
  const CANVAS = ".react-flow__viewport, .react-flow__renderer, .archer-seq-canvas svg, .archer-journey svg";
  const name = (el) =>
    (
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      el.textContent ??
      el.getAttribute("placeholder") ??
      el.getAttribute("value") ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      const cls =
        typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
      parts.unshift(n.tagName.toLowerCase() + (n.id ? `#${n.id}` : cls ? `.${cls}` : ""));
    }
    return parts.join(" > ");
  };
  const rendered = (el) => {
    if (!el.getClientRects().length || el.closest("[aria-hidden='true'], [inert]")) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none" && Number(s.opacity) > 0;
  };
  const els = [...new Set(document.querySelectorAll(SELECTOR))].filter(rendered).filter((el) => {
    // A Tab stop for native overflow scrolling is a keyboard destination, not a pointer action.
    // Keep authored controls (including separators) and clickable custom elements in the census.
    const style = getComputedStyle(el);
    const scrollOnly =
      el.tabIndex >= 0 &&
      (!el.getAttribute("role") || /^(group|region)$/.test(el.getAttribute("role"))) &&
      /^(DIV|SECTION|PRE|ARTICLE)$/.test(el.tagName) &&
      !el.onclick &&
      !el.hasAttribute("onclick") &&
      style.cursor !== "pointer" &&
      ((/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) ||
        (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth));
    return !scrollOnly;
  });
  // A label wrapping or naming a control is part of that control's target: measure the union, once.
  const out = [];
  const seen = new Set();
  for (const el of els) {
    if (seen.has(el)) continue;
    let r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    let target = el;
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      const lab = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (lab) {
        const lr = lab.getBoundingClientRect();
        r = {
          left: Math.min(r.left, lr.left),
          top: Math.min(r.top, lr.top),
          right: Math.max(r.right, lr.right),
          bottom: Math.max(r.bottom, lr.bottom),
        };
        r = { ...r, width: r.right - r.left, height: r.bottom - r.top };
        seen.add(lab);
        target = lab;
      }
    }
    if (el.tagName === "LABEL") {
      const c = el.control;
      if (c && els.includes(c)) continue;
    }
    // Nested targets (a button inside a link, a node's inner button): the inner one is measured; the outer keeps its own box.
    const s = getComputedStyle(el);
    const block = el.parentElement?.closest("p, li, td, dd, blockquote, figcaption, .archer-note-body, article");
    const inlineText =
      el.tagName === "A" &&
      s.display.startsWith("inline") &&
      !!block &&
      [...block.childNodes].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim().length > 0);
    const userAgent =
      el.tagName === "INPUT" &&
      /^(checkbox|radio|range|color|file)$/.test(el.type) &&
      s.appearance !== "none" &&
      !el.style.width &&
      !el.style.height;
    const canvas =
      !!el.closest(CANVAS) ||
      /react-flow__(node|edge|handle)|archer-seq-(participant|message)/.test(
        typeof el.className === "string" ? el.className : (el.getAttribute("class") ?? ""),
      );
    out.push({
      i: out.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? undefined,
      name: name(target === el ? el : target),
      path: path(el),
      box: {
        x: Math.round(r.left * 10) / 10,
        y: Math.round(r.top * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
      },
      inViewport: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
      candidates: [inlineText && "inline", userAgent && "user-agent", canvas && "canvas"].filter(Boolean),
    });
  }
  return {
    coarse: matchMedia("(pointer: coarse)").matches,
    viewport: { width: innerWidth, height: innerHeight },
    targets: out,
  };
}

/** Distance from point (cx, cy) to rectangle b (0 inside it). */
function distToRect(cx, cy, b) {
  const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w));
  const dy = Math.max(b.y - cy, 0, cy - (b.y + b.h));
  return Math.hypot(dx, dy);
}
const contains = (outer, inner) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.w <= outer.x + outer.w + 0.5 &&
  inner.y + inner.h <= outer.y + outer.h + 0.5;

/**
 * Judge collected targets. Pure (unit-tested without a browser).
 * Each target gains `w` ('size' | 'spacing' | 'fail') with `conflicts` (indices) on fail, and `h44` (true/false, or
 * null when the cell is not coarse). Targets that contain or sit inside another target are not each other's
 * neighbours (a button drawn inside a node is one stack, judged against the rest of the page).
 */
export function judgeTargets({ targets, coarse }, { min = 24, coarseMin = 44 } = {}) {
  const radius = min / 2;
  const under = (t) => t.box.w < min - 0.01 || t.box.h < min - 0.01;
  const centre = (t) => [t.box.x + t.box.w / 2, t.box.y + t.box.h / 2];
  const judged = targets.map((t) => ({ ...t }));
  for (const t of judged) {
    if (!under(t)) {
      t.w = "size";
      continue;
    }
    const [cx, cy] = centre(t);
    const conflicts = [];
    for (const o of judged) {
      if (o === t || contains(o.box, t.box) || contains(t.box, o.box)) continue;
      const hitsTarget = distToRect(cx, cy, o.box) < radius - 0.01;
      const [ox, oy] = centre(o);
      const hitsCircle = under(o) && Math.hypot(cx - ox, cy - oy) < 2 * radius - 0.01;
      if (hitsTarget || hitsCircle) conflicts.push(o.i);
    }
    t.w = conflicts.length ? "fail" : "spacing";
    if (conflicts.length) t.conflicts = conflicts.slice(0, 6);
  }
  for (const t of judged) t.h44 = coarse ? t.box.w >= coarseMin - 0.01 && t.box.h >= coarseMin - 0.01 : null;
  const fails = judged.filter((t) => t.w === "fail");
  const summary = {
    targets: judged.length,
    w: {
      size: judged.filter((t) => t.w === "size").length,
      spacing: judged.filter((t) => t.w === "spacing").length,
      fail: fails.length,
      failNoCandidate: fails.filter((t) => t.candidates.length === 0).length,
      failWithCandidate: fails.filter((t) => t.candidates.length > 0).length,
    },
    h44: coarse
      ? {
          applies: true,
          pass: judged.filter((t) => t.h44).length,
          fail: judged.filter((t) => t.h44 === false && !t.candidates.includes("canvas")).length,
          failCanvas: judged.filter((t) => t.h44 === false && t.candidates.includes("canvas")).length,
        }
      : { applies: false },
  };
  return { summary, targets: judged };
}

/** Census the page as it is now (a library call for any journey or script). */
export async function censusPage(page, options) {
  return judgeTargets(await page.evaluate(collectTargets), options);
}

/** Harness journey: a census of a few states on the sandbox, written to the run dir as targets.json / targets.md. */
export const meta = { name: "targets" };
export default async function journey(args) {
  await journeyCells(args, {
    tool: "targets",
    states: ["P1.overview", "P2.project", "P4.explore.flowchart", "P4.explore.sequence", "P8.settings"],
    measure: (page) => censusPage(page),
    render: markdown,
  });
}

function markdown(run) {
  let md =
    `# Target census (G7)\n\nTarget: ${run.target.origin} (${run.target.source}) · ${run.generatedAt}\n\n` +
    "[W] 2.5.8: `size` ≥ 24×24; `spacing` passes the 24 px circle test; `fail` neither. Fails are split by whether an exception *candidate* applies (inline, user-agent, canvas); a candidate is not an approved exception. [H] 44 px under `pointer: coarse`, coarse cells only.\n\n";
  md += mdTable(
    [
      "cell",
      "targets",
      "[W] size",
      "[W] spacing",
      "[W] fail (no candidate)",
      "[W] fail (candidate)",
      "[H] 44 fail (chrome)",
      "[H] 44 fail (canvas)",
    ],
    run.cells.map((c) =>
      c.result
        ? [
            c.cell,
            c.result.summary.targets,
            c.result.summary.w.size,
            c.result.summary.w.spacing,
            c.result.summary.w.failNoCandidate,
            c.result.summary.w.failWithCandidate,
            c.result.summary.h44.applies ? c.result.summary.h44.fail : "n/a",
            c.result.summary.h44.applies ? c.result.summary.h44.failCanvas : "n/a",
          ]
        : [c.cell, c.notAvailable ? `not available: ${c.notAvailable}` : `error: ${c.error}`, "", "", "", "", "", ""],
    ),
  );
  const worst = run.cells.flatMap((c) =>
    (c.result?.targets ?? []).filter((t) => t.w === "fail" && !t.candidates.length).map((t) => ({ cell: c.cell, t })),
  );
  const byName = new Map();
  for (const { cell, t } of worst) {
    const k = `${t.name} — ${t.path}`;
    const e = byName.get(k) ?? { k, box: t.box, cells: [] };
    e.cells.push(cell);
    byName.set(k, e);
  }
  if (byName.size)
    md +=
      `\n## [W] failures without an exception candidate (distinct targets)\n\n` +
      mdTable(
        ["target", "box (w×h)", "cells"],
        [...byName.values()]
          .slice(0, 60)
          .map((e) => [
            e.k,
            `${e.box.w}×${e.box.h}`,
            e.cells.length > 4 ? `${e.cells.slice(0, 4).join(", ")} +${e.cells.length - 4}` : e.cells.join(", "),
          ]),
      );
  return md;
}

async function cli() {
  const { values } = parseArgs({ options: { ...TARGET_OPTIONS, "all-targets": { type: "boolean" } } });
  let target;
  try {
    target = resolveTarget(values);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  const sel = selectCells({
    surfaces:
      values.surfaces ??
      process.env.ARCHER_MEASURE_SURFACES ??
      "P1.overview,P1.filters,P2.project,P3.note,P4.explore.flowchart,P4.explore.sequence,P4.edit,P5.new,P7.review,P8.settings,P9.front-door,P11.compare",
    viewports: values.viewports ?? process.env.ARCHER_MEASURE_VIEWPORTS ?? "1500x900,390x844",
    themes: values.themes ?? process.env.ARCHER_MEASURE_THEMES ?? "light",
  });
  const out = values.out ?? defaultOut("targets");
  const browser = await chromium.launch({ headless: !values.headed });
  const run = {
    tool: "targets",
    schema: "archer-targets/1",
    generatedAt: new Date().toISOString(),
    target: { origin: target.origin, source: target.source },
    selection: { states: sel.states.map((s) => s.id), viewports: sel.viewports, themes: sel.themes },
    cells: [],
  };
  try {
    const state = await loginState(browser, target);
    for (const vp of sel.viewports)
      for (const theme of sel.themes)
        for (const s of sel.states) {
          const cell = `${s.id}@${vp}/${theme}`;
          const ctx = await cellContext(browser, { viewport: vp, theme, storageState: s.fresh ? undefined : state });
          try {
            const page = await ctx.newPage();
            const opened = await openState(page, s, target);
            if (!opened.ok) {
              run.cells.push({ cell, state: s.id, viewport: vp, theme, ...opened });
              continue;
            }
            const result = await censusPage(page);
            if (!values["all-targets"])
              result.targets = result.targets.filter((t) => t.w === "fail" || t.h44 === false);
            run.cells.push({ cell, state: s.id, viewport: vp, theme, url: opened.url, result });
            await leaveState(page, s);
          } finally {
            await ctx.close();
          }
          if (!values.json)
            process.stdout.write(
              `${cell} ${JSON.stringify(run.cells.at(-1).result?.summary ?? run.cells.at(-1).notAvailable ?? run.cells.at(-1).error)}\n`,
            );
        }
  } finally {
    await browser.close();
  }
  const paths = writeReport(out, "targets", run, markdown(run));
  process.stdout.write(
    `${values.json ? JSON.stringify({ ...paths }) : `targets: ${paths.json}\n         ${paths.md}`}\n`,
  );
}

if (isMain(import.meta.url)) await cli();
