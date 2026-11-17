#!/usr/bin/env node
/** V6 label geometry, usable inside a harness step:
 *   const result = await runLabels({page, step, run}, {out: run.dir});
 * Standalone: node tools/devkit/harness/labels.mjs --url <access-link> --surface <diagram-url> --out <dir>
 * Use --surface <project-url-ending-in-slash> to visit all seven Pageturner family fixtures.
 * Every visible text run inside diagram content is measured, including text hidden only from AT.
 * Boxes are glyph-line Range boxes in viewport CSS px; a positive intersection >0.5px on BOTH axes
 * counts once per pair of runs. Parent containers and SVG <text>/<tspan> copies are never counted twice.
 * Rendered font px = computed font-size × cumulative y-axis transform scale (SVG: screen CTM).
 * Sizes are evidence, not an invented readability threshold: V6 still needs a human legibility review.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FAMILY_FIXTURES = [
  { family: "flowchart", fixture: "system-context.mmd" },
  { family: "sequence", fixture: "checkout.mmd" },
  { family: "state", fixture: "order-lifecycle.mmd" },
  { family: "er", fixture: "data-model.mmd" },
  { family: "c4", fixture: "containers.mmd" },
  { family: "architecture", fixture: "deployment.mmd" },
  { family: "journey", fixture: "buying-a-book.mmd" },
];

export const DIAGRAM_LABEL_CONTENT = ".react-flow__node, .archer-edge-label, .archer-seq-viewport, .archer-journey";
const CONTENT = DIAGRAM_LABEL_CONTENT;

/** Shared readiness for direct and family contrast runs; an empty stable layout is not ready. */
export async function waitForDiagramLabels(page, { timeout = 10000, title } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    ({ selector, title }) => {
      if (title !== undefined && ![...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === title))
        return false;
      if (
        document.querySelector('[role="status"][aria-busy="true"]') ||
        [...document.querySelectorAll("p")].some((p) => /^Loading(?:\.\.\.|…)$/u.test(p.textContent.trim()))
      )
        return false;
      return [...document.querySelectorAll(selector)].some((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim()) continue;
          let visible = true;
          for (let el = node.parentElement; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (
              style.display === "none" ||
              style.visibility !== "visible" ||
              Number(style.opacity) === 0 ||
              /inset\(50%\)/.test(style.clipPath) ||
              style.clip === "rect(0px, 0px, 0px, 0px)" ||
              el.matches("defs,title,desc,script,style,[hidden],.sr-only,.archer-sr-only,.visually-hidden")
            ) {
              visible = false;
              break;
            }
          }
          if (!visible) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (
            [...range.getClientRects()].some(
              (r) =>
                r.width > 0.5 &&
                r.height > 0.5 &&
                r.right > 0 &&
                r.bottom > 0 &&
                r.left < innerWidth &&
                r.top < innerHeight,
            )
          )
            return true;
        }
        return false;
      });
    },
    { selector: CONTENT, title },
    { polling: "raf", timeout },
  );
}

