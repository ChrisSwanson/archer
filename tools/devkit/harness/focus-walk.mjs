#!/usr/bin/env node
// Focus walk (rubric ui-ux.md G3, G4): Tab (or Shift+Tab) through a surface and record, at every stop,
//   - the active element (through shadow roots) and its `aria-activedescendant`, resolved;
//   - whether the focused component is ENTIRELY hidden by author content (WCAG 2.4.11 minimum: partly covered
//     passes; full visibility is AAA 2.4.12, not judged). Hit-tested on a 5×5 grid of points inside its box with
//     every element made hit-testable for the probe (`pointer-events: auto`), so a covering overlay that ignores
//     the pointer still counts as covering. A box wholly outside the viewport after the browser's own scroll is hidden;
//   - the visible indicator, recorded separately (G4, 2.4.7): outline, box-shadow or a focus-within ring nearby, a
//     heuristic for the manual look (M2), never a verdict on its own.
// And per walk: the initial focus after the state opened (the M2 checkpoint), the cycle (does Tab reach the browser
// chrome and come back, or loop without it = a possible 2.1.2 trap, expected only inside a modal), and for dialog
// states the trap (Tab stays inside), Escape (closes) and the return destination (the launcher, or `<body>`).
//
// Library:  import { focusWalk, dialogCheck } from "./focus-walk.mjs";  await focusWalk(page, { maxStops: 60 })
// Journey:  node tools/devkit/harness/smoke.mjs --sandbox <n> --journey tools/devkit/harness/focus-walk.mjs
// CLI:      node tools/devkit/harness/focus-walk.mjs (--sandbox <n> | --origin <url> --login <link>)
//             [--surfaces …] [--viewports 1500x900] [--themes dark] [--max-stops 80] [--reverse] [--out dir]
// Writes <out>/focus-walk.json and <out>/focus-walk.md.
import { chromium } from "playwright";
import { parseArgs } from "node:util";
import {
  TARGET_OPTIONS,
  cellContext,
  defaultOut,
  isMain,
  journeyCells,
  leaveState,
  loginState,
  mdTable,
  openState,
  resolveTarget,
  selectCells,
  writeReport,
} from "./surfaces.mjs";

/** Init script: a log of focus moves (focusin), so a dialog's launcher is known after it opened. Self-contained. */
export function focusRecorder() {
  if (window.__focusLog) return;
  window.__focusLog = [];
  addEventListener(
    "focusin",
    (e) => {
      try {
        const el = e.composedPath()[0];
        if (!(el instanceof Element)) return;
        if (!el.dataset.fwId)
          el.dataset.fwId = String(window.__focusLog.length + 1) + "-" + Math.random().toString(36).slice(2, 7);
        window.__focusLog.push({
          id: el.dataset.fwId,
          tag: el.tagName.toLowerCase(),
          name: (
            el.getAttribute("aria-label") ??
            (el.getAttribute("aria-labelledby")
              ? el
                  .getAttribute("aria-labelledby")
                  .split(/\s+/)
                  .map((id) => document.getElementById(id)?.textContent ?? "")
                  .join(" ")
              : null) ??
            el.getAttribute("title") ??
            el.textContent ??
            el.getAttribute("placeholder") ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60),
          inDialog: !!el.closest("dialog[open], [role=dialog], [role=alertdialog], [aria-modal='true']"),
        });
      } catch {
        /* never break the page */
      }
    },
    true,
  );
}

