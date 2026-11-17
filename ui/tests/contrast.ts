// Colour measurement for the palette tests.
//
// The token comments in `src/styles.css` quote contrast ratios, and a quoted
// number nobody recomputes is a number that rots: the previous `--kbd-focus`
// comment claimed 7.8:1 for a value that measured 7.4:1. So the floors are
// asserted from the stylesheet with these functions instead of being trusted.
//
// Pure and dependency-free on purpose. Everything is sRGB in, numbers out.

export type Rgb = readonly [number, number, number];

export interface Colour {
  readonly rgb: Rgb;
  /** 0..1. A hex colour is opaque. */
  readonly alpha: number;
}

/** `#rrggbb`, or the `rgb(r g b / a%)` spelling the stylesheet uses. */
export function parseColour(value: string): Colour {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (hex !== null) {
    return { rgb: [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)], alpha: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)%\s*)?\)$/.exec(value.trim());
  if (rgb !== null) {
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
      alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) / 100,
    };
  }
  throw new Error(`not a colour this helper can measure: ${value}`);
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** What a translucent colour actually paints once it lands on its backdrop. */
export function compositeOver(top: Colour, backdrop: Rgb): Rgb {
  const mix = (i: 0 | 1 | 2) => top.rgb[i] * top.alpha + backdrop[i] * (1 - top.alpha);
  return [mix(0), mix(1), mix(2)];
}

/** WCAG 2.x contrast ratio, 1..21. Both colours must already be opaque. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

export type Vision = "normal" | "deuteranopia" | "protanopia";
export const VISIONS: readonly Vision[] = ["normal", "deuteranopia", "protanopia"];

// Machado, Oliveira & Fernandes (2009), severity 1.0 -- full dichromacy, the
// worst case. Applied to linear RGB.
const DICHROMAT: Readonly<Record<Exclude<Vision, "normal">, readonly Rgb[]>> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
};

/** The colour as that kind of vision receives it. */
export function simulate(rgb: Rgb, vision: Vision): Rgb {
  if (vision === "normal") return rgb;
  const linear = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const row = (m: Rgb) => fromLinear(m[0] * linear[0] + m[1] * linear[1] + m[2] * linear[2]);
  const matrix = DICHROMAT[vision];
  return [row(matrix[0]), row(matrix[1]), row(matrix[2])];
}

function toLab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * CIEDE2000 colour difference. Roughly: 1 is a just-noticeable difference
 * side by side, and two marks seen apart on a canvas want about 10 or more.
 */
export function deltaE(first: Rgb, second: Rgb): number {
  const [l1, a1, b1] = toLab(first);
  const [l2, a2, b2] = toLab(second);
  const rad = Math.PI / 180;
  const pow7 = (v: number) => v ** 7;
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(pow7(meanChroma) / (pow7(meanChroma) + pow7(25))));
  const a1p = a1 * (1 + g);
  const a2p = a2 * (1 + g);
  const c1 = Math.hypot(a1p, b1);
  const c2 = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const degrees = Math.atan2(b, a) / rad;
    return degrees < 0 ? degrees + 360 : degrees;
  };
  const h1 = hue(b1, a1p);
  const h2 = hue(b2, a2p);
  const dL = l2 - l1;
  const dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
  const meanL = (l1 + l2) / 2;
  const meanC = (c1 + c2) / 2;
  let meanH = h1 + h2;
  if (c1 * c2 !== 0) {
    meanH = Math.abs(h1 - h2) <= 180 ? meanH / 2 : (meanH + (meanH < 360 ? 360 : -360)) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((meanH - 30) * rad) +
    0.24 * Math.cos(2 * meanH * rad) +
    0.32 * Math.cos((3 * meanH + 6) * rad) -
    0.2 * Math.cos((4 * meanH - 63) * rad);
  const rotation = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(pow7(meanC) / (pow7(meanC) + pow7(25)));
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;
  const rt = -Math.sin(2 * rotation * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

/**
 * OKLCH lightness (0..1), chroma and hue (degrees) of an sRGB colour. Chroma
 * is how far a colour is from grey as the eye judges it, which a channel
 * spread is not: a warm grey and a mint grey can have the same spread.
 */
export function oklch(rgb: Rgb): readonly [number, number, number] {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [lightness, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}
