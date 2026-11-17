#!/usr/bin/env node
// G5: flat computed-colour samples. Ratios use full precision; rounding is presentation only.
// Harness: await runContrast({page,step,run}); standalone: --url <access link> --out <dir>.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { measurementCli, writeMeasurement } from "./measurement.mjs";
import { DIAGRAM_LABEL_CONTENT, waitForDiagramLabels } from "./labels.mjs";
import { readBrowserRoute } from "../../../shared/browser-routes.mts";

export function contrastRatio(a, b) {
  const luminance = (c) =>
    c
      .slice(0, 3)
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function parseColour(value) {
  if (!value || value === "none" || value === "transparent") return [0, 0, 0, 0];
  let m = value.match(/^rgba?\((.*)\)$/);
  if (m) {
    const parts = m[1].replaceAll(",", " ").replace("/", " ").trim().split(/\s+/);
    return [
      ...parts.slice(0, 3).map((v) => parseFloat(v) * (v.endsWith("%") ? 2.55 : 1)),
      parts[3] ? parseFloat(parts[3]) / (parts[3].endsWith("%") ? 100 : 1) : 1,
    ];
  }
  m = value.match(/^color\(srgb\s+([^)]*)\)$/);
  if (m) {
    const p = m[1].replace("/", " ").trim().split(/\s+/).map(Number);
    return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
  }
  throw new Error(`unsupported computed colour: ${value}`);
}
export function composite(fg, bg) {
  const alpha = fg[3] + bg[3] * (1 - fg[3]);
  return alpha
    ? [...fg.slice(0, 3).map((v, i) => (v * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha), alpha]
    : [0, 0, 0, 0];
}
function flatten(fg, layers) {
  let pixel = fg;
  for (const layer of layers) {
    const background = parseColour(layer.background);
    background[3] *= layer.backgroundOpacity ?? 1;
    pixel = composite(pixel, background);
    pixel[3] *= layer.opacity;
  }
  return composite(pixel, [255, 255, 255, 1]);
}
// Explicit G5 pair inventory: token states supplement the current route's actual rendered samples.
export const TOKEN_PAIRS = [
  ...["--surface", "--surface-2", "--panel"].flatMap((background) =>
    ["--text", "--text-dim", "--text-faint"].map((foreground) => ({ foreground, background, kind: "text" })),
  ),
  { foreground: "--node-text", background: "--node-bg", kind: "text" },
  { foreground: "--plate-text", background: "--plate", kind: "text" },
  { foreground: "--group-text", background: "--group-bg", kind: "text" },
  { foreground: "--group-caption", background: "--group-bg", kind: "text" },
  { foreground: "--fragment-text", background: "--fragment-bg", kind: "text" },
  { foreground: "--banner-danger-text", background: "--banner-danger-bg", kind: "text" },
  { foreground: "--danger-text", background: "--danger-bg", kind: "text" },
  { foreground: "--accent-on-fill", background: "--accent-fill", kind: "text", state: "selection" },
  { foreground: "--agent-text", background: "--agent-fill", kind: "text", state: "agent" },
  { foreground: "--agent-ink", background: "--agent", kind: "text", state: "agent" },
  { foreground: "--text-faded", background: "--surface", kind: "text", state: "off-path" },
  { foreground: "--node-text", background: "--node-bg-faded", kind: "text", state: "off-path" },
  ...[
    "--node-border",
    "--node-border-faded",
    "--group-border",
    "--fragment-border",
    "--edge",
    "--edge-arrow",
    "--accent",
    "--kbd-focus",
    "--walked",
    "--g1",
    "--g2",
    "--g3",
    "--g4",
  ].map((foreground) => ({ foreground, background: "--surface", kind: "cue" })),
  ...["--node-border", "--kbd-focus", "--g1", "--g2", "--g3", "--g4"].map((foreground) => ({
    foreground,
    background: "--node-bg",
    kind: "cue",
  })),
  ...["--g1", "--g2", "--g3", "--g4"].map((foreground) => ({
    foreground,
    background: "--surface",
    kind: "cue",
    paintOpacityToken: "--flow-line-opacity",
    state: "flow",
  })),
];
/** Use the product's route grammar, query destinations included. */
function diagramLocation(url) {
  const route = readBrowserRoute(url.pathname, url.search, url.hash);
  const view =
    route?.kind === "view"
      ? route.viewId
      : route?.kind === "follow"
        ? url.searchParams.get("view")
        : route?.kind === "file" && route.fragment !== undefined
          ? `${route.path}#${route.fragment}`
          : null;
  // Credentials and legacy spelling are transport context; the project-qualified destination is identity.
  const destination =
    view !== null
      ? `${route.projectSlug}/view:${view}`
      : route?.kind === "file"
        ? `${route.projectSlug}/file:${route.path}`
        : `${url.pathname}${url.hash}`;
  return {
    // A Markdown fragment may name a heading. Embedded content is required only when a canvas is present.
    expected: /\.mmd$/.test(url.pathname) || route?.kind === "view" || (route?.kind === "follow" && view !== null),
    identity: `${url.origin}/${destination}`,
  };
}

export async function measureContrast(
  page,
  { tokens = true, selector = "body", surface, readinessTimeout = 10000 } = {},
) {
  // The single-fixture CLI uses this path too. Chrome and token pairs never stand in for diagram coverage.
  const expectedUrl = surface ?? page.url();
  const expectedLocation = (() => {
    try {
      return new URL(expectedUrl);
    } catch {
      return null;
    }
  })();
  const requested = diagramLocation(expectedLocation ?? new URL(page.url()));
  const expectedDiagram =
    requested.expected || (await page.locator(`${DIAGRAM_LABEL_CONTENT}, .react-flow, .archer-seq-canvas`).count()) > 0;
  const readiness = [];
  if (expectedDiagram) {
    if (surface && expectedLocation && requested.identity !== diagramLocation(new URL(page.url())).identity) {
      readiness.push({ selector: "diagram", reason: "Expected fixture route differs from the rendered route." });
    } else {
      try {
        await waitForDiagramLabels(page, { timeout: readinessTimeout });
      } catch {
        readiness.push({ selector: "diagram", reason: "No rendered diagram labels before readiness deadline." });
      }
    }
  }
  const raw = await page.evaluate(
    ({ selector, inventory, labelContent }) => {
      const pairs = [],
        incomplete = [];
      const ident = (el) =>
        el.id
          ? `#${el.id}`
          : `${el.tagName.toLowerCase()}${el.getAttribute("class") ? "." + el.getAttribute("class").trim().replace(/\s+/g, ".") : ""}`;
      const visible = (el) => {
        const s = getComputedStyle(el),
          r = el.getBoundingClientRect();
        for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (
            Number(style.opacity) === 0 ||
            /inset\(50%\)/.test(style.clipPath) ||
            style.clip === "rect(0px, 0px, 0px, 0px)"
          )
            return false;
        }
        return (
          s.display !== "none" &&
          s.visibility === "visible" &&
          Number(s.opacity) > 0 &&
          (r.width > 0 || r.height > 0) &&
          r.bottom >= 0 &&
          r.right >= 0 &&
          r.left < innerWidth &&
          r.top < innerHeight &&
          !el.closest("defs,marker,clipPath,script,style")
        );
      };
      const layers = (el, exterior = false) => {
        const list = [];
        const rect = el.getBoundingClientRect(),
          point = new DOMPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        let branch = null;
        for (let node = el; node; branch = node, node = node.parentElement) {
          const s = getComputedStyle(node);
          if (s.backgroundImage !== "none" || s.filter !== "none" || s.mixBlendMode !== "normal")
            incomplete.push({
              selector: ident(el),
              reason: `non-flat backdrop at ${ident(node)} (image/filter/blend)`,
            });
          // SVG paints plates as earlier siblings, unlike an HTML background. Include the shapes
          // actually covering the sample point, back to front within their group's opacity layer.
          if (branch && node instanceof SVGElement) {
            const behind = [...node.children].filter(
              (candidate) =>
                candidate instanceof SVGGeometryElement &&
                candidate.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
            for (const plate of behind.reverse()) {
              const style = getComputedStyle(plate),
                matrix = plate.getScreenCTM();
              if (
                !matrix ||
                style.fill === "none" ||
                style.visibility !== "visible" ||
                style.display === "none" ||
                !plate.isPointInFill(point.matrixTransform(matrix.inverse()))
              )
                continue;
              list.push({
                background: style.fill,
                backgroundOpacity: Number(style.fillOpacity) * Number(style.opacity),
                opacity: 1,
              });
            }
          }
          list.push({
            background: node === el && exterior ? "transparent" : s.backgroundColor,
            opacity: Number(s.opacity),
          });
        }
        return list;
      };
      const add = (el, kind, colour, extra = {}) => {
        const s = getComputedStyle(el),
          size = parseFloat(s.fontSize),
          weight = parseInt(s.fontWeight) || 400;
        const matrix = el instanceof SVGGraphicsElement ? el.getScreenCTM() : null;
        const scale = matrix
          ? Math.hypot(matrix.c, matrix.d)
          : el.offsetHeight
            ? el.getBoundingClientRect().height / el.offsetHeight
            : 1;
        const renderedPx = size * scale;
        const backdrop = layers(el);
        let filledShape = false;
        if (kind === "stroke" && s.fill !== "none" && el instanceof SVGGeometryElement) {
          const r = el.getBoundingClientRect(),
            m = el.getScreenCTM();
          if (m && el.isPointInFill(new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(m.inverse()))) {
            backdrop.unshift({ background: s.fill, backgroundOpacity: Number(s.fillOpacity), opacity: 1 });
            filledShape = true;
          }
        }
        pairs.push({
          selector: ident(el),
          element: el.outerHTML.slice(0, 400),
          control: el.closest("button,input,[role=button]")?.getAttribute("aria-label") ?? null,
          kind,
          colour,
          layers: backdrop,
          fontSizePx: renderedPx,
          fontWeight: weight,
          threshold: kind === "text" ? (renderedPx >= 24 || (renderedPx >= 56 / 3 && weight >= 700) ? 3 : 4.5) : 3,
          state:
            el
              .closest('[class*="emph"], [class*="focus"], [class*="off-path"], [style*="opacity"]')
              ?.getAttribute("class") ?? "default",
          ...extra,
        });
        if (filledShape) pairs.push({ ...pairs.at(-1), adjacent: "outside", layers: layers(el, true) });
      };
      const root = document.querySelector(selector);
      for (const el of root ? [root, ...root.querySelectorAll("*")] : []) {
        if (!visible(el)) continue;
        const s = getComputedStyle(el),
          svg = el instanceof SVGElement;
        const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (text && (!svg || el.matches("text,tspan")))
          add(el, "text", svg ? s.fill : s.color, {
            paintOpacity: svg ? Number(s.fillOpacity) : 1,
            diagramLabel: !!el.closest(labelContent),
          });
        if (svg && !el.matches("svg,g,text,tspan,foreignObject")) {
          if (s.stroke !== "none" && Number(s.strokeOpacity) > 0 && parseFloat(s.strokeWidth) > 0)
            add(el, "stroke", s.stroke, { paintOpacity: Number(s.strokeOpacity) });
          // A bordered shape's interior is a surface; its stroke carries the boundary cue.
          // Filled glyphs without a stroke carry their meaning through the fill itself.
          const outlined = s.stroke !== "none" && Number(s.strokeOpacity) > 0 && parseFloat(s.strokeWidth) > 0;
          if (
            (!outlined || el.getAttribute("data-contrast-cue") === "fill") &&
            (el.closest("button,[role=button],.archer-stage,.archer-mcp-stage,.archer-canvas") ||
              el.hasAttribute("data-contrast-cue")) &&
            s.fill !== "none" &&
            Number(s.fillOpacity) > 0
          )
            add(el, "fill", s.fill, { paintOpacity: Number(s.fillOpacity) });
        }
        if (el.matches("button,input,select,textarea,[role=button],.archer-node,[data-contrast-cue]")) {
          for (const side of ["Top", "Right", "Bottom", "Left"]) {
            if (parseFloat(s[`border${side}Width`]) && !["none", "hidden"].includes(s[`border${side}Style`])) {
              add(el, "border", s[`border${side}Color`], { side: side.toLowerCase(), paintOpacity: 1 });
              const row = pairs.at(-1);
              pairs.push({ ...row, adjacent: "outside", layers: layers(el, true) });
            }
          }
          if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth))
            add(el, "focus-ring", s.outlineColor, { paintOpacity: 1, adjacent: "outside", layers: layers(el, true) });
        }
      }
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;left:-10000px;pointer-events:none";
      document.body.append(probe);
      try {
        for (const pair of inventory) {
          probe.style.color = `var(${pair.foreground})`;
          probe.style.backgroundColor = `var(${pair.background})`;
          probe.style.opacity = pair.paintOpacityToken
            ? `var(${pair.paintOpacityToken})`
            : String(pair.paintOpacity ?? 1);
          const root = getComputedStyle(document.documentElement);
          if (
            [pair.foreground, pair.background, pair.paintOpacityToken]
              .filter(Boolean)
              .some((token) => !root.getPropertyValue(token).trim())
          ) {
            incomplete.push({ selector: pair.foreground, reason: "token missing" });
            continue;
          }
          const s = getComputedStyle(probe);
          const canvas = document.createElement("span");
          canvas.style.backgroundColor = "var(--surface)";
          probe.append(canvas);
          pairs.push({
            ...pair,
            selector: `${pair.foreground} on ${pair.background}${pair.state ? ` (${pair.state})` : ""}`,
            kind: `token-${pair.kind}`,
            colour: s.color,
            layers: [
              { background: s.backgroundColor, opacity: 1 },
              { background: getComputedStyle(canvas).backgroundColor, opacity: 1 },
            ],
            paintOpacity: Number(s.opacity),
            threshold: pair.kind === "text" ? 4.5 : 3,
          });
          canvas.remove();
        }
      } finally {
        probe.remove();
      }
      return { pairs, incomplete, url: location.href, theme: document.documentElement.dataset.theme ?? "system" };
    },
    { selector, inventory: tokens ? TOKEN_PAIRS : [], labelContent: DIAGRAM_LABEL_CONTENT },
  );
  const incomplete = [...readiness, ...raw.incomplete];
  if (
    expectedDiagram &&
    expectedLocation &&
    requested.identity !== diagramLocation(new URL(raw.url)).identity &&
    !readiness.length
  )
    incomplete.push({ selector: "diagram", reason: "Expected fixture route changed while awaiting diagram labels." });
  const pairs = raw.pairs.flatMap((row) => {
    try {
      const fg = parseColour(row.colour);
      fg[3] *= row.paintOpacity ?? 1;
      if (fg[3] === 0) return [];
      const foreground = flatten(fg, row.layers),
        background = flatten([0, 0, 0, 0], row.layers),
        ratio = contrastRatio(foreground, background);
      return [{ ...row, foreground, background, ratio, pass: ratio >= row.threshold }];
    } catch (error) {
      incomplete.push({ selector: row.selector, reason: error.message });
      return [];
    }
  });
  const diagramLabels = pairs.filter((p) => p.kind === "text" && p.diagramLabel).length;
  if (expectedDiagram && !diagramLabels && !readiness.length)
    incomplete.push({ selector: "diagram", reason: "No rendered diagram labels were sampled." });
  const failures = pairs.filter((p) => !p.pass);
  const counts = {
    pairs: pairs.length,
    failures: failures.length,
    text: pairs.filter((p) => p.kind === "text").length,
    diagramLabels,
    svg: pairs.filter((p) => ["stroke", "fill"].includes(p.kind)).length,
    tokenPairs: pairs.filter((p) => p.kind.startsWith("token-")).length,
    incomplete: incomplete.length,
  };
  const result = {
    surface: surface ?? raw.url,
    url: raw.url,
    theme: raw.theme,
    status: incomplete.length || !pairs.length ? "incomplete" : failures.length ? "fail" : "pass",
    pass: !incomplete.length && pairs.length > 0 && !failures.length,
    counts,
    pairs,
    incomplete,
    limits: [
      "Computed flat colours; images, gradients, filters and blend modes require manual pixel review.",
      "SVG plate sampling uses covering earlier sibling shapes at the sample centre. Arbitrary overlapping scene layers require manual review.",
      "Only visible current-route states are sampled; inventory token states supplement, but do not replace, family/theme/state journeys.",
    ],
  };
  result.summary = contrastMarkdown(result);
  return result;
}
export function contrastMarkdown(r) {
  return `# Contrast (G5)\n\n${r.status.toUpperCase()}: ${r.counts.failures}/${r.counts.pairs} pairs below threshold; ${r.counts.incomplete} require review. ${r.counts.diagramLabels ?? 0} rendered diagram-label pairs.\n\n${r.url}\n\n| Pair / sample | Kind | Ratio | Required | Result |\n|---|---|---:|---:|---|\n${r.pairs.map((p) => `| ${p.selector.replaceAll("|", "\\|")} | ${p.kind} | ${p.ratio.toFixed(4)} | ${p.threshold} | ${p.pass ? "PASS" : "FAIL"} |`).join("\n")}\n\nRatios compare unrounded values. Large text: 24 CSS px, or 18⅔ CSS px at weight ≥700. Opacity includes the element, ancestors and paint alpha.\n\n${r.limits.join("\n\n")}\n`;
}

