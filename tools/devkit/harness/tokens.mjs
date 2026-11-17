#!/usr/bin/env node
/** R1 V1/V3 token census; all counts are COMPARED metrics, never a baseline ratchet.
 *
 * Static scope: every .css file recursively under ui/src, sorted, no TSX/JS/inline styles.
 * Unit: one declaration occurrence (not numeric lexemes, selectors, lines or rendered elements).
 * Comments and custom-property definitions are excluded. A mixed declaration counts once in each
 * applicable column. Duplicate declarations and media-query copies count separately.
 * fontSize: font-size declarations. iconSize: width/height/min-/max-/inline-/block-size declarations
 * whose selector explicitly names svg, an *-icon/*-glyph class, .icon or .glyph (not button targets).
 * spacing: padding/margin and their physical/logical longhands, gap/row-gap/column-gap.
 * raw: numeric dimension/percentage or unitless number in the value, including var() fallbacks and
 * calc() operands, with var names removed; spacing's zero operands do not count. Token references:
 * fontSize var(--type-*), iconSize var(--icon|--icon-inline|--icon-indicator), spacing any var(--*).
 * Other units/keywords/inheritance and font shorthand are outside these published counts.
 *
 * Runtime scope: visible, nonempty direct text runs (HTML and SVG) plus input/textarea text.
 * Sizes are computed CSS font-size px, before diagram transforms; effective rendered px are also
 * recorded per run. Hidden/offscreen runs do not count. Distinct means exact numeric CSS values,
 * no rounding/binning. Monospace sizes are labelled separately, not silently exempted.
 *
 * Standalone: node tools/devkit/harness/tokens.mjs --url '<access-link>' --out /tmp/r1-tokens
 * Harness: import {runTokens} from './tokens.mjs'; await runTokens({page,step,run});
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COUNTING_DEFINITIONS = {
  metricPolicy: "compared",
  scope:
    "ui/src/**/*.css; declaration occurrences; excludes comments and custom-property definitions; no TSX/JS/inline styles",
  fontSize: "font-size; raw numeric operands vs var(--type-*); mixed values count in both columns",
  iconSize:
    "dimension declarations on selectors explicitly naming svg, .icon/.glyph or *-icon/*-glyph; raw operands vs var(--icon|--icon-inline|--icon-indicator)",
  spacing:
    "padding/margin physical and logical properties plus gap/row-gap/column-gap; nonzero raw operands vs any var(--*)",
  runtime:
    "visible direct text runs plus input/textarea text; distinct computed CSS font-size px before transforms; effective rendered px recorded separately; exact numbers, no rounding",
};
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../ui/src");
const emptyCounts = () => ({
  fontSize: { raw: 0, tokens: 0 },
  iconSize: { raw: 0, tokens: 0 },
  spacing: { raw: 0, tokens: 0 },
});
const blankComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const ICON_SELECTOR = /(?:^|[\s,>+~])svg(?=[\s,.#:[>+~]|$)|(?:\.(?:[\w-]+[-_])?(?:icon|glyph)(?=[\s:.#,[>+~]|$))/i;
const DIMENSION = /^(?:(?:min|max)-)?(?:width|height|inline-size|block-size)$/;
const SPACING =
  /^(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$|^(?:gap|row-gap|column-gap)$/;

/** Minimal CSS declaration tokenizer: strings, escapes and function punctuation are opaque.
 * Handles nested media/supports and modern nested rules; values are not interpreted as CSS rules. */
function* declarations(css) {
  const clean = blankComments(css),
    stack = [],
    lineStarts = [0];
  for (let i = 0; i < clean.length; i++) if (clean[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (index) => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let start = 0,
    quote = "",
    parens = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") {
      parens++;
      continue;
    }
    if (c === ")" || c === "]") {
      parens--;
      continue;
    }
    if (parens) continue;
    if (c === "{") {
      stack.push(clean.slice(start, i).trim());
      start = i + 1;
      continue;
    }
    if (c === ";" || c === "}") {
      const part = clean.slice(start, i),
        match = /^\s*([\w-]+)\s*:\s*([\s\S]*)$/.exec(part);
      if (match && stack.length) {
        const at = start + part.indexOf(match[1]);
        yield {
          selector: stack.filter((s) => !s.startsWith("@")).join(" "),
          property: match[1].toLowerCase(),
          value: match[2].trim(),
          line: lineAt(at),
        };
      }
      if (c === "}") stack.pop();
      start = i + 1;
    }
  }
}
export function auditCss(css, { file = "<stylesheet>" } = {}) {
  const counts = emptyCounts(),
    rows = [];
  for (const decl of declarations(css)) {
    const { property, value, selector } = decl;
    if (property.startsWith("--")) continue;
    const category =
      property === "font-size"
        ? "fontSize"
        : SPACING.test(property)
          ? "spacing"
          : DIMENSION.test(property) && ICON_SELECTOR.test(selector)
            ? "iconSize"
            : null;
    if (!category) continue;
    const numeric =
      value.replace(/var\(\s*--[\w-]+/g, "var(").match(/(?<![\w-])[-+]?(?:\d*\.\d+|\d+)(?:[a-z%]+)?(?![\w-])/gi) ?? [];
    const raw = numeric.some((n) => category !== "spacing" || parseFloat(n) !== 0);
    const tokens = (
      category === "fontSize"
        ? /var\(\s*--type-[\w-]+/
        : category === "iconSize"
          ? /var\(\s*--icon(?:-inline|-indicator)?\s*[,)]/
          : /var\(\s*--[\w-]+/
    ).test(value);
    if (raw) counts[category].raw++;
    if (tokens) counts[category].tokens++;
    rows.push({ file, ...decl, category, raw, tokens });
  }
  return { ok: Object.values(counts).every((c) => c.raw === 0), metricPolicy: "compared", counts, declarations: rows };
}
export function staticCensus(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".css")) files.push(p);
    }
  };
  walk(resolve(root));
  const counts = emptyCounts(),
    rows = [];
  for (const file of files) {
    const result = auditCss(readFileSync(file, "utf8"), { file: relative(resolve(root), file) });
    rows.push(...result.declarations);
    for (const category of Object.keys(counts)) {
      counts[category].raw += result.counts[category].raw;
      counts[category].tokens += result.counts[category].tokens;
    }
  }
  return {
    ok: Object.values(counts).every((c) => c.raw === 0),
    metricPolicy: "compared",
    root: resolve(root),
    files: files.length,
    definitions: COUNTING_DEFINITIONS,
    counts,
    declarations: rows,
  };
}
/** The type ramp's tokens (ui/src/styles.css :root), chrome and the notes' reading scale; a size on any is on scale. */
export const TYPE_TOKENS = Object.freeze([
  "--type-floor",
  "--type-small",
  "--type-body",
  "--type-title",
  "--type-display",
  "--type-reading",
  "--type-reading-heading",
  "--type-reading-title",
  "--type-canvas-frame",
  "--type-canvas-participant",
  "--type-canvas-journey",
]);
export async function measureTokens(page, { surface } = {}) {
  const result = await page.evaluate(
    (TYPE_NAMES) => {
      const rootStyle = getComputedStyle(document.documentElement),
        tokenNames = TYPE_NAMES;
      const tokenSizes = {};
      for (const name of tokenNames) {
        if (!rootStyle.getPropertyValue(name).trim()) continue;
        const probe = document.createElement("span");
        probe.style.fontSize = `var(${name})`;
        probe.style.position = "fixed";
        probe.style.visibility = "hidden";
        document.body.append(probe);
        tokenSizes[name] = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
      }
      const runs = [];
      function visible(el, rect) {
        if (
          !rect ||
          rect.width <= 1 ||
          rect.height <= 1 ||
          rect.right <= 0 ||
          rect.bottom <= 0 ||
          rect.left >= innerWidth ||
          rect.top >= innerHeight
        )
          return false;
        let left = rect.left,
          right = rect.right,
          top = rect.top,
          bottom = rect.bottom;
        for (let p = el; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (
            cs.display === "none" ||
            cs.visibility === "hidden" ||
            cs.visibility === "collapse" ||
            Number(cs.opacity) === 0 ||
            p.hidden
          )
            return false;
          if (cs.clip !== "auto") {
            const nums = cs.clip.match(/-?[0-9.]+/g)?.map(Number);
            if (nums?.length === 4 && (nums[1] <= nums[3] || nums[2] <= nums[0])) return false;
          }
          if (/inset\(50%\)/.test(cs.clipPath)) return false;
          const bounds = p.getBoundingClientRect();
          if (/hidden|clip|scroll|auto/.test(cs.overflowX)) {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
          if (/hidden|clip|scroll|auto/.test(cs.overflowY)) {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
          if (right - left <= 1 || bottom - top <= 1) return false;
        }
        return true;
      }
      const seen = new Set();
      const collect = (el, text, rect) => {
        if (!text.trim() || seen.has(el) || !visible(el, rect) || el.closest("script,style,head,noscript,template"))
          return;
        seen.add(el);
        const cs = getComputedStyle(el),
          fontSizePx = parseFloat(cs.fontSize);
        let scale = 1;
        if (el instanceof SVGGraphicsElement) {
          const ctm = el.getScreenCTM();
          if (ctm) scale = Math.hypot(ctm.c, ctm.d);
        } else
          for (let p = el; p; p = p.parentElement) {
            const transform = getComputedStyle(p).transform;
            if (transform && transform !== "none") {
              const m = new DOMMatrixReadOnly(transform);
              scale *= Math.hypot(m.c, m.d);
            }
          }
        runs.push({
          tag: el.localName,
          selector: el.id
            ? `#${el.id}`
            : `${el.localName}${[...el.classList]
                .slice(0, 3)
                .map((c) => "." + c)
                .join("")}`,
          text: text.trim().slice(0, 120),
          fontSizePx,
          renderedFontSizePx: fontSizePx * scale,
          fontFamily: cs.fontFamily,
          monospace: /monospace|\bmono\b/i.test(cs.fontFamily),
          tokenSized: Object.values(tokenSizes).includes(fontSizePx),
        });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode,
          el = node.parentElement;
        if (!el || !node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        collect(el, node.textContent, range.getBoundingClientRect());
      }
      for (const el of document.querySelectorAll("input,textarea"))
        collect(el, el.value || el.placeholder, el.getBoundingClientRect());
      const sizes = [...new Set(runs.map((r) => r.fontSizePx))].sort((a, b) => a - b),
        renderedSizes = [...new Set(runs.map((r) => r.renderedFontSizePx))].sort((a, b) => a - b);
      return {
        sizes,
        renderedSizes,
        tokenSizes,
        runs,
        offScale: runs.filter((r) => !r.tokenSized),
        monospaceSizes: [...new Set(runs.filter((r) => r.monospace).map((r) => r.fontSizePx))].sort((a, b) => a - b),
      };
    },
    [...TYPE_TOKENS],
  );
  return {
    ok: true,
    status: "measured",
    metricPolicy: "compared",
    surface: surface ?? page.url(),
    ...result,
    counts: {
      distinctFontSizes: result.sizes.length,
      visibleTextElements: result.runs.length,
      outsideTypeTokens: result.offScale.length,
    },
    summary: `Computed-style font census: ${result.sizes.length} distinct CSS sizes (${result.sizes.join(", ")} px); ${result.runs.length} visible text elements; ${result.offScale.length} outside the type tokens. Compared metrics; no ratchet or inferred score.`,
  };
}
export async function measureTokenCensus(page, options = {}) {
  const runtime = await measureTokens(page, options),
    statics = staticCensus(options.root);
  return {
    ...runtime,
    counts: { ...statics.counts, ...runtime.counts },
    static: statics,
    definitions: COUNTING_DEFINITIONS,
    summary: `${runtime.summary}\n\nStatic declaration counts (raw / tokens): font-size ${statics.counts.fontSize.raw} / ${statics.counts.fontSize.tokens}; icon-size ${statics.counts.iconSize.raw} / ${statics.counts.iconSize.tokens}; spacing ${statics.counts.spacing.raw} / ${statics.counts.spacing.tokens}; ${statics.files} CSS files. All are compared metrics.\n\nCounting definitions:\n${Object.entries(
      COUNTING_DEFINITIONS,
    )
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n")}`,
  };
}
export async function runTokens(ctx, options = {}) {
  const { writeMeasurement } = await import("./measurement.mjs");
  let result;
  const action = async () => {
    result = await measureTokenCensus(ctx.page, options);
    writeMeasurement(options.out ?? ctx.run.dir, "tokens", result);
    return result;
  };
  return ctx.step ? ctx.step("token census", action) : action();
}
export const meta = { name: "token-census" };
export default runTokens;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { measurementCli } = await import("./measurement.mjs");
  await measurementCli({ name: "tokens", measure: measureTokenCensus });
}
