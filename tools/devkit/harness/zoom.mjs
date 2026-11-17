#!/usr/bin/env node
// G8 / G12. CLI: zoom.mjs --mode reflow|text --origin URL --login LINK [--surfaces P1,P3] [--out DIR]
// These collect evidence, not rubric scores. See ZOOM_LIMITS and the JSON's method/coverage fields.
import { chromium, firefox } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  STATES,
  TARGET_OPTIONS,
  blockDevHelpers,
  defaultOut,
  isMain,
  leaveState,
  loginState,
  mdTable,
  openState,
  resolveTarget,
  selectList,
  writeReport,
} from "./surfaces.mjs";

export const ZOOM_LIMITS = {
  reflow:
    "1280×2560 at 400% is modeled as 320×640 CSS px, desktop pointer, DPR 1. This exercises reflow and CSS width breakpoints, not browser zoom rasterization, DPR/resolution queries, browser chrome or OS magnification.",
  text: "Fallback freezes every light-DOM computed font size, then doubles it once. Pixel line heights remain fixed; unitless line heights scale naturally. It preserves CSS box dimensions but font-relative em/rem dimensions can change. It approximates text-only zoom, not native Firefox textZoom: no shadow DOM, iframe, pseudo-element or bitmap text coverage; JS measuring fonts sees overridden sizes. No CSS zoom, transform, deviceScaleFactor or devPixelsPerPx is used.",
  geometry:
    "DOM text ranges and clipping ancestors, text/text intersections, control bounds and baseline visible-content inventory. Findings require review: wrapping changes and responsive alternatives can explain inventory loss; text rectangles are not glyph masks. Below-fold vertically scrollable content is retained; the standard screen-reader-only clipping recipe is excluded. Hidden baseline content, non-text visual occlusion, canvas pixels, virtualized content and unreachable states need manual checks. Only diagram drawing descendants are exempt, never their controls; page-level horizontal scroll is always recorded.",
};