/** In-page: the focused element now, judged for 2.4.11 and described. Self-contained. */
export function focusStop() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  const name = (n) =>
    (
      n.getAttribute?.("aria-label") ??
      (n.getAttribute?.("aria-labelledby")
        ? n
            .getAttribute("aria-labelledby")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        : null) ??
      n.getAttribute?.("title") ??
      n.textContent ??
      n.getAttribute?.("placeholder") ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const path = (n) => {
    const parts = [];
    for (
      let x = n;
      x && x !== document.body && x !== document.documentElement && parts.length < 4;
      x = x.parentElement
    ) {
      const cls =
        typeof x.className === "string"
          ? x.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".")
          : (x.getAttribute?.("class") ?? "").split(/\s+/).slice(0, 1).join("");
      parts.unshift(x.tagName.toLowerCase() + (x.id ? `#${x.id}` : cls ? `.${cls}` : ""));
    }
    return parts.join(" > ");
  };
  if (!el || el === document.body || el === document.documentElement)
    return { body: true, tag: el ? el.tagName.toLowerCase() : "none", path: "body" };
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
  document.head.appendChild(style);
  const judge = (n) => {
    let r = n.getBoundingClientRect();
    // SVG geometry boxes omit stroke paint. Horizontal/vertical edges have a zero axis even when visible.
    if (n instanceof SVGGraphicsElement && (r.width === 0 || r.height === 0)) {
      const graphics =
        n instanceof SVGGeometryElement
          ? [n]
          : [...n.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse")];
      let strokePad = 0;
      for (const graphic of graphics) {
        const style = getComputedStyle(graphic),
          matrix = graphic.getScreenCTM();
        if (style.stroke !== "none" && Number(style.strokeOpacity) > 0 && matrix) {
          strokePad = Math.max(
            strokePad,
            (parseFloat(style.strokeWidth) * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))) /
              2,
          );
        }
      }
      if (strokePad > 0)
        r = {
          left: r.left - strokePad,
          right: r.right + strokePad,
          top: r.top - strokePad,
          bottom: r.bottom + strokePad,
          width: r.width + strokePad * 2,
          height: r.height + strokePad * 2,
        };
    }
    const box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (r.width === 0 && r.height === 0) return { box, hidden: true, why: "zero-size", visiblePoints: 0, points: 0 };
    const x0 = Math.max(r.left, 0),
      x1 = Math.min(r.right, innerWidth),
      y0 = Math.max(r.top, 0),
      y1 = Math.min(r.bottom, innerHeight);
    if (x1 <= x0 || y1 <= y0) return { box, hidden: true, why: "outside-viewport", visiblePoints: 0, points: 0 };
    let visiblePoints = 0,
      points = 0;
    const coverers = new Map();
    // Painted: something at this point that a person would see over the focused element. Transparent layers (a
    // full-size overlay container with no background, such as an edge-label layer) do not hide anything.
    const GRAPHIC =
      /^(img|video|canvas|iframe|path|rect|circle|ellipse|line|polyline|polygon|text|tspan|use|image|input|textarea|select|button)$/i;
    const painted = (x) => {
      const st = getComputedStyle(x);
      if (st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      const alpha = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return c === "transparent" ? 0 : 1;
        const p = m[1].split(/[ ,/]+/).filter(Boolean);
        return p.length > 3 ? parseFloat(p[3]) : 1;
      };
      if (alpha(st.backgroundColor) > 0 || st.backgroundImage !== "none") return true;
      if (GRAPHIC.test(x.tagName)) return true;
      return alpha(st.color) > 0 && [...x.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    };
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) {
        const px = x0 + ((x1 - x0) * (i + 0.5)) / 5,
          py = y0 + ((y1 - y0) * (j + 0.5)) / 5;
        points++;
        let seen = false,
          cover = null;
        for (const hit of document.elementsFromPoint(px, py)) {
          if (hit === n || n.contains(hit)) {
            seen = true;
            break;
          }
          if (hit.contains(n)) continue; // an ancestor drawn under it
          if (painted(hit)) {
            cover = hit;
            break;
          }
        }
        if (seen) visiblePoints++;
        else {
          const k = cover ? path(cover) : "(clipped: not drawn here)";
          coverers.set(k, (coverers.get(k) ?? 0) + 1);
        }
      }
    return {
      box,
      hidden: visiblePoints === 0,
      why: visiblePoints === 0 ? "covered" : undefined,
      visiblePoints,
      points,
      coveredBy:
        visiblePoints < points
          ? [...coverers.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 2)
              .map(([k]) => k)
          : undefined,
    };
  };
  const s = getComputedStyle(el);
  const indicator = (n, st) => {
    const outline =
      st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0
        ? `${st.outlineWidth} ${st.outlineStyle} ${st.outlineColor}`
        : null;
    const shadow = st.boxShadow && st.boxShadow !== "none" ? st.boxShadow.slice(0, 80) : null;
    const filter = n instanceof SVGElement && st.filter !== "none" ? st.filter : null;
    return { outline, shadow, filter };
  };
  const own = indicator(el, s);
  let ring = own.outline || own.shadow || own.filter ? "own" : null;
  // Edge focus lives on its stroked path, while the focusable group suppresses the UA outline.
  if (!ring && el instanceof SVGElement)
    for (const child of el.querySelectorAll("*")) {
      const childStyle = getComputedStyle(child);
      if (
        childStyle.visibility === "visible" &&
        Number(childStyle.opacity) > 0 &&
        childStyle.filter.includes("drop-shadow")
      ) {
        ring = `descendant:${path(child)}`;
        break;
      }
    }
  if (!ring)
    for (let a = el.parentElement, k = 0; a && k < 3; a = a.parentElement, k++) {
      if (!a.matches(":focus-within")) continue;
      const i = indicator(a, getComputedStyle(a));
      if (i.outline || i.shadow || i.filter) {
        ring = `ancestor:${path(a)}`;
        break;
      }
    }
  const adId = el.getAttribute("aria-activedescendant");
  const ad = adId ? (el.getRootNode().getElementById?.(adId) ?? document.getElementById(adId)) : null;
  const result = {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") ?? undefined,
    name: name(el),
    path: path(el),
    id: el.dataset?.fwId,
    inDialog: !!el.closest("dialog[open], [role=dialog], [role=alertdialog], [aria-modal='true']"),
    focusVisible: el.matches(":focus-visible"),
    obscured: judge(el),
    indicator: { ...own, ring, detected: !!ring },
    activedescendant: adId
      ? ad
        ? {
            id: adId,
            name: name(ad),
            role: ad.getAttribute("role") ?? undefined,
            obscured: judge(ad),
            selected: ad.getAttribute("aria-selected") ?? undefined,
          }
        : { id: adId, missing: true }
      : undefined,
  };
  style.remove();
  return result;
}