/** Same seven family fixtures as the label tool; reuses its explicit fit and settled geometry. */
export async function measureContrastFixtures(page, { projectUrl, fixtures, themes = ["light", "dark"] } = {}) {
  const { FAMILY_FIXTURES, measureLabels } = await import("./labels.mjs");
  const results = [];
  for (const theme of themes)
    for (const { family, fixture } of fixtures ?? FAMILY_FIXTURES) {
      const url = new URL(`diagrams/${fixture}`, projectUrl).href;
      try {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(url);
        await page
          .locator(".react-flow__node,.archer-seq-viewport,.archer-journey")
          .first()
          .waitFor({ state: "visible" });
        await page.locator("html").evaluate((el, theme) => (el.dataset.theme = theme), theme);
        const geometry = await measureLabels(page);
        if (!geometry.complete) throw new Error("No rendered diagram labels");
        results.push({ ...(await measureContrast(page, { surface: url })), family, fixture, theme });
      } catch (error) {
        results.push({
          family,
          fixture,
          theme,
          url,
          status: "incomplete",
          pass: false,
          error: error.message,
          counts: { pairs: 0, failures: 0, text: 0, svg: 0, tokenPairs: 0, incomplete: 1 },
        });
      }
    }
  const counts = results.reduce(
    (s, r) => {
      for (const [key, value] of Object.entries(r.counts)) s[key] = (s[key] ?? 0) + value;
      return s;
    },
    { surfaces: results.length },
  );
  const status = results.some((r) => r.status === "incomplete")
    ? "incomplete"
    : results.some((r) => !r.pass)
      ? "fail"
      : "pass";
  return {
    status,
    pass: status === "pass",
    projectUrl,
    counts,
    results,
    summary: `# Contrast per family\n\n${status.toUpperCase()}: ${counts.failures}/${counts.pairs} pairs below threshold across ${counts.surfaces} family/theme samples.\n\n| Family | Theme | Pairs | Below threshold | Status |\n|---|---|---:|---:|---|\n${results.map((r) => `| ${r.family} | ${r.theme} | ${r.counts.pairs} | ${r.counts.failures} | ${r.status} |`).join("\n")}\n\nRaw JSON preserves every full-precision ratio and composite layer.\n`,
  };
}

export async function runContrast({ page, step, run }, options = {}) {
  let result;
  const action = async () => {
    result = await measureContrast(page, options);
    writeMeasurement(options.out ?? run.dir, "contrast", result);
    if (!result.pass)
      throw new Error(
        `contrast ${result.status}: ${result.counts.failures} failures; ${result.counts.incomplete} incomplete samples`,
      );
  };
  if (step) await step("contrast (G5)", action);
  else await action();
  return result;
}
export const meta = { name: "contrast" };
export default runContrast;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await measurementCli({
    name: "contrast",
    measure: async (page, options) => {
      if (options.surface?.startsWith("http") && /\/projects\/[^/]+\/$/.test(new URL(options.surface).pathname))
        return measureContrastFixtures(page, { projectUrl: options.surface });
      return measureContrast(page, options);
    },
  });