/** Self-contained page evaluator; no page mutation. Coordinates include below-fold content. */
export function inspectZoomLayout({ cap = 5000 } = {}) {
  const CONTROL =
    'button,input:not([type=hidden]),textarea,select,a[href],summary,[role=button],[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=combobox],[role=radio],[tabindex]:not([tabindex="-1"])';
  const CHROME = ".archer-canvas-controls,.react-flow__controls,.react-flow__panel,.archer-canvas-tools,[role=toolbar]";
  const DRAWING = ".react-flow__viewport,.archer-seq-canvas svg,.archer-journey svg,[data-zoom-two-dimensional]";
  // Diagram nodes may be tabbable. Tabbability alone does not make a node canvas chrome.
  const exempt = (el) =>
    !!el.closest(DRAWING) && !el.closest(CHROME) && !el.closest("button,input,textarea,select,a[href],summary");
  const path = (el) => {
    if (el.id) return `#${el.id}`;
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 5; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${n.id}`);
        break;
      }
      const cls = (n.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
      parts.unshift(
        n.tagName.toLowerCase() +
          (cls ? `.${cls}` : "") +
          `:nth-child(${[...(n.parentElement?.children ?? [])].indexOf(n) + 1})`,
      );
    }
    return parts.join(" > ");
  };
  const rect = (r) => ({
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  });
  const visible = (el) => {
    const s = getComputedStyle(el);
    for (let n = el; n; n = n.parentElement) {
      const ns = getComputedStyle(n),
        b = n.getBoundingClientRect();
      // Standard screen-reader-only recipe is deliberately visually clipped, not failed reflow.
      if (b.width <= 2 && b.height <= 2 && (ns.clip !== "auto" || ns.clipPath !== "none")) return false;
    }
    return (
      s.display !== "none" &&
      !["hidden", "collapse"].includes(s.visibility) &&
      el.getClientRects().length > 0 &&
      !el.closest('[hidden],[inert],[aria-hidden="true"]')
    );
  };
  const clippedBy = (el, r) => {
    const projected = { ...r };
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n),
        b = n.getBoundingClientRect();
      const left = b.left + n.clientLeft,
        top = b.top + n.clientTop;
      // Scrollable ancestors retain their content: report horizontal scrolling separately.
      const x =
        /^(hidden|clip)$/.test(s.overflowX) &&
        (projected.left < left - 1 || projected.right > left + n.clientWidth + 1);
      const y =
        /^(hidden|clip)$/.test(s.overflowY) && (projected.top < top - 1 || projected.bottom > top + n.clientHeight + 1);
      if (x || y) return { path: path(n), axes: [x && "x", y && "y"].filter(Boolean) };
      // A child below a scrollport can be brought into it. Outer clipping is evaluated against
      // that scrollport, rather than mistaking reachable below-fold text for lost content.
      if (/^(auto|scroll)$/.test(s.overflowX)) {
        projected.left = Math.max(left, Math.min(projected.left, left + n.clientWidth));
        projected.right = Math.max(left, Math.min(projected.right, left + n.clientWidth));
      }
      if (/^(auto|scroll)$/.test(s.overflowY)) {
        projected.top = Math.max(top, Math.min(projected.top, top + n.clientHeight));
        projected.bottom = Math.max(top, Math.min(projected.bottom, top + n.clientHeight));
      }
    }
    return null;
  };
  const horizontalScroll = [],
    clippedText = [],
    controlsOutsideViewport = [],
    clippedControls = [],
    inventory = [],
    texts = [];
  const root = document.documentElement;
  const width = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0);
  if (width > innerWidth + 1) horizontalScroll.push({ path: "document", overflowPx: width - innerWidth });
  let exemptTextCount = 0,
    visited = 0,
    truncated = false;
  for (const el of document.querySelectorAll("body *")) {
    if (++visited > cap) {
      truncated = true;
      break;
    }
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !visible(el)) continue;
    if (
      !exempt(el) &&
      el !== document.body &&
      el !== root &&
      el.clientWidth &&
      el.scrollWidth > el.clientWidth + 1 &&
      /^(auto|scroll)$/.test(getComputedStyle(el).overflowX)
    ) {
      // A drawing's containing scrollport is also exempt if its ONLY overflowing content is drawing content.
      const drawingOnly =
        el.matches(".react-flow,.archer-seq-canvas,.archer-journey,[data-zoom-two-dimensional]") &&
        ![...el.querySelectorAll(CONTROL)].some(
          (c) => !exempt(c) && c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1,
        );
      if (!drawingOnly) horizontalScroll.push({ path: path(el), overflowPx: el.scrollWidth - el.clientWidth });
    }
    const ownNodes = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    for (const node of ownNodes) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (exempt(el)) {
        exemptTextCount++;
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const boxes = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map(rect);
      if (!boxes.length) continue;
      const entry = { path: path(el), text };
      inventory.push({ kind: "text", ...entry });
      texts.push({ el, ...entry, boxes });
      for (const r of boxes) {
        const clip = clippedBy(el, r);
        if (clip) {
          clippedText.push({ ...entry, clippedBy: clip, box: r });
          break;
        }
      }
    }
    if (el.matches(CONTROL) && !exempt(el)) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const entry = {
        path: path(el),
        text: (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("placeholder") ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        box: rect(b),
      };
      inventory.push({ kind: "control", path: entry.path, text: entry.text });
      if (b.left < -1 || b.right > innerWidth + 1) controlsOutsideViewport.push(entry);
      const clip = clippedBy(el.parentElement, b);
      if (clip) clippedControls.push({ ...entry, clippedBy: clip });
      if (el.matches("input,textarea") && el.value && el.scrollWidth > el.clientWidth + 1)
        clippedControls.push({ ...entry, reason: "value requires internal scrolling" });
    }
  }
  const overlappingText = [];
  // Sweep by top; avoids the full all-pairs comparison on long documents.
  const fragments = texts.flatMap((t) => t.boxes.map((box) => ({ t, box }))).sort((a, b) => a.box.top - b.box.top);
  const pairs = new Set();
  for (let i = 0; i < fragments.length; i++) {
    const a = fragments[i];
    for (let j = i + 1; j < fragments.length && fragments[j].box.top < a.box.bottom - 2; j++) {
      const b = fragments[j];
      const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      const key = [a.t.path, b.t.path].sort().join("|");
      if (x > 2 && y > 2 && !pairs.has(key)) {
        // Ignore fragments clipped entirely out of a hiding ancestor.
        if (
          [a, b].some((f) => {
            const clip = clippedBy(f.t.el, f.box);
            return clip && !f.t.el.getBoundingClientRect().width;
          })
        )
          continue;
        pairs.add(key);
        overlappingText.push({
          first: { path: a.t.path, text: a.t.text },
          second: { path: b.t.path, text: b.t.text },
          overlap: { width: x, height: y },
        });
      }
    }
  }
  return {
    viewport: { width: innerWidth, height: innerHeight, coarse: matchMedia("(pointer:coarse)").matches },
    horizontalScroll,
    clippedText,
    overlappingText,
    controlsOutsideViewport,
    clippedControls,
    inventory,
    exemptTextCount,
    coverage: { visited, cap, truncated },
  };
}

async function quiet(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

function compare(before, after) {
  const key = (x) => `${x.kind}:${x.text}`;
  const remaining = new Map();
  for (const x of after.inventory) remaining.set(key(x), (remaining.get(key(x)) ?? 0) + 1);
  const lostContent = [];
  for (const x of before.inventory) {
    const n = remaining.get(key(x)) ?? 0;
    if (n) remaining.set(key(x), n - 1);
    else
      lostContent.push({
        ...x,
        reason: "baseline visible text/control missing after zoom; review responsive alternatives",
      });
  }
  const { inventory, ...result } = after;
  return {
    ...result,
    lostContent,
    baseline: { viewport: before.viewport, contentCount: before.inventory.length },
    contentCount: inventory.length,
  };
}

export async function probeReflow(page) {
  await quiet(page);
  const before = await page.evaluate(inspectZoomLayout);
  await page.setViewportSize({ width: 320, height: 640 });
  await quiet(page);
  return {
    ...compare(before, await page.evaluate(inspectZoomLayout)),
    zoom: { factor: 4, native: false, method: "320 CSS px desktop viewport", limits: ZOOM_LIMITS.reflow },
  };
}

/** Snapshot all sizes BEFORE writing, so inheritance never doubles descendants twice. */
export async function applyTextZoom(page, factor = 2) {
  if (!(factor > 0 && Number.isFinite(factor))) throw new Error("text zoom factor must be positive and finite");
  return page.evaluate((factor) => {
    const values = [...document.querySelectorAll("*")].map((el) => ({
      el,
      size: parseFloat(getComputedStyle(el).fontSize),
    }));
    for (const { el, size } of values)
      if (Number.isFinite(size)) el.style.setProperty("font-size", `${size * factor}px`, "important");
    return { factor, native: false, method: "computed-font-size snapshot override", elements: values.length };
  }, factor);
}

export async function probeTextZoom(page) {
  await quiet(page);
  const before = await page.evaluate(inspectZoomLayout);
  const zoom = await applyTextZoom(page);
  await quiet(page);
  return { ...compare(before, await page.evaluate(inspectZoomLayout)), zoom: { ...zoom, limits: ZOOM_LIMITS.text } };
}

/** Native Firefox prefs are never accepted on their name alone: probe explicit-px text too. */
export async function launchTextZoomBrowser({ headed = false } = {}) {
  const executable = firefox.executablePath();
  const availability = { firefoxExecutable: executable, firefoxInstalled: existsSync(executable) };
  if (!availability.firefoxInstalled)
    return {
      browser: await chromium.launch({ headless: !headed }),
      engine: "chromium",
      ...availability,
      reason:
        "Playwright Firefox is not installed; using font-size override fallback. Set PLAYWRIGHT_BROWSERS_PATH to the installed cache.",
    };
  // Default-font prefs affect inherited default text; they do not establish text zoom for authored px sizes.
  const prefs = { "browser.zoom.full": false, "font.size.variable.x-western": 32, "font.size.fixed.x-western": 26 };
  let experiment;
  const candidate = await firefox.launch({ headless: true, firefoxUserPrefs: prefs });
  try {
    const p = await candidate.newPage();
    await p.setContent(
      '<span id="t" style="font:20px monospace;display:inline-block">MMMM</span><div id="b" style="width:120px;height:30px"></div>',
    );
    experiment = await p.evaluate(() => ({
      explicitPxFontSize: parseFloat(getComputedStyle(document.querySelector("#t")).fontSize),
      nontextWidth: document.querySelector("#b").getBoundingClientRect().width,
    }));
  } finally {
    await candidate.close();
  }
  return {
    browser: await firefox.launch({ headless: !headed, firefoxUserPrefs: { "browser.zoom.full": false } }),
    engine: "firefox",
    ...availability,
    prefExperiment: { prefs, ...experiment },
    reason:
      "No native 2x text zoom established by the default-font prefs for explicit px text; using measured font-size override fallback. browser.zoom.full=false chooses the zoom mode, not the zoom amount.",
  };
}

export function zoomMarkdown(run) {
  return (
    `# ${run.tool} evidence\n\n${run.target.origin} · ${run.generatedAt}\n\nBrowser: ${run.browser.engine}. ${run.browser.reason ?? ""}\n\n${run.method}\n\n${run.limits.join("\n\n")}\n\n` +
    mdTable(
      [
        "surface/state",
        "theme",
        "horizontal scroll",
        "clipped text",
        "overlapping text",
        "lost content candidates",
        "controls outside/clipped",
        "coverage",
      ],
      run.cells.map((c) =>
        c.result
          ? [
              c.state,
              c.theme,
              c.result.horizontalScroll.length,
              c.result.clippedText.length,
              c.result.overlappingText.length,
              c.result.lostContent.length,
              `${c.result.controlsOutsideViewport.length}/${c.result.clippedControls.length}`,
              c.error ?? (c.result.coverage.truncated ? "TRUNCATED" : "measured"),
            ]
          : [c.state, c.theme, "", "", "", "", "", c.error ?? c.notAvailable ?? "unavailable"],
      ),
    )
  );
}