const key = (s) => (s.body ? "body" : `${s.path}|${s.name}`);

/**
 * Walk the page: `maxStops` presses of Tab (Shift+Tab with `reverse`). Stops at the second time the first non-body
 * stop comes round (a full cycle). Returns { initial, stops, cycle, summary }.
 */
/** Wait for both native scroll geometry and finite animations. Smooth scrolling is not a CSS animation. */
export async function settleFocus(page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const until = performance.now() + 1500;
    let previous = null,
      stable = 0;
    do {
      await frame();
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const r = active?.getBoundingClientRect();
      const geometry = [scrollX, scrollY, r?.x, r?.y, r?.width, r?.height];
      for (let ancestor = active; ancestor; ancestor = ancestor.parentElement)
        geometry.push(ancestor.scrollLeft, ancestor.scrollTop);
      const current = JSON.stringify(geometry.map((value) => Math.round((value ?? 0) * 100)));
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      const busy = document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" && animation.effect?.getComputedTiming?.().iterations !== Infinity,
        );
      if (stable >= 4 && !busy) return;
    } while (performance.now() < until);
  });
}

export async function focusWalk(page, { maxStops = 80, reverse = false } = {}) {
  const initial = await page.evaluate(focusStop);
  const stops = [];
  let first = null,
    cycledAt = null,
    bodySeen = false;
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
    await settleFocus(page);
    const s = await page.evaluate(focusStop);
    s.n = i + 1;
    stops.push(s);
    if (s.body) {
      bodySeen = true;
      continue;
    }
    const k = key(s);
    if (first === null) first = k;
    else if (k === first) {
      cycledAt = i + 1;
      break;
    }
  }
  // The stop that closed the cycle repeats the first one: judge each stop once.
  const real = (cycledAt !== null ? stops.slice(0, -1) : stops).filter((s) => !s.body);
  const distinct = new Set(real.map(key)).size;
  const modal = await page.evaluate(
    () =>
      !!document.querySelector(
        "dialog[open][aria-modal='true'], [role=dialog][aria-modal='true'], [role=alertdialog][aria-modal='true'], dialog:modal",
      ),
  );
  const allInDialog = real.length > 0 && real.every((s) => s.inDialog);
  const cycle = {
    completed: cycledAt !== null,
    length: cycledAt,
    distinctStops: distinct,
    passesBrowserChrome: bodySeen,
    // A cycle that never leaves the page's content to the browser, outside a modal, keeps keyboard users in.
    possibleTrap: cycledAt !== null && !bodySeen && !(modal && allInDialog),
    modalContained: modal ? allInDialog : undefined,
  };
  const summary = {
    stops: real.length,
    distinct,
    entirelyHidden: real.filter((s) => s.obscured.hidden).length,
    activedescendantHidden: real.filter((s) => s.activedescendant?.obscured?.hidden).length,
    activedescendantMissing: real.filter((s) => s.activedescendant?.missing).length,
    noIndicatorDetected: real.filter((s) => !s.indicator.detected).length,
    notFocusVisible: real.filter((s) => !s.focusVisible).length,
    possibleTrap: cycle.possibleTrap,
    initial: initial.body ? "body" : `${initial.tag} "${initial.name}"`,
  };
  return { initial, stops, cycle, summary };
}

