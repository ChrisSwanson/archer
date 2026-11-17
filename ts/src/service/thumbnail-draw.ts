// One gallery thumbnail drawing, the same in a worker thread (thumbnail-worker.ts) and in
// process (ThumbnailPainters' fallback): the SVG and a PNG of the same SVG (export's
// rasterizeThumbnail). A PNG that cannot be drawn does not cost the SVG: it is answered by its
// refusal. The brotli and gzip copies are made once by the store, in the service's own thread
// (`compressThumbnail`), never in a painter: a painter worker is terminated mid-drawing when the
// service stops or a drawing runs too long, and a termination that lands between a zlib handle's
// creation and its init aborts the whole process (Node's "close before init" CHECK at the
// worker's cleanup; known failure O32).
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { exportThumbnail, rasterizeThumbnail, type ExportTheme } from "../export/index.ts";
import type { ExportFontFace } from "../export/resources.ts";

export interface ThumbnailRasterResources {
  /** The packaged Fira Sans faces; a label whose weight has no face here is drawn in the nearest that has. */
  readonly fontFaces: readonly ExportFontFace[];
  readonly wasmBytes: Uint8Array;
}

export interface ThumbnailDrawing {
  readonly svg: Uint8Array;
  /** A painter's own compressed copies; the painters here leave them to the store (`compressThumbnail`). */
  readonly br?: Uint8Array;
  readonly gzip?: Uint8Array;
  /** null: no PNG; `pngError` says why. */
  readonly png?: Uint8Array | null;
  readonly pngError?: string;
  /** Painter time per part, for measurement. */
  readonly ms?: { readonly svg: number; readonly png: number };
}

/** Quality 10 is within 2% of 11 on thumbnails at a third of its time (findings: ~8 ms vs ~27 ms each). */
const BROTLI = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 10, [zlibConstants.BROTLI_PARAM_LGWIN]: 18 },
} as const;
const brotliAsync = promisify(brotliCompress),
  gzipAsync = promisify(gzip);

/** The SVG's brotli and gzip copies, compressed off the event loop (zlib's thread pool). */
export async function compressThumbnail(svg: Uint8Array): Promise<{ readonly br: Buffer; readonly gzip: Buffer }> {
  const [br, gz] = await Promise.all([
    brotliAsync(svg, { params: { ...BROTLI.params, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: svg.length } }),
    gzipAsync(svg, { level: 9 }),
  ]);
  return { br, gzip: gz };
}

export async function drawThumbnail(
  envelope: unknown,
  theme: ExportTheme,
  themeCss: string,
  raster: ThumbnailRasterResources | null,
): Promise<ThumbnailDrawing> {
  let started = performance.now();
  const thumb = await exportThumbnail(envelope, { theme, themeCss });
  const svgMs = performance.now() - started;
  started = performance.now();
  let png: Uint8Array | null = null,
    pngError: string | undefined;
  if (raster === null) pngError = "This painter has no raster renderer.";
  else {
    try {
      png = (await rasterizeThumbnail(thumb, raster)).bytes;
    } catch (failure) {
      pngError = failure instanceof Error ? failure.message : "The PNG thumbnail could not be drawn.";
    }
  }
  const ms = { svg: svgMs, png: performance.now() - started };
  return { svg: thumb.bytes, png, ...(pngError === undefined ? {} : { pngError }), ms };
}
