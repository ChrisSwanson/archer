type PainterModule = typeof import("@archer/export-painter");
let painterModule: Promise<PainterModule> | undefined;
/** Bundle/Vitest use the typed provider alias; tsx source commands load the same owned file. */
function loadPainter(): Promise<PainterModule> {
  if (painterModule) return painterModule;
  painterModule = (async () => {
    try {
      return await import("@archer/export-painter");
    } catch (error: unknown) {
      const missing = error as { code?: string; message?: string };
      if (
        !import.meta.url.endsWith("/ts/src/export/index.ts") ||
        missing.code !== "ERR_MODULE_NOT_FOUND" ||
        !missing.message?.includes("@archer/export-painter")
      )
        throw error;
      const ownedSource = new URL("../../../ui/src/export/painter.ts", import.meta.url).href;
      return (await import(ownedSource)) as PainterModule;
    }
  })().catch((error) => {
    painterModule = undefined;
    throw error;
  });
  return painterModule;
}
import type { ExportMode, ExportTheme, ExportPresentation } from "./contract.ts";
import { withPngNotice } from "./notice.ts";
import { FONT_FAMILY, type ExportResources } from "./resources.ts";
import { addressable, parseEmphasis } from "../service/emphasis.ts";
import type { Diagnostic } from "../mermaid/diagnostics.ts";
import type { DiagramEnvelope } from "../model/envelope.ts";
export { loadExportResources } from "./resources.ts";
export type { ExportResources } from "./resources.ts";
export type { ExportMode, ExportTheme, ExportPresentation } from "./contract.ts";
const xml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
/** Every face as an embedded `@font-face`, so an SVG opened anywhere draws in the face it was measured in. */
const fontFaceCss = (resources: ExportResources): string =>
  resources.fontFaces
    .map(
      (face) =>
        `@font-face{font-family:'${FONT_FAMILY}';font-style:${face.style};font-weight:${face.weight};src:url(data:font/woff2;base64,${Buffer.from(face.bytes).toString("base64")}) format('woff2')}`,
    )
    .join("");
/**
 * The letter-spacing every label was measured with, on every `text` in its own em. A rule, not an attribute on
 * the drawing's group: `letter-spacing` inherits as a length, so an em set there is the group's em, not the label's.
 */
const trackingCss = (painting: { readonly tracking: number }): string => `text{letter-spacing:${painting.tracking}em}`;
/** The regular face is what every label falls back to within the family: without it, nothing is drawn in Fira Sans. */
const hasRegularFace = (resources: Pick<ExportResources, "fontFaces"> | undefined): boolean =>
  resources?.fontFaces?.some((face) => face.weight === 400 && face.style === "normal" && face.bytes.length > 0) ===
  true;