/**
 * For a state with an open dialog: the launcher (the last focus outside the dialog before focus entered it), the
 * trap (Tab and Shift+Tab stay inside), Escape (closes it), and where focus lands after.
 * Needs `focusRecorder` installed before the dialog opened.
 */
export async function dialogCheck(page, { presses = 25 } = {}) {
  const DIALOG = "dialog[open], [role=dialog], [role=alertdialog]";
  const open = async () =>
    page.evaluate((sel) => [...document.querySelectorAll(sel)].some((d) => d.getClientRects().length), DIALOG);
  if (!(await open())) return { dialog: false };
  const info = await page.evaluate((sel) => {
    const d = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length);
    const log = window.__focusLog ?? [];
    const firstIn = log.findIndex((f) => f.inDialog);
    const launcher =
      firstIn > 0
        ? log
            .slice(0, firstIn)
            .reverse()
            .find((f) => !f.inDialog)
        : null;
    return {
      role: d.getAttribute("role") ?? d.tagName.toLowerCase(),
      name:
        d.getAttribute("aria-label") ??
        (d.getAttribute("aria-labelledby")
          ? document.getElementById(d.getAttribute("aria-labelledby"))?.textContent?.trim()
          : null),
      modal: d.getAttribute("aria-modal") === "true" || d.matches("dialog:modal"),
      launcher,
      focusLogged: log.length,
    };
  }, DIALOG);
  const initial = await page.evaluate(focusStop);
  // Escaping = focus reaching page content outside the dialog. Passing through the browser's own chrome (`<body>`)
  // and coming back inside is how a native modal <dialog> behaves; it is recorded, not counted as an escape.
  const escaped = [];
  let viaBrowser = false;
  for (const dir of ["Tab", "Shift+Tab"])
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(dir);
      await settleFocus(page);
      const s = await page.evaluate(focusStop);
      if (s.body) {
        viaBrowser = true;
        continue;
      }
      if (!s.inDialog) {
        escaped.push({ dir, n: i + 1, to: `${s.tag} "${s.name}"` });
        break;
      }
    }
  // Escape is pressed from inside the dialog, as a keyboard user would.
  for (let i = 0; i < 4 && !(await page.evaluate(focusStop)).inDialog; i++) {
    await page.keyboard.press("Tab");
    await settleFocus(page);
  }
  const escapeFrom = await page.evaluate(focusStop);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const closed = !(await open());
  const after = await page.evaluate(focusStop);
  const returnedTo = after.body ? "body" : `${after.tag} "${after.name}"`;
  // The same element, or (re-rendered on close) one with the launcher's tag and name.
  const returnedToLauncher =
    !!info.launcher &&
    !after.body &&
    (after.id === info.launcher.id || (after.tag === info.launcher.tag && after.name === info.launcher.name));
  return {
    dialog: true,
    ...info,
    initialFocus: initial.body ? "body" : `${initial.tag} "${initial.name}"`,
    initialInside: !!initial.inDialog,
    trapped: escaped.length === 0,
    escaped,
    passesBrowserChrome: viaBrowser,
    escapeFrom: escapeFrom.body ? "body" : `${escapeFrom.tag} "${escapeFrom.name}"`,
    closesOnEscape: closed,
    returnedTo,
    returnedToLauncher,
    droppedToBody: closed && !!after.body,
  };
}