export async function runZoom({ target, mode = "reflow", surfaces, themes = "light", out, headed = false }) {
  if (!["reflow", "text"].includes(mode)) throw new Error("mode must be reflow or text");
  const launched =
    mode === "text"
      ? await launchTextZoomBrowser({ headed })
      : { browser: await chromium.launch({ headless: !headed }), engine: "chromium" };
  const { browser, ...browserEvidence } = launched;
  const applicable = STATES.filter((s) => (mode === "reflow" ? /^P[1-9]$/ : /^(P[123689]|P4)$/).test(s.surface));
  const states = selectList(applicable, surfaces, (s) => s.id);
  if (!states.length) {
    await browser.close();
    throw new Error("no applicable surfaces selected");
  }
  const selectedThemes = selectList(["light", "dark"], themes);
  if (!selectedThemes.length) {
    await browser.close();
    throw new Error("no themes selected");
  }
  const report = {
    tool: mode === "reflow" ? "zoom-reflow" : "zoom-text",
    schema: "archer-zoom/1",
    generatedAt: new Date().toISOString(),
    target: { origin: target.origin, source: target.source },
    browser: browserEvidence,
    method: mode === "reflow" ? ZOOM_LIMITS.reflow : ZOOM_LIMITS.text,
    limits: [
      ZOOM_LIMITS.geometry,
      ...(mode === "text"
        ? ["G12 spacing overrides are a separate check; this tool measures 200% text-only resizing."]
        : []),
    ],
    cells: [],
  };
  try {
    const storageState = await loginState(browser, target);
    for (const state of states)
      for (const theme of selectedThemes) {
        const context = await browser.newContext({
          viewport: mode === "reflow" ? { width: 1280, height: 2560 } : { width: 1500, height: 900 },
          deviceScaleFactor: 1,
          hasTouch: false,
          colorScheme: theme,
          reducedMotion: "reduce",
          ignoreHTTPSErrors: true,
          ...(!state.fresh ? { storageState } : {}),
        });
        let page;
        try {
          await blockDevHelpers(context);
          page = await context.newPage();
          const opened = await openState(page, state, target);
          const cell = { surface: state.surface, state: state.id, theme, ...opened };
          if (opened.ok) {
            cell.result = await (mode === "reflow" ? probeReflow : probeTextZoom)(page);
            if (!cell.result.contentCount) cell.error = "no visible text or controls measured; inspect screenshot";
          }
          report.cells.push(cell);
          if (out) {
            mkdirSync(out, { recursive: true });
            cell.screenshot = `${mode}-${state.id}-${theme}.png`;
            await page.screenshot({ path: join(out, cell.screenshot) }).catch((e) => {
              cell.screenshotError = String(e.message).split("\n")[0];
            });
          }
        } catch (e) {
          report.cells.push({
            surface: state.surface,
            state: state.id,
            theme,
            error: String(e.message).split("\n")[0],
          });
        } finally {
          if (page) await leaveState(page, state);
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
  const paths = out ? writeReport(out, report.tool, report, zoomMarkdown(report)) : null;
  return { report, paths };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { ...TARGET_OPTIONS, mode: { type: "string", default: "reflow" } } });
  try {
    const { report, paths } = await runZoom({
      target: resolveTarget(values),
      mode: values.mode,
      surfaces: values.surfaces ?? process.env.ARCHER_MEASURE_SURFACES,
      themes: values.themes ?? process.env.ARCHER_MEASURE_THEMES ?? "light",
      out: values.out ?? defaultOut(`zoom-${values.mode}`),
      headed: values.headed,
    });
    process.stdout.write(
      `${JSON.stringify({ tool: report.tool, browser: report.browser, cells: report.cells.length, unavailable: report.cells.filter((c) => !c.result).length, paths }, null, 2)}\n`,
    );
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}