/** Resolve the address against the product inventory, rather than a recovered reader selection. */
export async function waitForAddressedDiagramLabels(page, url, options = {}) {
  const address = new URL(url);
  const match = /^(.*\/projects\/[^/]+\/)(.+)\.mmd$/.exec(address.pathname);
  if (!match) throw new Error(`Not a project diagram address: ${url}`);
  const inventoryUrl = new URL("api/diagrams", address.origin + match[1].replace("/projects/", "/p/")).href;
  const inventory = await page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Diagram inventory answered ${response.status}`);
    return response.json();
  }, inventoryUrl);
  const path = decodeURIComponent(match[2]) + ".mmd";
  const view =
    inventory.views.find((v) => v.sourcePath === path) ??
    inventory.views.find((v) => v.id === path.replace(/^diagrams\//, "").replace(/\.mmd$/, ""));
  if (typeof view?.title !== "string") throw new Error(`No diagram title in inventory for ${path}`);
  await waitForDiagramLabels(page, { ...options, title: view.title });
}

// V6's readable floor applies to the opening framing; an explicit Fit shows the whole drawing and may go
// smaller (AM-R1-02, decided 2026-10-31). So measure as opened by default; `fit: true` still measures after Fit.
export async function measureLabels(
  page,
  { fit = false, family = null, fixture = null, selector = CONTENT, timeout = 10000 } = {},
) {
  await page.evaluate(() => document.fonts.ready);
  let fitApplied = false;
  if (fit) {
    const button = page.getByRole("button", { name: "Fit view", exact: true }).first();
    if ((await button.count()) && (await button.isVisible())) {
      const vp = page.viewportSize();
      if (vp) await page.mouse.move(vp.width / 2, vp.height / 2);
      await button.click();
      fitApplied = true;
    }
  }
  // A condition over animation frames, rather than a sleep or a test retry. Reject a moving canvas.
  let layoutReady = true;
  try {
    await page.waitForFunction(
      (selector) => {
        const boxes = [...document.querySelectorAll(selector)].map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 1000));
        });
        const loading =
          document.querySelector('[role="status"][aria-busy="true"]') ||
          [...document.querySelectorAll("p")].some((p) => /^Loading(?:\.\.\.|…)$/u.test(p.textContent.trim()));
        if (!boxes.length || loading) {
          delete window.__archerLabelGeometry;
          return false;
        }
        const value = JSON.stringify(boxes);
        const old = window.__archerLabelGeometry;
        const stable = old?.value === value ? old.stable + 1 : 0;
        window.__archerLabelGeometry = { value, stable };
        return stable >= 3;
      },
      selector,
      { polling: "raf", timeout },
    );
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    layoutReady = false;
  }
  const labels = await page.evaluate((selector) => {
    const roots = [...document.querySelectorAll(selector)].filter(
      (el, i, all) => !all.some((other, j) => i !== j && other.contains(el)),
    );
    const seen = new Set();
    const result = [];
    const visible = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0)
          return false;
        if (
          /inset\(50%\)/.test(s.clipPath) ||
          s.clip === "rect(0px, 0px, 0px, 0px)" ||
          p.matches("defs, title, desc, script, style, [hidden], .sr-only, .archer-sr-only, .visually-hidden")
        )
          return false;
      }
      return true;
    };
    const scale = (el) => {
      if (el instanceof SVGGraphicsElement) {
        const m = el.getScreenCTM();
        return m ? Math.hypot(m.c, m.d) : 1;
      }
      let m = new DOMMatrix();
      for (let p = el; p; p = p.parentElement) {
        const transform = getComputedStyle(p).transform;
        if (transform !== "none") m = new DOMMatrix(transform).multiply(m);
      }
      return Math.hypot(m.c, m.d);
    };
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      const root = roots[rootIndex];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const el = node.parentElement;
        const text = node.textContent.replace(/\s+/g, " ").trim();
        if (!text || seen.has(node) || !visible(el)) continue;
        seen.add(node);
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
        if (!rects.length) continue;
        const style = getComputedStyle(el);
        const cssFontPx = parseFloat(style.fontSize);
        const transformScale = scale(el);
        const owner = el.closest("[data-id], [data-edge-id], [data-participant-id], [data-message-id]");
        result.push({
          text,
          tag: el.tagName.toLowerCase(),
          className: el.getAttribute("class") ?? "",
          owner:
            owner?.getAttribute("data-id") ??
            owner?.getAttribute("data-edge-id") ??
            owner?.getAttribute("data-participant-id") ??
            owner?.getAttribute("data-message-id") ??
            null,
          root: rootIndex,
          cssFontPx,
          transformScale,
          renderedFontPx: cssFontPx * transformScale,
          rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
        });
      }
    }
    return result;
  }, selector);
  const overlaps = [];
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      let largest = null;
      for (const a of labels[i].rects)
        for (const b of labels[j].rects) {
          const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (width > 0.5 && height > 0.5 && (!largest || width * height > largest.area))
            largest = { width, height, area: width * height };
        }
      if (largest) overlaps.push({ labels: [i, j], ...largest });
    }
  const sizes = labels.map((l) => l.renderedFontPx);
  const complete = layoutReady && labels.length > 0;
  return {
    schema: "archer-labels/1",
    criterion: "V6",
    status: !complete ? "incomplete" : overlaps.length ? "fail" : "pass",
    pass: complete && overlaps.length === 0,
    url: page.url(),
    family,
    fixture,
    fit: fitApplied ? "explicit-fit" : fit ? "natural-layout-no-fit-control" : "as-rendered",
    complete,
    ok: complete && overlaps.length === 0,
    ...(complete
      ? {}
      : { incompleteReason: "No rendered diagram labels or layout not ready; this surface was not measured." }),
    counts: { labels: labels.length, overlaps: overlaps.length },
    minRenderedFontPx: sizes.length ? Math.min(...sizes) : null,
    maxRenderedFontPx: sizes.length ? Math.max(...sizes) : null,
    distinctRenderedFontPx: [...new Set(sizes)].sort((a, b) => a - b),
    labels,
    overlaps,
    limits: [
      "Axis-aligned glyph-line boxes, not glyph silhouettes.",
      "Manual reading and key/selection/emphasis distinctions remain outside this measurement.",
    ],
  };
}

/** Read-only family fixture journey. projectUrl is the canonical /projects/<slug>/ URL. */
export async function measureLabelFixtures(page, { projectUrl, fixtures = FAMILY_FIXTURES } = {}) {
  if (!projectUrl?.endsWith("/")) throw new Error("projectUrl must be the project directory URL ending in /");
  const results = [];
  for (const { family, fixture } of fixtures) {
    const url = new URL(`diagrams/${fixture}`, projectUrl).href;
    try {
      await page.goto(url);
      await waitForAddressedDiagramLabels(page, url);
      results.push(await measureLabels(page, { family, fixture }));
    } catch (error) {
      results.push({
        family,
        fixture,
        url,
        complete: false,
        ok: false,
        pass: false,
        status: "incomplete",
        error: String(error.message),
        counts: { labels: 0, overlaps: 0 },
      });
    }
  }
  const complete = results.length > 0 && results.every((r) => r.complete);
  const pass = complete && results.every((r) => r.pass);
  const counts = {
    families: results.length,
    labels: results.reduce((n, r) => n + r.counts.labels, 0),
    overlaps: results.reduce((n, r) => n + r.counts.overlaps, 0),
  };
  return {
    schema: "archer-labels/1",
    criterion: "V6",
    projectUrl,
    complete,
    ok: pass,
    pass,
    status: !complete ? "incomplete" : pass ? "pass" : "fail",
    counts,
    results,
    summary: `# Label geometry per family\n\n${!complete ? "INCOMPLETE" : pass ? "PASS" : "FAIL"} · ${counts.families} families, ${counts.labels} text runs, ${counts.overlaps} overlapping pairs.\n\n| Family | Fixture | Runs | Overlaps | Min px | Max px | Status |\n|---|---|---:|---:|---:|---:|---|\n${results.map((r) => `| ${r.family} | ${r.fixture} | ${r.counts.labels} | ${r.counts.overlaps} | ${r.minRenderedFontPx ?? "n/a"} | ${r.maxRenderedFontPx ?? "n/a"} | ${r.status} |`).join("\n")}\n`,
  };
}