/** Walk one state on `page` (already opened). */
export async function walkState(page, state, opts = {}) {
  // Walk first (inside an open modal the walk stays in it), then the dialog's trap, Escape and return.
  const walk = await focusWalk(page, opts);
  const dialog = await dialogCheck(page);
  return { ...walk, dialog: dialog.dialog ? dialog : undefined };
}

function markdown(run) {
  let md =
    `# Focus walk (G3, G4)\n\nTarget: ${run.target.origin} (${run.target.source}) · ${run.generatedAt}\n\n` +
    "Hidden = the focused component is *entirely* hidden by author content (2.4.11 minimum). Indicator = outline or box-shadow on the element or a :focus-within ancestor (heuristic; M2 judges the ring). Trap = a Tab cycle that never reaches the browser chrome outside a modal.\n\n";
  md += mdTable(
    [
      "cell",
      "initial focus",
      "stops",
      "entirely hidden",
      "AD hidden/missing",
      "no indicator",
      "cycle",
      "possible trap",
      "dialog: trapped / Esc closes / returns to",
    ],
    run.cells.map((c) => {
      const r = c.result;
      if (!r)
        return [
          c.cell,
          c.notAvailable ? `not available: ${c.notAvailable}` : `error: ${c.error}`,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ];
      const d = r.dialog?.dialog
        ? `${r.dialog.trapped ? "yes" : "NO"} / ${r.dialog.closesOnEscape ? "yes" : "NO"} / ${r.dialog.returnedToLauncher ? "launcher" : r.dialog.returnedTo}`
        : "—";
      return [
        c.cell,
        r.summary.initial,
        r.summary.stops,
        r.summary.entirelyHidden,
        `${r.summary.activedescendantHidden}/${r.summary.activedescendantMissing}`,
        r.summary.noIndicatorDetected,
        r.cycle.completed ? r.cycle.length : "not closed",
        r.summary.possibleTrap ? "YES" : "no",
        d,
      ];
    }),
  );
  const hidden = run.cells.flatMap((c) =>
    (c.result?.stops ?? [])
      .filter((s) => !s.body && s.obscured.hidden)
      .map((s) => [c.cell, s.n, `${s.tag} "${s.name}"`, s.obscured.why, (s.obscured.coveredBy ?? []).join("; ")]),
  );
  if (hidden.length)
    md +=
      `\n## Entirely hidden stops\n\n` + mdTable(["cell", "stop", "element", "why", "covered by"], hidden.slice(0, 80));
  const noRing = run.cells.flatMap((c) =>
    (c.result?.stops ?? [])
      .filter((s) => !s.body && !s.indicator.detected)
      .map((s) => [c.cell, s.n, `${s.tag} "${s.name}"`, s.path]),
  );
  if (noRing.length)
    md +=
      `\n## Stops with no indicator detected (check by eye, M2)\n\n` +
      mdTable(["cell", "stop", "element", "path"], noRing.slice(0, 80));
  return md;
}