/** The faces handed to resvg, which picks one by weight and slant within the family. */
const rasterFont = (resources: Pick<ExportResources, "fontFaces">) => ({
  fontBuffers: resources.fontFaces.map((face) => face.bytes),
  defaultFontFamily: FONT_FAMILY,
  sansSerifFamily: FONT_FAMILY,
});
export interface ExportResult {
  readonly mimeType: "image/svg+xml" | "image/png";
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly revision: string;
  readonly activeEmphasisId: string | null;
  readonly sourceRevision: string | null;
  readonly lastGood: boolean;
  readonly diagnostics: readonly Diagnostic[];
}
export class ExportRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExportRefusal";
  }
}
/** Resource limits apply before schema traversal, layout, or raster allocation. */
export const EXPORT_LIMITS = {
  depth: 48,
  values: 50000,
  stringLength: 100000,
  dimension: 16000,
  pixels: 32000000,
} as const;
/** Names the limits, this drawing's size and a scale that fits, so the next call can succeed. */
function extentMessage(width: number, height: number, scale: number): string {
  const limits = `Export drawing is ${width} × ${height} px; the limits are ${EXPORT_LIMITS.dimension.toLocaleString("en-US")} px a side and ${EXPORT_LIMITS.pixels / 1_000_000} million pixels in all.`;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return limits;
  const fit = Math.min(
    EXPORT_LIMITS.dimension / width,
    EXPORT_LIMITS.dimension / height,
    Math.sqrt(EXPORT_LIMITS.pixels / (width * height)),
  );
  const suggested = Number((scale * fit * 0.95).toPrecision(2));
  return `${limits} Pass a smaller \`scale\` (this drawing was exported at ${scale}; a scale of ${suggested} fits), or export a smaller diagram.`;
}
function boundedJson(input: unknown): void {
  const pending = [{ value: input, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > EXPORT_LIMITS.values || item.depth > EXPORT_LIMITS.depth)
      throw new ExportRefusal("export_input_limit", "Export input exceeds its bounded size or nesting limit.");
    if (
      typeof item.value === "string" &&
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        item.value,
      )
    )
      throw new ExportRefusal("export_invalid_input", "Export text must contain valid XML characters.");
    if (typeof item.value === "string" && item.value.length > EXPORT_LIMITS.stringLength)
      throw new ExportRefusal("export_input_limit", "Export text exceeds its length limit.");
    if (item.value !== null && typeof item.value === "object") {
      if (seen.has(item.value)) throw new ExportRefusal("export_invalid_input", "Export input must be acyclic JSON.");
      seen.add(item.value);
      const proto = Object.getPrototypeOf(item.value);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null)
        throw new ExportRefusal("export_invalid_input", "Export input must contain ordinary JSON values.");
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item.value))) {
        if (!("value" in descriptor))
          throw new ExportRefusal("export_invalid_input", "Export input must not contain getters.");
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else if (
      (typeof item.value === "number" && !Number.isFinite(item.value)) ||
      !["object", "string", "number", "boolean"].includes(typeof item.value)
    )
      throw new ExportRefusal("export_invalid_input", "Export input must contain JSON values.");
  }
}
/** Notices use the same bounded, XML-safe text in SVG, PNG metadata and visible captions. */
export function assertProjectNotice(notice: unknown): asserts notice is string {
  if (typeof notice !== "string") throw new ExportRefusal("export_notice_invalid", "The project notice must be text.");
  try {
    boundedJson(notice);
  } catch (error) {
    if (error instanceof ExportRefusal)
      throw new ExportRefusal("export_notice_invalid", `Cannot export the project notice: ${error.message}`);
    throw error;
  }
}
export interface ExportOptions {
  readonly format?: "svg" | "png";
  readonly mode?: ExportMode;
  readonly theme?: ExportTheme;
  readonly scale?: number;
  readonly presentation?: ExportPresentation;
  readonly resources: ExportResources;
  readonly source?: {
    readonly revision: string | null;
    readonly diagnostics: readonly Diagnostic[];
  };
  readonly allowLastGood?: boolean;
  /** Full project notice; adapters load the project root NOTICE.md. */
  readonly projectNotice?: string;
  /** Also draw the complete notice below the diagram, preserving embedded metadata. */
  readonly noticeCaption?: boolean;
}
function themeTokens(css: string, theme: ExportTheme): Record<string, string> {
  const selector = theme === "dark" ? ':root[data-theme="dark"]' : ':root[data-theme="light"]';
  const start = css.indexOf(selector),
    open = css.indexOf("{", start),
    end = css.indexOf("}", open);
  if (start < 0 || open < 0 || end < 0)
    throw new ExportRefusal("export_theme_invalid", "The packaged theme lacks explicit light/dark tokens.");
  const tokens: Record<string, string> = {};
  for (const match of css.slice(open + 1, end).matchAll(/--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g))
    tokens[match[1]!] = match[2]!
      .trim()
      .replace(
        /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%)?)?\s*\)$/,
        (_, r: string, g: string, b: string, a: string | undefined, percent: string | undefined) =>
          a === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${percent ? Number(a) / 100 : a})`,
      );
  return tokens;
}
function resolveColors(content: string, tokens: Record<string, string>): string {
  return content.replace(/var\(--([a-zA-Z0-9-]+)\)/g, (_, name: string) => {
    let value = tokens[name];
    // A token may name another (`--edge-arrow-ink: var(--edge-arrow)`); follow a few, never a cycle.
    for (let hops = 0; hops < 4 && value !== undefined; hops++) {
      const alias = /^var\(--([a-zA-Z0-9-]+)\)$/.exec(value);
      if (alias === null) break;
      value = tokens[alias[1]!];
    }
    if (value === undefined || !/^#[a-fA-F0-9]{3,8}$|^rgba?\([0-9 .,%/]+\)$/.test(value))
      throw new ExportRefusal("export_theme_invalid", `Theme color ${name} is missing or not a literal color.`);
    return value;
  });
}
let wasmReady: Promise<void> | undefined;
export async function exportDiagram(envelope: unknown, options: ExportOptions): Promise<ExportResult> {
  try {
    return await renderDiagram(envelope, options);
  } catch (error: unknown) {
    if (error instanceof ExportRefusal) throw error;
    throw new ExportRefusal(
      "export_failed",
      error instanceof Error ? error.message : "The drawing could not be rendered.",
    );
  }
}
/** Same bounded production painter for both vector and raster outputs. */
async function renderDiagram(envelope: unknown, options: ExportOptions): Promise<ExportResult> {
  if (
    !options ||
    typeof options !== "object" ||
    Object.values(Object.getOwnPropertyDescriptors(options)).some((d) => !("value" in d))
  )
    throw new ExportRefusal("export_options_invalid", "Export options must be ordinary values.");
  boundedJson(envelope);
  if (options.projectNotice !== undefined) assertProjectNotice(options.projectNotice);
  if (options.noticeCaption !== undefined && typeof options.noticeCaption !== "boolean")
    throw new ExportRefusal("export_options_invalid", "The notice caption option must be a boolean.");
  if (
    options.noticeCaption &&
    options.projectNotice !== undefined &&
    (options.projectNotice.length > 10000 ||
      /\S{257}/u.test(options.projectNotice) ||
      options.projectNotice.split(/\r?\n/).some((paragraph) => paragraph.length > 1024))
  )
    throw new ExportRefusal(
      "export_notice_caption_limit",
      "The visible notice caption is limited to 10000 characters, 1024 per paragraph and 256 per word. Wrap long paragraphs or words or export with the full embedded notice only.",
    );
  const mode = options.mode ?? "diagram",
    format = options.format ?? "svg",
    theme = options.theme ?? "dark",
    scale = options.scale ?? 1;
  if (
    !["diagram", "presentation"].includes(mode) ||
    !["svg", "png"].includes(format) ||
    !["dark", "light"].includes(theme) ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    scale > 4
  )
    throw new ExportRefusal(
      "export_options_invalid",
      "Choose SVG/PNG, diagram/presentation, light/dark, and a scale above zero and at most four.",
    );
  if (mode === "presentation" && options.presentation) {
    boundedJson(options.presentation);
    const requested = options.presentation.activeEmphasisId;
    if (
      requested !== undefined &&
      requested !== null &&
      (typeof requested !== "string" || !options.presentation.emphases?.some((e) => e.id === requested))
    )
      throw new ExportRefusal(
        "export_presentation_invalid",
        "The explicitly requested emphasis is not stored for this drawing.",
      );
  }
  const { paintExport } = await loadPainter();
  const painting = await paintExport({
    envelope,
    mode,
    ...(options.presentation ? { presentation: options.presentation } : {}),
    ...(options.noticeCaption && options.projectNotice !== undefined ? { noticeCaption: options.projectNotice } : {}),
  }).catch((error: unknown) => {
    throw new ExportRefusal(
      "export_invalid_envelope",
      error instanceof Error ? error.message : "Export drawing was refused.",
    );
  });
  if (options.source) boundedJson(options.source);
  const sourceRevision = options.source === undefined ? painting.revision : options.source.revision,
    diagnostics = options.source?.diagnostics ?? [];
  const lastGood = sourceRevision !== painting.revision || diagnostics.some((d) => d.severity === "error");
  if (lastGood && options.allowLastGood !== true)
    throw new ExportRefusal(
      "export_last_good_requires_opt_in",
      "The current source does not match a valid compiled drawing; explicitly choose the last-good revision to export it.",
    );
  const provenance = { sourceRevision, lastGood, diagnostics, activeEmphasisId: painting.activeEmphasisId };
  // Schema validation in the shared painter precedes this typed domain access.
  const model = envelope as DiagramEnvelope;
  if (mode === "presentation" && options.presentation?.emphases) {
    const known = addressable(model.model);
    for (const emphasis of options.presentation.emphases) {
      const parsed = parseEmphasis(emphasis, model.view.id, known, "stored");
      if (!parsed.ok)
        throw new ExportRefusal("export_presentation_invalid", parsed.issues.map((i) => i.problem).join("; "));
    }
  }
  const width = Math.ceil((painting.width + 40) * scale),
    height = Math.ceil((painting.height + 40) * scale);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > EXPORT_LIMITS.dimension ||
    height > EXPORT_LIMITS.dimension ||
    width * height > EXPORT_LIMITS.pixels
  )
    throw new ExportRefusal("export_extent_limit", extentMessage(width, height, scale));
  const resources = options.resources;
  if (!hasRegularFace(resources) || !resources?.themeCss || !resources.fontLicense)
    throw new ExportRefusal("export_resources_missing", "Export requires the packaged theme and Fira Sans font.");
  const tokens = themeTokens(resources.themeCss, theme);
  for (const name of ["bg", "node-bg", "node-border", "node-text"]) resolveColors(`var(--${name})`, tokens);
  const content = resolveColors(painting.content, tokens);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${painting.originX - 20} ${painting.originY - 20} ${painting.width + 40} ${painting.height + 40}" role="img"><title>${xml(painting.title)}</title>${painting.description ? `<desc>${xml(painting.description)}</desc>` : ""}${options.projectNotice === undefined ? "" : `<metadata id="archer-project-notice">${xml(options.projectNotice)}</metadata>`}<metadata id="fira-sans-font-license">${xml(resources.fontLicense)}</metadata><metadata id="archer-export-provenance">${xml(JSON.stringify({ revision: painting.revision, ...provenance }))}</metadata><style>${fontFaceCss(resources)}${trackingCss(painting)}.archer-er-mark{fill:none;stroke:${tokens["edge"]};stroke-width:1.5;stroke-linecap:round}.archer-er-ring{fill:${tokens["bg"]}}.archer-seq-actor-glyph{fill:none;stroke:${tokens["node-text"]}}</style><rect x="${painting.originX - 20}" y="${painting.originY - 20}" width="${painting.width + 40}" height="${painting.height + 40}" fill="${tokens["bg"]}"/><g fill="${tokens["node-bg"]}" stroke="${tokens["node-border"]}" color="${tokens["node-text"]}" font-family="${FONT_FAMILY}, sans-serif">${content}</g></svg>`;
  if (format === "svg")
    return {
      mimeType: "image/svg+xml",
      bytes: new TextEncoder().encode(svg),
      width,
      height,
      revision: painting.revision,
      ...provenance,
    };
  if (!resources.wasmBytes?.length)
    throw new ExportRefusal("export_resources_missing", "PNG export requires the packaged WASM renderer.");
  const { initWasm, Resvg } = await import("@resvg/resvg-wasm");
  wasmReady ??= initWasm(new Uint8Array(resources.wasmBytes).buffer).catch((error: unknown) => {
    wasmReady = undefined;
    throw error;
  });
  await wasmReady;
  // System fonts stay loaded for what the latin subset does not draw (CJK, emoji), as the page falls through to
  // them; every label the subset covers is drawn in Fira Sans, the family the drawing names.
  const renderer = new Resvg(svg, { font: rasterFont(resources) });
  try {
    const image = renderer.render();
    try {
      return {
        mimeType: "image/png",
        bytes:
          options.projectNotice === undefined
            ? new Uint8Array(image.asPng())
            : withPngNotice(image.asPng(), options.projectNotice),
        width: image.width,
        height: image.height,
        revision: painting.revision,
        ...provenance,
      };
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
/** A gallery thumbnail's intrinsic size never exceeds this box (16:9); it scales as a vector. */
export const THUMBNAIL_BOX = { width: 640, height: 360 } as const;
export interface ThumbnailResult {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly revision: string;
}
/**
 * The diagram-mode drawing as a small SVG for gallery cards: the same bounded
 * painter and theme colours as export, set in the same face and tracking, but
 * without the embedded faces, licence or provenance metadata (a thumbnail may
 * load nothing, `data:` URLs included). Its PNG (`rasterizeThumbnail`) is drawn
 * in the packaged faces; the SVG names Fira Sans, which a reader without it
 * draws in a fallback. The result passes `assertSafeThumbnail` or is refused.
 */
export async function exportThumbnail(
  envelope: unknown,
  options: { readonly theme: ExportTheme; readonly themeCss: string },
): Promise<ThumbnailResult> {
  try {
    boundedJson(envelope);
    if (options.theme !== "light" && options.theme !== "dark")
      throw new ExportRefusal("export_options_invalid", "Choose a light or dark thumbnail.");
    const { paintExport } = await loadPainter();
    const painting = await paintExport({ envelope, mode: "diagram" }).catch((error: unknown) => {
      throw new ExportRefusal(
        "export_invalid_envelope",
        error instanceof Error ? error.message : "Export drawing was refused.",
      );
    });
    const boxWidth = painting.width + 40,
      boxHeight = painting.height + 40;
    // A thumbnail is a vector scaled into THUMBNAIL_BOX, so a drawing larger than the export
    // raster limit is scaled down, not refused; the store's byte limit still bounds it.
    if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight) || boxWidth <= 0 || boxHeight <= 0)
      throw new ExportRefusal("export_extent_limit", "Export drawing has no extent.");
    const scale = Math.min(1, THUMBNAIL_BOX.width / boxWidth, THUMBNAIL_BOX.height / boxHeight);
    const width = Math.max(1, Math.floor(boxWidth * scale)),
      height = Math.max(1, Math.floor(boxHeight * scale));
    const tokens = themeTokens(options.themeCss, options.theme);
    for (const name of ["bg", "node-bg", "node-border", "node-text"]) resolveColors(`var(--${name})`, tokens);
    const content = resolveColors(painting.content, tokens);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${painting.originX - 20} ${painting.originY - 20} ${boxWidth} ${boxHeight}" role="img"><title>${xml(painting.title)}</title><style>${trackingCss(painting)}.archer-er-mark{fill:none;stroke:${tokens["edge"]};stroke-width:1.5;stroke-linecap:round}.archer-er-ring{fill:${tokens["bg"]}}.archer-seq-actor-glyph{fill:none;stroke:${tokens["node-text"]}}</style><rect x="${painting.originX - 20}" y="${painting.originY - 20}" width="${boxWidth}" height="${boxHeight}" fill="${tokens["bg"]}"/><g fill="${tokens["node-bg"]}" stroke="${tokens["node-border"]}" color="${tokens["node-text"]}" font-family="${FONT_FAMILY}, sans-serif">${content}</g></svg>`;
    assertSafeThumbnail(svg);
    return { bytes: new TextEncoder().encode(svg), width, height, revision: painting.revision };
  } catch (error: unknown) {
    if (error instanceof ExportRefusal) throw error;
    throw new ExportRefusal(
      "export_failed",
      error instanceof Error ? error.message : "The drawing could not be rendered.",
    );
  }
}
/**
 * A raster thumbnail is contained in this box: twice the largest gallery card's image area
 * (a 1fr track of at most ~2x250px, 16:9, less its padding), so a card stays sharp at 2x
 * device pixels. Changing it changes the drawing: bump the store's drawing version.
 */
