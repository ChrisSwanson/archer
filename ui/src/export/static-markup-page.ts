import { Fragment, type ReactElement, type ReactNode } from "react";

/**
 * `renderToStaticMarkup` for a page build (`pageBuildAliases` in vite.config.ts), so React's server renderer (about
 * 88 KB raw, 22 KB gzip) is not in the page; the service, in Node, keeps it. The export painter draws only small
 * glyph components through it: plain functions of their props (no hooks, no context) returning SVG elements and
 * fragments. This walks such a tree and writes what React's server renderer writes for it: the attribute names it
 * aliases, a style object as `name:value;…`, escaped text and values, and no element self-closed (SVG has no void
 * elements). `static-markup-page.test.tsx` holds it byte for byte to the server renderer over every fixture and
 * glyph. Anything else (a class component, a hook, a context) is refused rather than drawn wrongly.
 */
export function renderToStaticMarkup(element: ReactElement): string {
  return node(element);
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** React's own aliases: these names are written hyphenated (or renamed); every other attribute is written as given. */
const HYPHENATED = new Set([
  "accentHeight",
  "alignmentBaseline",
  "arabicForm",
  "baselineShift",
  "capHeight",
  "clipPath",
  "clipRule",
  "colorInterpolation",
  "colorInterpolationFilters",
  "colorProfile",
  "colorRendering",
  "dominantBaseline",
  "enableBackground",
  "fillOpacity",
  "fillRule",
  "floodColor",
  "floodOpacity",
  "fontFamily",
  "fontSize",
  "fontSizeAdjust",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "glyphName",
  "glyphOrientationHorizontal",
  "glyphOrientationVertical",
  "horizAdvX",
  "horizOriginX",
  "imageRendering",
  "letterSpacing",
  "lightingColor",
  "markerEnd",
  "markerMid",
  "markerStart",
  "overlinePosition",
  "overlineThickness",
  "paintOrder",
  "pointerEvents",
  "renderingIntent",
  "shapeRendering",
  "stopColor",
  "stopOpacity",
  "strikethroughPosition",
  "strikethroughThickness",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "textAnchor",
  "textDecoration",
  "textRendering",
  "transformOrigin",
  "underlinePosition",
  "underlineThickness",
  "unicodeBidi",
  "unicodeRange",
  "unitsPerEm",
  "vAlphabetic",
  "vHanging",
  "vIdeographic",
  "vMathematical",
  "vectorEffect",
  "vertAdvY",
  "vertOriginX",
  "vertOriginY",
  "wordSpacing",
  "writingMode",
  "xHeight",
]);
const RENAMED: Readonly<Record<string, string>> = {
  className: "class",
  htmlFor: "for",
  panose1: "panose-1",
  xlinkActuate: "xlink:actuate",
  xlinkArcrole: "xlink:arcrole",
  xlinkHref: "xlink:href",
  xlinkRole: "xlink:role",
  xlinkShow: "xlink:show",
  xlinkTitle: "xlink:title",
  xlinkType: "xlink:type",
  xmlBase: "xml:base",
  xmlLang: "xml:lang",
  xmlSpace: "xml:space",
};
const hyphenate = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const attributeName = (name: string): string => RENAMED[name] ?? (HYPHENATED.has(name) ? hyphenate(name) : name);

/** Style properties React writes without a unit (its `isUnitlessNumber`, the ones an SVG glyph can carry). */
const UNITLESS = new Set([
  "opacity",
  "fillOpacity",
  "floodOpacity",
  "stopOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "fontWeight",
  "lineHeight",
  "zIndex",
  "zoom",
  "order",
  "flex",
  "flexGrow",
  "flexShrink",
  "orphans",
  "widows",
  "tabSize",
  "scale",
  "aspectRatio",
]);
function style(value: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || typeof raw === "boolean" || raw === "") continue;
    const custom = name.startsWith("--");
    const text =
      typeof raw === "number" && raw !== 0 && !custom && !UNITLESS.has(name) ? `${raw}px` : String(raw).trim();
    parts.push(`${custom ? name : hyphenate(name).replace(/^ms-/, "-ms-")}:${text}`);
  }
  return parts.join(";");
}

function attributes(props: Readonly<Record<string, unknown>>): string {
  let out = "";
  for (const [name, value] of Object.entries(props)) {
    if (
      name === "children" ||
      name === "key" ||
      name === "ref" ||
      value === null ||
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol"
    )
      continue;
    if (
      name === "dangerouslySetInnerHTML" ||
      name === "suppressHydrationWarning" ||
      name === "suppressContentEditableWarning"
    )
      throw new Error(`static markup: ${name} is not drawn here`);
    if (name === "style") {
      const written = style(value as Record<string, unknown>);
      if (written !== "") out += ` style="${escapeHtml(written)}"`;
      continue;
    }
    // React writes a boolean only on aria-* and data-* attributes (as "true"/"false"); elsewhere it drops it.
    if (typeof value === "boolean" && !name.startsWith("aria-") && !name.startsWith("data-")) continue;
    out += ` ${attributeName(name)}="${escapeHtml(String(value))}"`;
  }
  return out;
}

function node(value: ReactNode): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number" || typeof value === "bigint") return escapeHtml(String(value));
  if (Array.isArray(value)) return value.map(node).join("");
  if (typeof value !== "object" || !("type" in value)) throw new Error("static markup: unsupported child");
  const { type, props } = value as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (type === Fragment) return node(props.children);
  if (typeof type === "function") {
    if ((type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent)
      throw new Error("static markup: class components are not drawn here");
    return node((type as (p: unknown) => ReactNode)(props));
  }
  if (typeof type !== "string") throw new Error("static markup: unsupported element type");
  return `<${type}${attributes(props)}>${node(props.children)}</${type}>`;
}