/** Harness journey: walk a few states of the sandbox; written to the run dir as focus-walk.json / .md. */
export const meta = { name: "focus-walk" };
export default async function journey(args) {
  await args.context.addInitScript(focusRecorder);
  await journeyCells(args, {
    tool: "focus-walk",
    states: ["P1.overview", "P1.filters", "P2.project", "P4.explore.flowchart", "P8.settings"],
    measure: (page, s) => walkState(page, s, { maxStops: 60 }),
    render: markdown,
  });
}

async function cli() {
  const { values } = parseArgs({
    options: { ...TARGET_OPTIONS, "max-stops": { type: "string" }, reverse: { type: "boolean" } },
  });
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
      "P1.overview,P1.filters,P2.project,P3.note,P4.explore.flowchart,P4.explore.sequence,P4.edit,P5.discard,P7.review,P8.settings,P8.project-settings,P11.compare",
    viewports: values.viewports ?? process.env.ARCHER_MEASURE_VIEWPORTS ?? "1500x900",
    themes: values.themes ?? process.env.ARCHER_MEASURE_THEMES ?? "dark",
  });
  const out = values.out ?? defaultOut("focus-walk");
  const maxStops = Number(values["max-stops"] ?? 80);
  const browser = await chromium.launch({ headless: !values.headed });
  const run = {
    tool: "focus-walk",
    schema: "archer-focus-walk/1",
    generatedAt: new Date().toISOString(),
    target: { origin: target.origin, source: target.source },
    selection: {
      states: sel.states.map((s) => s.id),
      viewports: sel.viewports,
      themes: sel.themes,
      maxStops,
      reverse: !!values.reverse,
    },
    cells: [],
  };
  try {
    const state = await loginState(browser, target);
    for (const vp of sel.viewports)
      for (const theme of sel.themes)
        for (const s of sel.states) {
          const cell = `${s.id}@${vp}/${theme}${values.reverse ? "/reverse" : ""}`;
          const ctx = await cellContext(browser, { viewport: vp, theme, storageState: s.fresh ? undefined : state });
          await ctx.addInitScript(focusRecorder);
          try {
            const page = await ctx.newPage();
            const opened = await openState(page, s, target);
            if (!opened.ok) {
              run.cells.push({ cell, state: s.id, viewport: vp, theme, ...opened });
            } else {
              const result = await walkState(page, s, { maxStops, reverse: !!values.reverse });
              run.cells.push({ cell, state: s.id, viewport: vp, theme, url: opened.url, result });
              await leaveState(page, s);
            }
          } finally {
            await ctx.close();
          }
          const last = run.cells.at(-1);
          if (!values.json)
            process.stdout.write(
              `${cell} ${JSON.stringify(last.result?.summary ?? last.notAvailable ?? last.error)}${last.result?.dialog?.dialog ? " dialog=" + JSON.stringify({ trapped: last.result.dialog.trapped, esc: last.result.dialog.closesOnEscape, to: last.result.dialog.returnedTo, launcher: last.result.dialog.returnedToLauncher }) : ""}\n`,
            );
        }
  } finally {
    await browser.close();
  }
  const paths = writeReport(out, "focus-walk", run, markdown(run));
  process.stdout.write(
    `${values.json ? JSON.stringify(paths) : `focus-walk: ${paths.json}\n            ${paths.md}`}\n`,
  );
}

if (isMain(import.meta.url)) await cli();