export function labelsMarkdown(result) {
  return `# Label geometry\n\n${result.complete ? (result.ok ? "PASS" : "FAIL") : "INCOMPLETE"} · ${result.family ?? "unspecified family"} · ${result.fixture ?? result.url}\n\n${result.counts.labels} text runs; ${result.counts.overlaps} overlapping pairs. Rendered font size ${result.minRenderedFontPx ?? "n/a"}–${result.maxRenderedFontPx ?? "n/a"} px (${result.fit}).\n\n${result.incompleteReason ?? "Font sizes are recorded for human readability review; no undocumented minimum is imposed."}\n\n${result.overlaps.map((o) => `- ${JSON.stringify(result.labels[o.labels[0]].text)} / ${JSON.stringify(result.labels[o.labels[1]].text)}: ${o.width.toFixed(2)} × ${o.height.toFixed(2)} px`).join("\n")}\n`;
}

export async function runLabels({ page, step, run } = {}, options = {}) {
  const action = async () => {
    const result = await measureLabels(page, options);
    const out = options.out ?? run?.dir;
    if (out) {
      const { writeMeasurement } = await import("./measurement.mjs");
      await writeMeasurement(out, "labels", { ...result, summary: labelsMarkdown(result) });
    }
    // A harness step records thrown failures; returning a failed measurement would mark it green.
    if (result.pass === false) {
      throw new Error(
        result.complete
          ? `Label geometry failed: ${result.counts.overlaps} overlapping pair(s); see labels.json`
          : `Label geometry incomplete: ${result.incompleteReason}`,
      );
    }
    return result;
  };
  return step ? step("measure diagram labels", action) : action();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { measurementCli } = await import("./measurement.mjs");
  await measurementCli({
    name: "labels",
    measure: async (page, options) => {
      if (options.surface?.startsWith("http")) {
        const path = new URL(options.surface).pathname;
        if (/\/projects\/[^/]+\/$/.test(path)) return measureLabelFixtures(page, { projectUrl: options.surface });
        if (path.endsWith(".mmd")) {
          await page.goto(options.surface);
          await waitForAddressedDiagramLabels(page, options.surface);
        }
      }
      const result = await measureLabels(page, options);
      return { ...result, summary: labelsMarkdown(result) };
    },
  });
}

export const meta = { name: "labels" };
export default runLabels;