export const THUMBNAIL_PNG_BOX = { width: 640, height: 360 } as const;
/**
 * A thumbnail SVG (from `exportThumbnail`) as a PNG contained in THUMBNAIL_PNG_BOX, drawn by the
 * same bounded WASM renderer as PNG export with the packaged Fira Sans. The SVG is checked again
 * first; the result is opaque (the thumbnail paints its own background).
 */
export async function rasterizeThumbnail(
  thumb: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
  resources: Pick<ExportResources, "fontFaces" | "wasmBytes">,
): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
  try {
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(thumb.bytes);
    assertSafeThumbnail(svg);
    if (!resources.wasmBytes?.length || !hasRegularFace(resources))
      throw new ExportRefusal(
        "export_resources_missing",
        "PNG thumbnails require the packaged WASM renderer and Fira Sans font.",
      );
    if (!(thumb.width > 0) || !(thumb.height > 0))
      throw new ExportRefusal("export_extent_limit", "Export drawing has no extent.");
    // Fitted on the side that binds, so the other side rounds within the box.
    const fitTo =
      THUMBNAIL_PNG_BOX.width / thumb.width <= THUMBNAIL_PNG_BOX.height / thumb.height
        ? { mode: "width" as const, value: THUMBNAIL_PNG_BOX.width }
        : { mode: "height" as const, value: THUMBNAIL_PNG_BOX.height };
    const { initWasm, Resvg } = await import("@resvg/resvg-wasm");
    wasmReady ??= initWasm(new Uint8Array(resources.wasmBytes).buffer).catch((error: unknown) => {
      wasmReady = undefined;
      throw error;
    });
    await wasmReady;
    const renderer = new Resvg(svg, {
      fitTo,
      font: { ...rasterFont(resources), loadSystemFonts: false },
    });
    try {
      const image = renderer.render();
      try {
        if (image.width > THUMBNAIL_PNG_BOX.width || image.height > THUMBNAIL_PNG_BOX.height)
          throw new ExportRefusal("export_extent_limit", "The PNG thumbnail does not fit its box.");
        return { bytes: new Uint8Array(image.asPng()), width: image.width, height: image.height };
      } finally {
        image.free();
      }
    } finally {
      renderer.free();
    }
  } catch (error: unknown) {
    if (error instanceof ExportRefusal) throw error;
    throw new ExportRefusal(
      "export_failed",
      error instanceof Error ? error.message : "The thumbnail could not be rasterized.",
    );
  }
}
/**
 * Defence in depth for SVG served to browsers: no script, event handler,
 * foreign content, embedded image, link or reference outside the document.
 * The painter escapes every label, so a refusal here is a painter defect.
 *
 * It reads the markup, not the label text (C-14): each tag's element name (a
 * prefix such as `svg:script` is refused, as is any `xmlns:` declaration and
 * any default `xmlns` but SVG's, so a name cannot be renamed past the list or
 * moved into XHTML), each attribute's name (found with or
 * without whitespace before it) and value (entities decoded), and the text of
 * `<style>` elements. Other text is inert, so an escaped label that spells
 * `src=x` or `url(…)` is allowed.
 */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export function assertSafeThumbnail(svg: string): void {
  const refuse = (what: string): never => {
    throw new ExportRefusal("export_unsafe_svg", `The thumbnail contains ${what}.`);
  };
  if (!svg.startsWith("<svg ") || !svg.endsWith("</svg>")) refuse("something other than one SVG element");
  const css = (text: string): void => {
    if (/url\(\s*(?!["']?#)/i.test(text)) refuse("a reference outside the document");
    if (/@import|javascript:/i.test(text)) refuse("an import or script URL");
  };
  let at = 0,
    inStyle = false;
  while (at < svg.length) {
    const open = svg.indexOf("<", at);
    const text = svg.slice(at, open === -1 ? svg.length : open);
    if (inStyle) css(decodeEntities(text));
    if (open === -1) break;
    const close = tagEnd(svg, open + 1);
    if (close === -1) refuse("an unclosed tag");
    const tag = svg.slice(open + 1, close);
    at = close + 1;
    if (/^[!?]/.test(tag)) refuse("a comment, CDATA section, declaration or processing instruction");
    const name = /^\/?([^\s/>]*)/.exec(tag)![1]!;
    if (name.includes(":")) refuse("a prefixed element");
    if (!/^[A-Za-z][\w.-]*$/.test(name)) refuse("a malformed tag");
    if (
      /^(?:script|foreignObject|iframe|object|embed|image|a|use|animate|animateMotion|animateTransform|set|feImage|handler|listener|discard)$/i.test(
        name,
      )
    )
      refuse("an element that can run, link or load");
    if (tag.startsWith("/")) {
      inStyle = false;
      continue;
    }
    inStyle = name.toLowerCase() === "style" && !tag.endsWith("/");
    // After the name: `name`, `name=value`, `name="value"` or `name='value'`, with or without whitespace between.
    const attributes = /([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    const rest = tag.slice(1 + name.length);
    for (const match of rest.matchAll(attributes)) {
      const attribute = match[1]!,
        value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
      if (/^on/i.test(attribute)) refuse("an event handler");
      if (/^xmlns:/i.test(attribute)) refuse("a namespace declaration");
      // C-28: a default namespace other than SVG's (XHTML, empty, a near spelling) moves the element
      // and its children out of SVG, where `<meta http-equiv>` and friends act.
      if (/^xmlns$/i.test(attribute) && value !== SVG_NAMESPACE) refuse("a default namespace other than SVG");
      if (/(?:^|:)href$|^src$/i.test(attribute)) refuse("a link attribute");
      css(value);
    }
  }
}
/** The `>` that ends the tag starting at `from`, outside quoted values (`title=">"` does not end it); -1 if none. */
function tagEnd(svg: string, from: number): number {
  let quote = "";
  for (let i = from; i < svg.length; i++) {
    const c = svg[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}
/** XML's character references and five named entities, decoded once (enough to see `&#106;avascript:`). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Math.min(parseInt(lower.slice(2), 16), 0x10ffff));
    if (lower.startsWith("#")) return String.fromCodePoint(Math.min(Number(lower.slice(1)), 0x10ffff));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[lower]!;
  });
}
