// Pixels as painted: a screenshot decoded here, and the contrast measures the round 1 state and focus
// checks share (`round1-f26.e2e.ts`, `round1-f29.e2e.ts`). Contrast is read from the composited page
// because a computed colour cannot say what a fill-only state or a faded ring looks like on its ground.
import { inflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";

export type Rgb = readonly [number, number, number];
export type Pixels = { readonly w: number; readonly h: number; get(x: number, y: number): Rgb };
export function decodePng(buf: Buffer): Pixels {
  let p = 8,
    w = 0,
    h = 0,
    ct = 0;
  const chunks: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p),
      type = buf.toString("ascii", p + 4, p + 8),
      data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[9]!;
    } else if (type === "IDAT") chunks.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    bpp = ct === 6 ? 4 : 3,
    stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!,
      line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
      cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0,
        b = prev[x]!,
        c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c,
          pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return {
    w,
    h,
    get: (x, y) => {
      const i = y * stride + x * bpp;
      return [out[i]!, out[i + 1]!, out[i + 2]!];
    },
  };
}
export const lin = (c: number): number => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const lum = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const ratio = (a: Rgb, b: Rgb): number => {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
export function mode(pixels: readonly Rgb[]): Rgb {
  const m = new Map<string, number>();
  for (const px of pixels) m.set(px.join(), (m.get(px.join()) ?? 0) + 1);
  return [...m]
    .sort((a, b) => b[1] - a[1])[0]![0]
    .split(",")
    .map(Number) as unknown as Rgb;
}
/** The pointer out of the way: not on the rail (its hover opens it over the page) nor on a control. */
export async function park(page: Page): Promise<void> {
  const v = page.viewportSize()!;
  await page.mouse.move(Math.round(v.width * 0.55), v.height - 3);
}
export async function grab(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Pixels> {
  const c = {
    x: Math.max(0, Math.floor(clip.x)),
    y: Math.max(0, Math.floor(clip.y)),
    width: Math.ceil(clip.width),
    height: Math.ceil(clip.height),
  };
  return decodePng(await page.screenshot({ clip: c, animations: "disabled", caret: "hide" }));
}

/**
 * A pressed/selected control's state cue (WCAG 1.4.11): the best contrast its edge band reaches against BOTH
 * what lies outside it and its own fill, on the weakest of its four sides. A cue drawn by `--accent-fill`
 * alone has an edge the colour of its fill, so it scores the fill's 1.2–1.4:1 against the panel.
 */
export async function stateCue(page: Page, control: Locator): Promise<number> {
  await control.scrollIntoViewIfNeeded();
  await park(page);
  const b = (await control.boundingBox())!;
  const m = 5;
  const img = await grab(page, { x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m });
  const x0 = b.x - Math.floor(b.x - m),
    y0 = b.y - Math.floor(b.y - m);
  const cx = Math.round(x0 + b.width / 2),
    cy = Math.round(y0 + b.height / 2);
  const inner: Rgb[] = [];
  for (let y = Math.round(y0 + 4); y < Math.round(y0 + b.height - 4); y++)
    for (let x = Math.round(x0 + 4); x < Math.round(x0 + 8); x++) inner.push(img.get(x, y));
  const fill = mode(inner);
  // Each side: a profile from 4 px outside to 3 px inside the edge, at the side's middle.
  const sides: ((d: number) => Rgb)[] = [
    (d) => img.get(Math.round(x0) + d, cy),
    (d) => img.get(Math.round(x0 + b.width) - 1 - d, cy),
    (d) => img.get(cx, Math.round(y0) + d),
    (d) => img.get(cx, Math.round(y0 + b.height) - 1 - d),
  ];
  return Math.min(
    ...sides.map((at) => {
      const outside = at(-4);
      let best = 0;
      for (let d = -1; d <= 3; d++) best = Math.max(best, Math.min(ratio(at(d), outside), ratio(at(d), fill)));
      return best;
    }),
  );
}
